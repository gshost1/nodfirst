#!/usr/bin/env node
/**
 * Hooks from public job boards.
 *
 * Reads a CSV of companies (an Apollo export works as-is), finds each
 * company's public job board on Greenhouse, Lever or Ashby, and writes one
 * factual hook line per company from its open US roles, with the board URL it
 * came from. Only public, unauthenticated board APIs are called.
 *
 *   node outreach/hooks.mjs companies.csv hooks.csv [--leads leads.csv]
 *
 * Input columns (case-insensitive): company, domain or website, and optionally
 * first_name and email. --leads also writes the sender's Leads format (email,
 * first_name, company, hook) for rows that have an email.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([abbr, name]) => [name.toLowerCase(), abbr]));
const US_COUNTRY = /^(us|usa|united states( of america)?)$/i;
const US_TEXT = /\b(united states|usa|u\.s\.|remote[\s,(-]+us)\b/i;
// HR-function titles only: "Software Engineer, Onboarding" or "PM, Benefits" build product, they don't run HR.
const PEOPLE_ROLE = /\b(head of people|chief people|vp,? people|people (operations|ops|partner|manager|director|lead|generalist|coordinator|specialist|business partner)|hr( |$|,)|hrbp|human resources|(benefits|payroll) (manager|specialist|administrator|coordinator|lead))/i;
const IT_ROLE = /(\bIT\b|information technology|help ?desk|systems administrator|sysadmin|workplace)/;
const BUILDER_ROLE = /\b(engineer|developer|product|designer|scientist|program manager|architect)\b/i;
const RECENT_DAYS = 21;

export const BOARDS = {
  greenhouse: {
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    page: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    jobs: (body) => (body?.jobs || []).map((job) => ({
      title: job.title,
      locations: [job.location?.name].filter(Boolean),
      country: null,
      publishedAt: job.first_published || job.updated_at || null,
    })),
  },
  lever: {
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    page: (slug) => `https://jobs.lever.co/${slug}`,
    jobs: (body) => (Array.isArray(body) ? body : []).map((job) => ({
      title: job.text,
      locations: job.categories?.allLocations?.length ? job.categories.allLocations : [job.categories?.location].filter(Boolean),
      country: job.country || null,
      publishedAt: job.createdAt || null,
    })),
  },
  ashby: {
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    page: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    jobs: (body) => (body?.jobs || []).filter((job) => job.isListed !== false).map((job) => ({
      title: job.title,
      locations: [job.location, ...(job.secondaryLocations || []).map((l) => l.location)].filter(Boolean),
      country: job.address?.postalAddress?.addressCountry || null,
      publishedAt: job.publishedAt || null,
    })),
  },
};

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  const [header = [], ...body] = rows;
  const keys = header.map((h) => h.replace(/^﻿/, '').trim());
  return body.map((values) => Object.fromEntries(keys.map((k, i) => [k, (values[i] ?? '').trim()])));
}

export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

/** Reads a column by any of its common names (Apollo uses "Company", "Website", "First Name"). */
export function pick(row, ...names) {
  const wanted = names.map((n) => n.toLowerCase().replace(/[\s_]+/g, ''));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(key.toLowerCase().replace(/[\s_]+/g, '')) && value) return value;
  }
  return '';
}

export function slugCandidates(company, domain) {
  const host = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  const root = host.split('.')[0] || '';
  const name = String(company || '').toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(inc|llc|ltd|corp|co|corporation|company|technologies|labs|hq)\b\.?/g, '')
    .trim();
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set([root, words.join(''), words.join('-'), words[0]].filter((s) => s && s.length > 1))];
}

export function usState(location) {
  const text = String(location || '');
  const abbr = text.match(/,\s*([A-Z]{2})\b/);
  if (abbr && STATES[abbr[1]]) return abbr[1];
  const lower = text.toLowerCase();
  const name = Object.keys(STATE_BY_NAME).find((n) => new RegExp(`\\b${n}\\b`).test(lower));
  return name ? STATE_BY_NAME[name] : null;
}

export function isUsJob(job) {
  if (job.country && US_COUNTRY.test(job.country.trim())) return true;
  return job.locations.some((l) => usState(l) || US_TEXT.test(l));
}

const clean = (title) => String(title || '').replace(/\s+/g, ' ').trim();
// Acronyms go by the letter's sound: "an HR Generalist", "an SRE", "a UX Designer".
const article = (title) => (/^[A-Z]{2,}\b/.test(title) ? (/^[AEFHILMNORSX]/.test(title) ? 'an' : 'a') : (/^[aeiou]/i.test(title) ? 'an' : 'a'));

/**
 * One factual line from the company's open US roles, or '' when there is
 * nothing worth saying. Role hooks come first because they are the most
 * specific; counts are the fallback.
 */
export function makeHook(jobs, now = new Date()) {
  const us = jobs.filter(isUsJob).map((job) => ({ ...job, title: clean(job.title) })).filter((job) => job.title);
  if (!us.length) return '';
  const recent = (job) => job.publishedAt && (now - new Date(job.publishedAt)) / 86_400_000 <= RECENT_DAYS;

  const people = us.find((job) => PEOPLE_ROLE.test(job.title) && !BUILDER_ROLE.test(job.title));
  if (people) return `Noticed you're hiring ${article(people.title)} ${people.title}.`;
  const it = us.find((job) => IT_ROLE.test(job.title) && !BUILDER_ROLE.test(job.title));
  if (it) return recent(it) ? `Noticed you just opened ${article(it.title)} ${it.title} role.` : `Noticed you're hiring ${article(it.title)} ${it.title}.`;

  const states = new Set(us.flatMap((job) => job.locations.map(usState)).filter(Boolean));
  if (us.length >= 3 && states.size >= 3) return `Saw you're hiring ${us.length} roles across ${states.size} states.`;
  if (us.length >= 2) return `Saw you have ${us.length} open roles on your careers page.`;
  return `Saw the ${us[0].title} opening on your careers page.`;
}

async function fetchJson(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** First board with at least one listed job wins; an empty board counts as not found. */
export async function findBoard(company, domain, fetchImpl = fetch) {
  for (const slug of slugCandidates(company, domain)) {
    for (const [ats, board] of Object.entries(BOARDS)) {
      const jobs = board.jobs(await fetchJson(board.url(slug), fetchImpl));
      if (jobs.length) return { ats, slug, jobs, source: board.page(slug) };
    }
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function hookRows(rows, { fetchImpl = fetch, now = new Date(), concurrency = 4, log = () => {} } = {}) {
  return mapLimit(rows, concurrency, async (row) => {
    const company = pick(row, 'company', 'company name', 'organization name', 'account name');
    const domain = pick(row, 'domain', 'website', 'company website', 'company domain');
    const board = company || domain ? await findBoard(company, domain, fetchImpl) : null;
    const usRoles = board ? board.jobs.filter(isUsJob) : [];
    const hook = board ? makeHook(board.jobs, now) : '';
    log(`${company || domain}: ${board ? `${board.ats} ${usRoles.length} US roles` : 'no public board'}${hook ? '' : ', no hook'}`);
    return {
      ...row,
      hook,
      hook_source: hook ? board.source : '',
      ats: board?.ats || '',
      us_roles: board ? usRoles.length : '',
      us_states: board ? new Set(usRoles.flatMap((j) => j.locations.map(usState)).filter(Boolean)).size : '',
    };
  });
}

export function leadsRows(rows) {
  return rows
    .map((row) => ({
      email: pick(row, 'email', 'work email'),
      first_name: pick(row, 'first_name', 'first name'),
      company: pick(row, 'company', 'company name', 'organization name', 'account name'),
      hook: row.hook || '',
    }))
    .filter((row) => row.email);
}

async function main(argv) {
  const [input, output, flag, leadsPath] = argv;
  if (!input || !output || (flag && (flag !== '--leads' || !leadsPath))) {
    console.error('usage: node outreach/hooks.mjs companies.csv hooks.csv [--leads leads.csv]');
    process.exit(2);
  }
  const rows = parseCsv(await readFile(input, 'utf8'));
  const result = await hookRows(rows, { log: (line) => console.error(line) });
  const columns = [...new Set([...Object.keys(rows[0] || {}), 'hook', 'hook_source', 'ats', 'us_roles', 'us_states'])];
  await writeFile(output, toCsv(result, columns));
  const found = result.filter((r) => r.hook).length;
  console.error(`\n${found}/${result.length} companies have a hook → ${output}`);
  if (leadsPath) {
    const leads = leadsRows(result);
    await writeFile(leadsPath, toCsv(leads, ['email', 'first_name', 'company', 'hook']));
    console.error(`${leads.length} rows with an email → ${leadsPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main(process.argv.slice(2));

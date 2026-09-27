import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBoard, hookRows, isUsJob, leadsRows, makeHook, parseCsv, slugCandidates, toCsv, usState } from '../outreach/hooks.mjs';

const NOW = new Date('2026-09-27T12:00:00Z');
const job = (title, locations, extra = {}) => ({ title, locations, country: null, publishedAt: null, ...extra });

test('slug candidates come from the domain and the company name', () => {
  assert.deepEqual(slugCandidates('Acme Robotics, Inc.', 'https://www.acmebots.com/about'), ['acmebots', 'acmerobotics', 'acme-robotics', 'acme']);
  assert.deepEqual(slugCandidates('', 'plaid.com'), ['plaid']);
});

test('US detection handles state codes, state names, remote-US and country fields', () => {
  assert.equal(usState('Scottsdale, AZ - Hybrid'), 'AZ');
  assert.equal(usState('Remote - Texas'), 'TX');
  assert.equal(usState('London, UK'), null);
  assert.ok(isUsJob(job('x', ['Remote (US)'])));
  assert.ok(isUsJob(job('x', ['Anywhere'], { country: 'USA' })));
  assert.ok(!isUsJob(job('x', ['Toronto, ON'])));
  assert.ok(!isUsJob(job('x', ['Berlin, Germany'])));
});

test('a People or HR role is the preferred hook', () => {
  const hook = makeHook([job('Software Engineer', ['Austin, TX']), job('  HR   Generalist ', ['Denver, CO'])], NOW);
  assert.equal(hook, "Noticed you're hiring an HR Generalist.");
  assert.equal(makeHook([job('People Operations Manager', ['Remote (US)'])], NOW), "Noticed you're hiring a People Operations Manager.");
});

test('product roles that mention HR words are not People roles', () => {
  const jobs = [job('Software Engineer, Onboarding', ['Austin, TX']), job('AI Operations Program Manager, Benefits', ['Austin, TX'])];
  assert.equal(makeHook(jobs, NOW), 'Saw you have 2 open roles on your careers page.');
  assert.equal(makeHook([job('IT Infrastructure Engineer', ['Austin, TX'])], NOW), 'Saw the IT Infrastructure Engineer opening on your careers page.');
});

test('an IT role says "just opened" only when it is recent', () => {
  assert.equal(makeHook([job('IT Manager', ['Boston, MA'], { publishedAt: '2026-09-20' })], NOW), 'Noticed you just opened an IT Manager role.');
  assert.equal(makeHook([job('IT Manager', ['Boston, MA'], { publishedAt: '2026-06-01' })], NOW), "Noticed you're hiring an IT Manager.");
  assert.equal(makeHook([job('Head of Security', ['Boston, MA'])], NOW), 'Saw the Head of Security opening on your careers page.');
});

test('count hooks only count US roles and name states only when there are three', () => {
  const spread = [job('A', ['Austin, TX']), job('B', ['Denver, CO']), job('C', ['New York, NY']), job('D', ['London, UK'])];
  assert.equal(makeHook(spread, NOW), "Saw you're hiring 3 roles across 3 states.");
  assert.equal(makeHook([job('A', ['Austin, TX']), job('B', ['Austin, TX']), job('C', ['Austin, TX'])], NOW), 'Saw you have 3 open roles on your careers page.');
  assert.equal(makeHook([job('Designer', ['Remote (US)'])], NOW), 'Saw the Designer opening on your careers page.');
  assert.equal(makeHook([job('Designer', ['Paris, France'])], NOW), '');
});

test('CSV round-trips quotes, commas, newlines and a BOM', () => {
  const rows = parseCsv('﻿Company,Note\r\n"Acme, Inc.","said ""hi""\nthere"\r\n\r\nBeta,ok\n');
  assert.deepEqual(rows, [{ Company: 'Acme, Inc.', Note: 'said "hi"\nthere' }, { Company: 'Beta', Note: 'ok' }]);
  assert.deepEqual(parseCsv(toCsv(rows, ['Company', 'Note'])), rows);
});

test('boards are tried in order and an empty board does not count', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('greenhouse') && url.includes('/acme/')) return { ok: true, json: async () => ({ jobs: [] }) };
    if (url.includes('lever') && url.includes('/acme?')) return { ok: true, json: async () => [{ text: 'People Ops Manager', categories: { location: 'Austin, TX' }, country: 'US' }] };
    return { ok: false, json: async () => ({}) };
  };
  const board = await findBoard('Acme', 'acme.com', fetchImpl);
  assert.equal(board.ats, 'lever');
  assert.equal(board.source, 'https://jobs.lever.co/acme');
  assert.equal(calls.length, 2);
});

test('Apollo-style rows get a hook, a source, and a Leads row', async () => {
  const fetchImpl = async (url) => (url.includes('ashbyhq') && url.endsWith('/beta')
    ? { ok: true, json: async () => ({ jobs: [{ title: 'Head of People', location: 'Remote', isListed: true, address: { postalAddress: { addressCountry: 'United States' } } }] }) }
    : { ok: false, json: async () => null });
  const rows = [
    { 'First Name': 'Dana', Email: 'dana@beta.com', Company: 'Beta', Website: 'beta.com' },
    { 'First Name': 'Lee', Email: '', Company: 'Gamma', Website: 'gamma.io' },
  ];
  const out = await hookRows(rows, { fetchImpl, now: NOW });
  assert.equal(out[0].hook, "Noticed you're hiring a Head of People.");
  assert.equal(out[0].hook_source, 'https://jobs.ashbyhq.com/beta');
  assert.equal(out[1].hook, '');
  assert.deepEqual(leadsRows(out), [{ email: 'dana@beta.com', first_name: 'Dana', company: 'Beta', hook: "Noticed you're hiring a Head of People." }]);
});

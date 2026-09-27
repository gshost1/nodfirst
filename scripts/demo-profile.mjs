// Creates a fictional hire (plus four hires whose requests are real SAP dataset
// tickets), then drives each one through the actual HTTP API of a real server
// process: onboarding, checklist, agent decision, admin approval or rejection,
// and the audit trail. Uses whichever provider NODFIRST_PROVIDER selects.
//
//   npm run demo:profile                     # temporary database
//   NODFIRST_DB=.data/demo.sqlite npm run demo:profile   # keep it to open in the UI
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const keepDb = process.env.NODFIRST_DB;
const directory = keepDb ? null : await mkdtemp(join(tmpdir(), 'nodfirst-profile-'));
const dbPath = keepDb || join(directory, 'profile.sqlite');

const profile = {
  name: 'Rowan Adeyemi-Park',
  role: 'Senior Account Executive',
  location: 'Austin, TX',
  startDate: '2026-10-19',
  manager: 'Dana Whitfield',
  workMode: 'remote',
  exception: 'My offer letter includes a $1,500 home office stipend, but I already bought a standing desk in September. Can payroll reimburse that purchase, and does the stipend come on my first paycheck?',
};

const dataset = JSON.parse(await readFile(join(root, 'data/eval/sap-hr-survey.json'), 'utf8')).examples;
const pick = (category, index = 0) => dataset.filter(example => example.sourceCategory === category)[index];
const fromDataset = [
  ['Mira Castellanos', 'Support Specialist', 'Madrid, ES', 'office', pick('Life event', 3)],
  ['Jonah Whitlock', 'Warehouse Lead', 'Leeds, UK', 'office', pick('Timetable change', 2)],
  ['Ilse Varga', 'Financial Analyst', 'Vienna, AT', 'hybrid', pick('Complaint', 1)],
  ['Kofi Mensah', 'Field Engineer', 'Hamburg, DE', 'remote', pick('Refund', 0)],
].map(([name, role, location, workMode, example], index) => ({
  profile: { name, role, location, workMode, startDate: `2026-11-0${index + 2}`, manager: 'Alex Moreau', exception: example.text.slice(0, 1900) },
  expected: { route: example.route, category: example.category, source: example.id },
}));

const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: { ...process.env, NODFIRST_DB: dbPath, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let errors = '';
child.stderr.on('data', chunk => { if (!/ExperimentalWarning|trace-warnings/.test(chunk)) errors += chunk; });
const base = await new Promise((resolveReady, reject) => {
  let output = '';
  const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 10000);
  child.stdout.on('data', chunk => { output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timeout); resolveReady(match[0]); } });
  child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
});

let cookie, csrf;
async function api(path, body, expected = 200) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  if (data.session) csrf = data.session.csrfToken;
  return data;
}

const transcript = { date: new Date().toISOString(), steps: [], hires: [] };
const step = (label, detail = {}) => { transcript.steps.push({ at: new Date().toISOString(), label, ...detail }); console.log(`• ${label}${detail.note ? ` — ${detail.note}` : ''}`); };

try {
  await api('/api/state');
  const health = await api('/api/health');
  transcript.provider = health.model;
  step('Decision engine', { note: `${health.model.label} (${health.model.model}), available=${health.model.available}` });
  assert.ok(health.model.available, `Active provider is unavailable: ${health.model.error}`);

  for (const [index, item] of [{ profile, expected: { route: 'payroll', category: 'expense_refund', source: 'nodfirst-demo-profile' } }, ...fromDataset].entries()) {
    const { employee } = await api('/api/employees', item.profile, 201);
    step(`Added fictional hire ${employee.name}`, { note: `${employee.role}, ${employee.location}, ${employee.workMode}` });
    const { workflow } = await api(`/api/employees/${employee.id}/onboard`, {});
    let state = await api('/api/state');
    const tasks = state.tasks.filter(task => task.workflowId === workflow.id);
    for (const task of tasks.filter(task => task.kind === 'checklist')) await api(`/api/tasks/${task.id}/complete`, {});
    step('Checklist completed', { note: `${tasks.length - 1} items, 1 exception` });

    await api(`/api/workflows/${workflow.id}/judgment`, {}, 202);
    const deadline = Date.now() + 180_000;
    let job;
    do { await delay(250); state = await api('/api/state'); job = state.jobs.find(item => item.workflowId === workflow.id); } while (['queued', 'running'].includes(job.status) && Date.now() < deadline);
    assert.equal(job.status, 'succeeded', job.error || 'decision did not finish');
    const judgment = state.judgments.find(item => item.workflowId === workflow.id);
    const approval = state.approvals.find(item => item.workflowId === workflow.id);
    assert.equal(state.actions.filter(action => action.workflowId === workflow.id).length, 0, 'no action before a human decision');
    step('Agent decision', { note: `route=${judgment.route} (${Math.round(judgment.confidence * 100)}%), category=${judgment.category}, sensitive=${Math.round(judgment.sensitive * 100)}%, uncertain=${judgment.uncertain}` });

    await api(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Coordinator attempt' }, 403);
    await api('/api/session', { role: 'admin' });
    const reject = index === 3;
    const decision = await api(`/api/approvals/${approval.id}/decision`, reject
      ? { decision: 'rejected', reason: 'Complaint must go to a named HR business partner directly, not a queue.' }
      : { decision: 'approved', reason: `Reviewed the ${judgment.category.replace(/_/g, ' ')} request; route to ${judgment.uncertain ? 'People Operations' : judgment.route}.` });
    await api('/api/session', { role: 'coordinator' });
    step(reject ? 'Admin rejected — no action created' : 'Admin approved — one follow-up created', { note: decision.action ? `${decision.action.title} → ${decision.action.owner}` : 'none' });

    transcript.hires.push({
      name: employee.name,
      request: employee.exception,
      expected: item.expected,
      decision: { provider: judgment.provider, model: judgment.model, route: judgment.route, confidence: judgment.confidence, probabilities: judgment.probabilities, category: judgment.category, sensitive: judgment.sensitive, uncertain: judgment.uncertain, reason: judgment.reason, durationMs: judgment.durationMs },
      matches: { route: judgment.route === item.expected.route, category: judgment.category === item.expected.category },
      approval: decision.approval.status,
      action: decision.action ? { title: decision.action.title, owner: decision.action.owner } : null,
    });
  }

  const final = await api('/api/state');
  transcript.counts = Object.fromEntries(['employees', 'workflows', 'tasks', 'judgments', 'approvals', 'actions', 'audit'].map(key => [key, final[key].length]));
  step('Final state', { note: JSON.stringify(transcript.counts) });
  const out = join(root, 'docs/demo/profile-run.json');
  await mkdir(join(root, 'docs/demo'), { recursive: true });
  await writeFile(out, JSON.stringify(transcript, null, 1));
  console.log(`Wrote docs/demo/profile-run.json${keepDb ? ` · database kept at ${keepDb}` : ''}`);
} finally {
  child.kill('SIGTERM');
  await new Promise(resolveStopped => child.once('exit', resolveStopped));
  if (directory) await rm(directory, { recursive: true, force: true });
  if (errors.trim()) console.error(errors);
}

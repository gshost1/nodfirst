import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Starts actual server processes and calls actual local Ollama. No provider doubles.
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'daybreak-live-'));
let processHandle;
let session;
const evidence = { date: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, inference: 'Real local Ollama; no mocks or cloud calls', checks: [] };

async function launch() {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: { ...process.env, DAYBREAK_DB: join(directory, 'demo.sqlite'), PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const base = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 10000);
    child.stdout.on('data', chunk => { output += chunk; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timeout); resolveReady(match[0]); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
  });
  let cookie, csrf;
  async function request(path, body, expected = 200) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
    if (data.session) csrf = data.session.csrfToken;
    return data;
  }
  async function stop() {
    if (child.exitCode !== null) return;
    await new Promise((resolveStopped, reject) => { child.once('exit', code => code === 0 ? resolveStopped() : reject(new Error(`Server stopped with ${code}: ${errors}`))); child.kill('SIGTERM'); });
    assert.equal(errors.trim(), '', `Unexpected server errors: ${errors}`);
  }
  processHandle = { child, stop };
  session = { request };
  await request('/api/state');
}
async function waitForJudgment(workflowId) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const state = await session.request('/api/state');
    const job = state.jobs.find(job => job.workflowId === workflowId);
    if (job?.status === 'failed') throw new Error(`Real local inference failed: ${job.error}`);
    const judgment = state.judgments.find(item => item.workflowId === workflowId);
    if (judgment) return { state, judgment };
    await delay(300);
  }
  throw new Error('Real inference did not complete before the deadline.');
}

try {
  await launch();
  let request = session.request;
  const health = await request('/api/health');
  assert.equal(health.model.available, true, health.model.error);
  evidence.model = health.model;
  const initial = await request('/api/state');
  assert.equal(initial.company.synthetic, true);
  const wf = (await request(`/api/employees/${initial.employees[0].id}/onboard`, {})).workflow;
  assert.equal((await request(`/api/employees/${initial.employees[0].id}/onboard`, {})).workflow.id, wf.id);
  await request(`/api/workflows/${wf.id}/judgment`, {}, 202);
  const first = await waitForJudgment(wf.id);
  evidence.approvedJudgment = first.judgment;
  assert.equal(first.judgment.provider, 'ollama');
  assert.equal(first.state.actions.length, 0);
  const approval = first.state.approvals.find(a => a.workflowId === wf.id);
  await request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Unauthorized test' }, 403);
  await request('/api/session', { role: 'admin' });
  const approved = await request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Reviewed ambiguous equipment request; create a local follow-up for a human.' });
  assert.equal(approved.action.type, 'local_task');
  await request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Repeated request' }, 409);
  for (const task of first.state.tasks.filter(t => t.workflowId === wf.id && t.kind === 'checklist')) await request(`/api/tasks/${task.id}/complete`, {});
  evidence.checks.push('Policy-backed checklist, real judgment, coordinator denied, admin approval, exactly one local action, repeated decision denied');
  const wf2 = (await request(`/api/employees/${initial.employees[1].id}/onboard`, {})).workflow;
  await request(`/api/workflows/${wf2.id}/judgment`, {}, 202);
  const second = await waitForJudgment(wf2.id);
  evidence.rejectedJudgment = second.judgment;
  const approval2 = second.state.approvals.find(a => a.workflowId === wf2.id);
  await request(`/api/approvals/${approval2.id}/decision`, { decision: 'rejected', reason: 'Reject sensitive access request in this local demonstration.' });
  evidence.checks.push('Second real judgment and admin rejection create no action');
  const noException = (await request(`/api/employees/${initial.employees[2].id}/onboard`, {})).workflow;
  await request(`/api/workflows/${noException.id}/judgment`, {}, 422);
  for (const task of (await request('/api/state')).tasks.filter(t => t.workflowId === noException.id)) await request(`/api/tasks/${task.id}/complete`, {});
  await request('/api/employees', { name: 'Casey Demo', role: 'Operations Analyst', location: 'Austin, TX', startDate: '2026-11-02', manager: 'Robin Example', workMode: 'office', exception: '' }, 201);
  evidence.checks.push('Ordinary no-exception onboarding completes without a model; adding a synthetic hire persists');
  const before = await request('/api/state');
  assert.equal(before.actions.length, 1);
  assert.equal(before.workflows.find(w => w.id === wf.id).status, 'complete');
  assert.equal(before.workflows.find(w => w.id === noException.id).status, 'complete');
  assert.equal(before.actions.some(a => a.workflowId === wf2.id), false);
  await processHandle.stop();
  await launch();
  request = session.request;
  const after = await request('/api/state');
  for (const key of ['employees','workflows','tasks','judgments','approvals','actions','jobs','audit']) assert.deepEqual(after[key], before[key], `Persisted ${key} changed after process restart`);
  assert.equal(after.session.role, 'coordinator');
  evidence.checks.push('Actual server process stopped and restarted; all domain records and audit entries retained; demo session reset');
  evidence.counts = Object.fromEntries(['employees','workflows','tasks','judgments','approvals','actions','jobs','audit'].map(key => [key, after[key].length]));
  evidence.approvalAudit = after.audit.filter(item => ['approval.approved','approval.rejected','action.created'].includes(item.action));
  evidence.result = 'PASS';
  console.log(JSON.stringify(evidence, null, 2));
  if (process.env.VALIDATION_OUTPUT) await writeFile(resolve(process.env.VALIDATION_OUTPUT), JSON.stringify(evidence, null, 2) + '\n');
} finally {
  if (processHandle) await processHandle.stop();
  await rm(directory, { recursive: true, force: true });
}

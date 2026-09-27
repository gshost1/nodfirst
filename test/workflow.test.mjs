import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { get as httpGet } from 'node:http';
import { createApp } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { createWorkflowService, startWorker } from '../src/workflow.mjs';

// Deterministic test doubles exercise workflow safety; real inference is a separate live gate.
const judgment = { provider: 'test-double', model: 'mock', route: 'it', confidence: 0.4, reason: 'Test only: ambiguous route.', uncertain: false, durationMs: 10 };
const mockProvider = { name: 'test-double', model: 'mock', baseUrl: 'http://127.0.0.1', health: async () => ({ available: true }), judge: async () => judgment };
const coordinator = { role: 'coordinator', actor: 'Test coordinator' };

async function client(app) {
  const base = await app.listen(0);
  let cookie, csrf;
  async function request(path, body, extra = {}) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    if (data.session) csrf = data.session.csrfToken;
    return { status: response.status, data };
  }
  await request('/api/state');
  return { base, request };
}
async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await delay(15); }
  throw new Error('Expected condition did not become true.');
}

test('HTTP approval gate, duplicate prevention, rejection, policies and persistent audit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nodfirst-test-'));
  let app = createApp({ dbPath: join(directory, 'test.sqlite'), provider: mockProvider, worker: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let c = await client(app);
  const initial = (await c.request('/api/state')).data;
  const employee = initial.employees[0];
  const onboard = await c.request(`/api/employees/${employee.id}/onboard`, {});
  assert.equal(onboard.status, 200);
  const workflow = onboard.data.workflow;
  assert.equal((await c.request(`/api/employees/${employee.id}/onboard`, {})).data.workflow.id, workflow.id);
  let state = (await c.request('/api/state')).data;
  assert.equal(state.tasks.length, 5);
  assert.ok(state.tasks.every(task => state.policies.some(policy => policy.id === task.policyId)));
  const exception = state.tasks.find(task => task.kind === 'exception');
  assert.equal((await c.request(`/api/tasks/${exception.id}/complete`, {})).status, 409);
  const queued = (await c.request(`/api/workflows/${workflow.id}/judgment`, {})).data.job;
  assert.equal((await c.request(`/api/workflows/${workflow.id}/judgment`, {})).data.job.id, queued.id);
  const job = app.service.claimJob();
  app.service.finishJob(job, judgment);
  state = (await c.request('/api/state')).data;
  assert.equal(state.judgments[0].uncertain, true, 'Code forces uncertainty below threshold');
  assert.equal(state.actions.length, 0);
  const approval = state.approvals[0];
  assert.equal((await c.request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Reviewed for test' })).status, 403);
  await c.request('/api/session', { role: 'admin' });
  assert.equal((await c.request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: '' })).status, 422);
  const accepted = await c.request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Create a local follow-up only.' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.action.owner, 'People Operations');
  assert.equal((await c.request(`/api/approvals/${approval.id}/decision`, { decision: 'approved', reason: 'Duplicate attempt' })).status, 409);
  for (const task of state.tasks.filter(task => task.kind === 'checklist')) await c.request(`/api/tasks/${task.id}/complete`, {});
  const wf2 = app.service.onboard(initial.employees[1].id, coordinator.actor);
  app.service.queueJudgment(wf2.id, coordinator.actor);
  app.service.finishJob(app.service.claimJob(), { ...judgment, confidence: 0.9, route: 'security' });
  const approval2 = app.store.state().approvals.find(item => item.workflowId === wf2.id);
  await c.request(`/api/approvals/${approval2.id}/decision`, { decision: 'rejected', reason: 'No production access during this demonstration.' });
  const persisted = (await c.request('/api/state')).data;
  assert.equal(persisted.workflows.find(w => w.id === workflow.id).status, 'complete');
  assert.equal(persisted.actions.length, 1);
  assert.equal(persisted.actions[0].approvalId, approval.id);
  assert.ok(persisted.audit.some(entry => entry.action === 'action.created' && entry.details.approvedBy === 'Maya Chen (admin)'));
  assert.ok(persisted.audit.some(entry => entry.action === 'approval.rejected'));
  assert.throws(() => app.store.db.prepare('DELETE FROM audit').run(), /append-only/);
  assert.throws(() => app.store.insert('actions', { ...persisted.actions[0], id: 'unauthorized', approvalId: approval2.id, workflowId: wf2.id }), /approved decision/);
  await app.close();
  app = createApp({ dbPath: join(directory, 'test.sqlite'), provider: mockProvider, worker: false });
  c = await client(app);
  const restored = (await c.request('/api/state')).data;
  for (const key of ['workflows', 'tasks', 'judgments', 'approvals', 'actions', 'audit']) assert.deepEqual(restored[key], persisted[key], `${key} survives reopen`);
  assert.equal(restored.session.role, 'coordinator', 'Sessions reset on restart');
});

test('HTTP input, origin, host and CSRF validation', async t => {
  const app = createApp({ dbPath: ':memory:', provider: mockProvider, worker: false });
  t.after(() => app.close());
  const c = await client(app);
  const sample = { name: 'Synthetic Person', role: 'Designer', location: 'Portland', startDate: '2026-02-30', manager: 'Test Manager', workMode: 'remote', exception: '' };
  assert.equal((await c.request('/api/employees', sample)).status, 422);
  assert.equal((await c.request('/api/employees', { ...sample, startDate: '2026-10-01', exception: 'x'.repeat(2001) })).status, 422);
  assert.equal((await c.request('/api/employees', { ...sample, startDate: '2026-10-01' })).status, 201);
  assert.equal((await c.request('/api/session', { role: 'admin' }, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await c.request('/api/session', { role: 'admin' }, { origin: 'https://example.com' })).status, 403);
  // Native fetch rewrites Host; raw HTTP is needed to exercise DNS-rebinding defense.
  const hostileHostStatus = await new Promise((resolveStatus, reject) => {
    httpGet(c.base + '/api/state', { headers: { host: 'evil.example:4317' } }, response => {
      response.resume(); resolveStatus(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await c.request('/api/state', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const large = await c.request('/api/employees', { name: 'x'.repeat(17000) });
  assert.equal(large.status, 413);
});

test('model failure creates no fake judgment, approval or action; retry is durable', () => {
  const store = createStore(':memory:');
  try {
    const service = createWorkflowService(store);
    const workflow = service.onboard(store.state().employees[0].id, coordinator.actor);
    service.queueJudgment(workflow.id, coordinator.actor);
    const job = service.claimJob();
    service.failJob(job, new Error('Ollama unavailable (test)'));
    const failed = store.state();
    assert.equal(failed.jobs[0].status, 'failed');
    assert.equal(failed.judgments.length, 0);
    assert.equal(failed.approvals.length, 0);
    assert.equal(failed.actions.length, 0);
    assert.equal(service.queueJudgment(workflow.id, coordinator.actor).id, job.id);
    service.finishJob(service.claimJob(), judgment);
    assert.equal(store.state().jobs[0].attempts, 2);
    assert.equal(store.state().judgments.length, 1);
  } finally { store.close(); }
});

test('interrupted running job is requeued and produces one judgment after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodfirst-recovery-'));
  const path = join(directory, 'db.sqlite');
  let store = createStore(path);
  try {
    let service = createWorkflowService(store);
    const workflow = service.onboard(store.state().employees[0].id, coordinator.actor);
    service.queueJudgment(workflow.id, coordinator.actor);
    service.claimJob();
    store.close();
    store = createStore(path);
    service = createWorkflowService(store);
    const stop = startWorker(service, mockProvider, 5);
    await waitFor(() => store.state().jobs[0].status === 'succeeded');
    await stop();
    assert.equal(store.state().jobs[0].attempts, 2);
    assert.equal(store.state().judgments.length, 1);
    assert.equal(store.state().approvals.length, 1);
    assert.ok(store.state().audit.some(entry => entry.action === 'model.recovered'));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('worker shutdown waits for in-flight inference across several timer ticks', async () => {
  const store = createStore(':memory:');
  const service = createWorkflowService(store);
  const workflow = service.onboard(store.state().employees[0].id, coordinator.actor);
  service.queueJudgment(workflow.id, coordinator.actor);
  let release;
  const slowProvider = { judge: () => new Promise(resolve => { release = resolve; }) };
  const stop = startWorker(service, slowProvider, 5);
  await delay(40);
  let stopped = false;
  const shutdown = stop().then(() => { stopped = true; });
  await delay(20);
  assert.equal(stopped, false);
  release(judgment);
  await shutdown;
  assert.equal(store.state().jobs[0].status, 'succeeded');
  store.close();
});

test('admin-only provider switch persists, is audited, and refuses unconfigured providers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nodfirst-test-'));
  const second = { ...mockProvider, name: 'second', label: 'Second', model: 'mock-2', configured: true, judge: async () => ({ ...judgment, provider: 'second', route: 'payroll', confidence: 0.91, category: 'compensation', sensitive: 0.2, probabilities: { payroll: 0.91, people_ops: 0.09 } }) };
  const missing = { ...mockProvider, name: 'missing', label: 'Missing', configured: false, setup: 'Set MISSING_KEY.', health: async () => ({ available: false, error: 'MISSING_KEY is not set.' }) };
  const providers = { 'test-double': { ...mockProvider, configured: true }, second, missing };
  const dbPath = join(directory, 'switch.sqlite');
  let app = createApp({ dbPath, providers, worker: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let c = await client(app);
  const health = (await c.request('/api/health')).data;
  assert.equal(health.providers.length, 3);
  assert.equal((await c.request('/api/provider', { name: 'second' })).status, 403);
  await c.request('/api/session', { role: 'admin' });
  assert.equal((await c.request('/api/provider', { name: 'nope' })).status, 422);
  const refused = await c.request('/api/provider', { name: 'missing' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /MISSING_KEY/);
  assert.equal((await c.request('/api/provider', { name: 'second' })).data.provider.active, true);
  const state = (await c.request('/api/state')).data;
  assert.ok(state.audit.some(entry => entry.action === 'provider.changed' && entry.details.to === 'second'));
  const workflow = app.service.onboard(state.employees[0].id, 'Test');
  app.service.queueJudgment(workflow.id, 'Test');
  app.service.finishJob(app.service.claimJob(), await app.provider.judge({}));
  const stored = (await c.request('/api/state')).data.judgments[0];
  assert.deepEqual([stored.provider, stored.route, stored.category, stored.probabilities.payroll], ['second', 'payroll', 'compensation', 0.91]);
  await app.close();
  app = createApp({ dbPath, providers, worker: false });
  c = await client(app);
  assert.equal((await c.request('/api/health')).data.model.provider, 'second', 'active provider survives restart');
});

import { AppError, id, now } from './store.mjs';
import { CONFIDENCE_FLOOR, owners } from './decision.mjs';

function text(value, field, max = 120, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new AppError(422, `${field} must contain ${min}–${max} characters.`);
  }
  return value.trim();
}
export function createWorkflowService(store) {
  const { db, transaction, insert, get, requireRecord, log } = store;
  function updateStatus(workflowId) {
    const pending = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workflowId=? AND status NOT IN ('done','approved','rejected')").get(workflowId).n;
    db.prepare('UPDATE workflows SET status=?,updatedAt=? WHERE id=?').run(pending ? 'active' : 'complete', now(), workflowId);
  }
  function addEmployee(input, actor) {
    const date = text(input.startDate, 'Start date', 10, 10);
    const parsed = new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new AppError(422, 'Enter a real start date in YYYY-MM-DD format.');
    if (!['remote', 'hybrid', 'office'].includes(input.workMode)) throw new AppError(422, 'Choose remote, hybrid, or office.');
    const employee = { id: id(), name: text(input.name, 'Name'), role: text(input.role, 'Role'), location: text(input.location, 'Location'), startDate: date, manager: text(input.manager, 'Manager'), workMode: input.workMode, exception: text(input.exception ?? '', 'Exception', 2000, 0), createdAt: now() };
    return transaction(() => { insert('employees', employee); log(actor, 'employee.added', null, { employeeId: employee.id, name: employee.name, synthetic: true }, employee.id); return employee; });
  }
  function onboard(employeeId, actor) {
    return transaction(() => {
      const employee = requireRecord('employees', employeeId);
      const existing = db.prepare('SELECT * FROM workflows WHERE employeeId=?').get(employeeId);
      if (existing) return existing;
      const timestamp = now();
      const workflow = insert('workflows', { id: id(), employeeId, routineId: 'onboarding-v1', status: 'active', createdAt: timestamp, updatedAt: timestamp });
      const templates = [
        ['Read the welcome handbook', employee.name, 'welcome', 'Acknowledge the fictional company handbook before the first day.'],
        ['Schedule a first-day welcome', employee.manager, 'orientation', `Arrange a welcome meeting for ${employee.startDate}.`],
        ['Prepare a standard workspace', 'IT Operations', 'workspace', 'Record the standard equipment and account checklist locally.'],
      ];
      if (employee.workMode === 'remote') templates.push(['Confirm equipment delivery plan', 'IT Operations', 'remote', 'Confirm a delivery plan with the new hire. This demo does not order or ship equipment.']);
      for (const [title, owner, policyId, details] of templates) insert('tasks', { id: id(), workflowId: workflow.id, title, owner, status: 'todo', policyId, kind: 'checklist', details, createdAt: timestamp });
      if (employee.exception) insert('tasks', { id: id(), workflowId: workflow.id, title: 'Review onboarding exception', owner: 'People Operations', status: 'needs_judgment', policyId: 'exceptions', kind: 'exception', details: employee.exception, createdAt: timestamp });
      log(actor, 'onboarding.started', workflow.id, { employeeId, routineId: workflow.routineId, routineVersion: get('routines', workflow.routineId).version, startDate: employee.startDate });
      return workflow;
    });
  }
  function completeTask(taskId, actor) {
    return transaction(() => {
      const task = requireRecord('tasks', taskId);
      if (task.kind !== 'checklist') throw new AppError(409, 'Exceptions must go through model review and an admin decision.');
      if (task.status === 'done') return task;
      db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(taskId);
      log(actor, 'checklist.completed', task.workflowId, { taskId, title: task.title, policyId: task.policyId });
      updateStatus(task.workflowId);
      return get('tasks', taskId);
    });
  }
  function queueJudgment(workflowId, actor) {
    return transaction(() => {
      requireRecord('workflows', workflowId);
      const task = db.prepare("SELECT * FROM tasks WHERE workflowId=? AND kind='exception'").get(workflowId);
      if (!task) throw new AppError(422, 'This onboarding has no exception to assess.');
      let job = db.prepare('SELECT * FROM jobs WHERE workflowId=?').get(workflowId);
      if (job && job.status !== 'failed') return job;
      if (job) { db.prepare("UPDATE jobs SET status='queued',error=NULL,updatedAt=? WHERE id=?").run(now(), job.id); job = get('jobs', job.id); }
      else job = insert('jobs', { id: id(), workflowId, type: 'judge_exception', status: 'queued', attempts: 0, error: null, createdAt: now(), updatedAt: now() });
      log(actor, 'model.queued', workflowId, { jobId: job.id });
      return job;
    });
  }
  function recoverJobs() {
    transaction(() => {
      for (const job of db.prepare("SELECT * FROM jobs WHERE status='running'").all()) {
        db.prepare("UPDATE jobs SET status='queued',updatedAt=? WHERE id=?").run(now(), job.id);
        log('System', 'model.recovered', job.workflowId, { jobId: job.id, reason: 'Interrupted job resumed after app restart.' });
      }
    });
  }
  function claimJob() {
    return transaction(() => {
      const job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
      if (!job) return null;
      db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,updatedAt=? WHERE id=?").run(now(), job.id);
      return get('jobs', job.id);
    });
  }
  function modelInput(job) {
    const workflow = requireRecord('workflows', job.workflowId);
    const employee = requireRecord('employees', workflow.employeeId);
    return { role: employee.role, location: employee.location, workMode: employee.workMode, exception: employee.exception, policies: db.prepare("SELECT * FROM policies WHERE id IN ('workspace','remote','payroll','exceptions')").all() };
  }
  function finishJob(job, result) {
    return transaction(() => {
      if (get('jobs', job.id)?.status !== 'running') return;
      const task = db.prepare("SELECT * FROM tasks WHERE workflowId=? AND kind='exception'").get(job.workflowId);
      const judgment = insert('judgments', { id: id(), workflowId: job.workflowId, provider: result.provider, model: result.model, route: result.route, confidence: result.confidence, reason: result.reason, category: result.category ?? null, categoryConfidence: result.categoryConfidence ?? null, sensitive: result.sensitive ?? null, probabilities: result.probabilities ? JSON.stringify(result.probabilities) : null, uncertain: Number(Boolean(result.uncertain || result.confidence < CONFIDENCE_FLOOR || result.route === 'uncertain')), durationMs: Math.round(result.durationMs), createdAt: now() });
      const approval = insert('approvals', { id: id(), workflowId: job.workflowId, taskId: task.id, judgmentId: judgment.id, status: 'pending', requestedAt: now(), decidedAt: null, decidedBy: null, reason: null });
      db.prepare("UPDATE tasks SET status='awaiting_review' WHERE id=?").run(task.id);
      db.prepare("UPDATE jobs SET status='succeeded',error=NULL,updatedAt=? WHERE id=?").run(now(), job.id);
      log('Decision worker', 'model.completed', job.workflowId, { jobId: job.id, judgmentId: judgment.id, provider: judgment.provider, model: judgment.model, route: judgment.route, confidence: judgment.confidence, category: judgment.category, sensitive: judgment.sensitive, uncertain: Boolean(judgment.uncertain), durationMs: judgment.durationMs });
      log('Policy engine', 'approval.requested', job.workflowId, { approvalId: approval.id, policyId: 'exceptions', reason: 'Every exception requires a human decision before a follow-up is created.' });
    });
  }
  function failJob(job, error) {
    transaction(() => {
      const message = String(error.message || 'Decision provider failed.').slice(0, 700);
      db.prepare("UPDATE jobs SET status='failed',error=?,updatedAt=? WHERE id=?").run(message, now(), job.id);
      log('Decision worker', 'model.failed', job.workflowId, { jobId: job.id, error: message });
    });
  }
  function decide(approvalId, input, session) {
    if (session.role !== 'admin') throw new AppError(403, 'Switch to the demo admin persona to decide this request.');
    if (!['approved', 'rejected'].includes(input.decision)) throw new AppError(422, 'Choose approved or rejected.');
    const reason = text(input.reason, 'Decision reason', 1000, 3);
    return transaction(() => {
      const approval = requireRecord('approvals', approvalId);
      if (approval.status !== 'pending') throw new AppError(409, 'This request already has a final decision.');
      const timestamp = now();
      db.prepare('UPDATE approvals SET status=?,decidedAt=?,decidedBy=?,reason=? WHERE id=?').run(input.decision, timestamp, session.actor, reason, approvalId);
      db.prepare('UPDATE tasks SET status=? WHERE id=?').run(input.decision, approval.taskId);
      log(session.actor, `approval.${input.decision}`, approval.workflowId, { approvalId, reason, taskId: approval.taskId });
      let action;
      if (input.decision === 'approved') {
        const judgment = requireRecord('judgments', approval.judgmentId);
        const workflow = requireRecord('workflows', approval.workflowId);
        const employee = requireRecord('employees', workflow.employeeId);
        action = insert('actions', { id: id(), approvalId, workflowId: approval.workflowId, type: 'local_task', title: `Follow up on ${employee.name}'s onboarding exception`, owner: owners[judgment.uncertain ? 'uncertain' : judgment.route], status: 'created', createdAt: timestamp });
        log(session.actor, 'action.created', approval.workflowId, { actionId: action.id, approvalId, approvedBy: session.actor, owner: action.owner, title: action.title, localOnly: true });
      }
      updateStatus(approval.workflowId);
      return { approval: get('approvals', approvalId), ...(action ? { action } : {}) };
    });
  }
  return { addEmployee, onboard, completeTask, queueJudgment, recoverJobs, claimJob, modelInput, finishJob, failJob, decide };
}

// providerFor may be a provider or a function returning the active one per job.
export function startWorker(service, providerFor, intervalMs = 400) {
  const activeProvider = typeof providerFor === 'function' ? providerFor : () => providerFor;
  let active = false;
  let stopped = false;
  let current = Promise.resolve();
  service.recoverJobs();
  async function tick() {
    if (active || stopped) return;
    active = true;
    try {
      const job = service.claimJob();
      if (!job) return;
      try { service.finishJob(job, await activeProvider().judge(service.modelInput(job))); }
      catch (error) { service.failJob(job, error); }
    } finally { active = false; }
  }
  // Retain the real in-flight promise so shutdown cannot close SQLite early.
  const timer = setInterval(() => { if (!active && !stopped) current = tick(); }, intervalMs);
  timer.unref();
  current = tick();
  return async () => { stopped = true; clearInterval(timer); await current; };
}

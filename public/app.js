const app = document.querySelector('#app');
const toast = document.querySelector('#toast');

let data = null;
let health = null;
let selectedEmployeeId = null;
let view = 'hires';
let addingHire = false;
let approvalFormEngaged = false;
let busy = new Set();
let toastTimer;

const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const compactDate = value => value ? new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric'}).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)) : '—';
const dateTime = value => value ? new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value)) : '—';
const pretty = value => String(value ?? '').replace(/[_.-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const text = (value, fallback = '—') => escapeHtml(value || fallback);
const plural = (count, noun) => `${count} ${count === 1 ? noun : noun === 'person' ? 'people' : `${noun}s`}`;
const all = name => data?.[name] || [];
const employeeFor = workflow => all('employees').find(employee => employee.id === workflow?.employeeId);
const workflowFor = employee => all('workflows').find(workflow => workflow.employeeId === employee?.id);
const byWorkflow = (name, workflow) => all(name).filter(item => item.workflowId === workflow?.id);
const policyFor = task => all('policies').find(policy => policy.id === task.policyId);
const selectedEmployee = () => all('employees').find(employee => employee.id === selectedEmployeeId) || all('employees')[0];
const isBusy = key => busy.has(key);

function message(value, kind = 'success') {
  toast.textContent = value;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5200);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.method === 'POST' ? {'content-type': 'application/json', 'x-csrf-token': data?.session?.csrfToken || ''} : {}),
      ...(options.headers || {})
    }
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Request failed (${response.status}).`); }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

async function refresh({quiet = false} = {}) {
  try {
    const next = await request('/api/state');
    const previous = data;
    data = next;
    if (!selectedEmployeeId || !all('employees').some(employee => employee.id === selectedEmployeeId)) {
      selectedEmployeeId = all('employees')[0]?.id || null;
    }
    if (previous) {
      for (const job of next.jobs || []) {
        const before = (previous.jobs || []).find(item => item.id === job.id);
        if (before && before.status !== job.status && ['succeeded', 'failed'].includes(job.status)) {
          message(job.status === 'succeeded' ? 'Local model judgment completed.' : `Local model job failed: ${job.error || 'Unknown error'}`, job.status === 'failed' ? 'error' : 'success');
        }
      }
    }
    renderSafely();
  } catch (error) {
    if (!quiet || !data) showFatal(error);
    else message(`Could not refresh: ${error.message}`, 'error');
  }
}

async function refreshHealth() {
  try { health = await request('/api/health'); }
  catch (error) { health = {model: {available: false, error: error.message}}; }
  renderSafely();
}

function showFatal(error) {
  app.innerHTML = `<div class="fatal"><div class="eyebrow">Daybreak could not open</div><h1>Connection needed</h1><p>${text(error.message)}</p><button class="button primary" data-action="retry-load">Try again</button></div>`;
}

function renderSafely() {
  if (!data) return;
  if (addingHire || (view === 'approvals' && approvalFormEngaged)) return;
  render();
}

function button(label, action, extra = '') {
  return `<button class="button ${extra}" type="button" data-action="${action}">${label}</button>`;
}

function render() {
  const pendingCount = all('approvals').filter(item => item.status === 'pending').length;
  const role = data.session.role;
  const model = health?.model;
  const modelLabel = !health ? 'Checking local model…' : model?.available ? 'Local model available' : 'Local model unavailable';
  const currentPage = {hires: 'New hires', approvals: 'Approvals', audit: 'Audit trail'}[view];
  app.innerHTML = `
    <aside class="rail">
      <div class="brand"><div class="brand-mark" aria-hidden="true"><span></span></div><div><strong>Daybreak</strong><small>Onboarding studio</small></div></div>
      <div class="demo-label"><span class="demo-dot"></span>Synthetic local demo</div>
      <nav class="nav" aria-label="Primary navigation">
        <div class="nav-group"><div class="nav-group-label">Workspace</div>
          <button class="nav-link ${view === 'hires' ? 'active' : ''}" type="button" data-view="hires" ${view === 'hires' ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">◫</span> New hires <span class="nav-count">${all('employees').length}</span></button>
          <button class="nav-link ${view === 'approvals' ? 'active' : ''}" type="button" data-view="approvals" ${view === 'approvals' ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">◎</span> Approvals <span class="nav-count ${pendingCount ? 'attention' : ''}">${pendingCount}</span></button>
        </div>
        <div class="nav-group"><div class="nav-group-label">Records</div>
          <button class="nav-link ${view === 'audit' ? 'active' : ''}" type="button" data-view="audit" ${view === 'audit' ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">≡</span> Audit trail</button>
        </div>
      </nav>
      <div class="rail-bottom"><div class="environment"><span class="status-dot ${model?.available ? 'ok' : 'muted'}"></span><span>${modelLabel}</span></div><p>Everything shown here stays on this machine. Follow-up actions create local records only.</p></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="topbar-location"><span>People operations</span><span aria-hidden="true">/</span><strong>${currentPage}</strong></div><div class="mobile-brand">Daybreak</div><div class="topbar-right"><span class="topbar-caption">Demo persona</span><label class="sr-only" for="role-select">Demo persona</label><select id="role-select" aria-label="Demo persona"><option value="coordinator" ${role === 'coordinator' ? 'selected' : ''}>Jordan Lee · coordinator</option><option value="admin" ${role === 'admin' ? 'selected' : ''}>Maya Chen · admin</option></select></div></header>
      <main id="main-content">${view === 'hires' ? renderHires() : view === 'approvals' ? renderApprovals() : renderAudit()}</main>
    </div>`;
}

function pageHeading(kicker, title, description, suffix = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${suffix}</div>`;
}

function renderHires() {
  const employee = selectedEmployee();
  const employees = all('employees');
  return `${pageHeading('People / Onboarding', 'New hires', 'Review each step, route exceptions, and keep the record together.', button('＋ Add new hire', 'toggle-add', 'primary'))}
    <div class="hires-layout">
      <section class="queue panel" aria-label="New hire queue"><div class="panel-heading"><h2>New hire queue</h2><span class="soft-count">${plural(employees.length, 'person')}</span></div>
      ${addingHire ? renderAddForm() : ''}
      <div class="queue-list">${employees.length ? employees.map(item => {
        const workflow = workflowFor(item);
        const open = workflow && byWorkflow('tasks', workflow).filter(task => !['done', 'approved', 'rejected'].includes(task.status)).length;
        return `<button type="button" class="queue-item ${employee?.id === item.id ? 'selected' : ''}" data-employee-id="${escapeHtml(item.id)}" ${employee?.id === item.id ? 'aria-current="true"' : ''}><span class="avatar" aria-hidden="true">${escapeHtml(initials(item.name))}</span><span class="queue-copy"><strong>${text(item.name)}</strong><small>${text(item.role)} · ${text(item.location)}</small><span class="queue-meta">${workflow ? `${open} open · ${pretty(workflow.status)}` : 'Ready to onboard'}</span></span><span class="queue-arrow" aria-hidden="true">→</span></button>`;
      }).join('') : `<div class="empty-state"><strong>No hires yet</strong><p>Add a fictional new hire to start an onboarding workflow.</p></div>`}</div></section>
      <section class="detail" aria-label="Selected hire">${employee ? renderEmployee(employee) : `<div class="panel empty-state"><h2>Select a hire</h2><p>Choose a person in the queue or add one to begin.</p></div>`}</section>
    </div>`;
}

function initials(name) { return String(name || '').trim().split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase()).join(''); }

function renderAddForm() {
  return `<form id="add-hire-form" class="add-form"><div class="form-heading"><strong>New fictional hire</strong><button class="icon-button" type="button" data-action="toggle-add" aria-label="Close form">×</button></div>
    <label>Full name<input name="name" required autocomplete="off" placeholder="Avery Rivera"></label>
    <label>Role<input name="role" required placeholder="Product Designer"></label>
    <div class="form-grid"><label>Location<input name="location" required placeholder="Portland, OR"></label><label>Start date<input name="startDate" required type="date"></label></div>
    <label>Manager<input name="manager" required placeholder="Morgan Ellis"></label>
    <label>Work mode<select name="workMode" required><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="office">Office</option></select></label>
    <label>Onboarding exception <span class="optional">optional</span><textarea name="exception" rows="3" placeholder="Describe a routing question for the local model"></textarea></label>
    <button class="button primary full" type="submit" ${isBusy('add') ? 'disabled' : ''}>${isBusy('add') ? 'Adding…' : 'Add hire'}</button></form>`;
}

function renderEmployee(employee) {
  const workflow = workflowFor(employee);
  const tasks = byWorkflow('tasks', workflow);
  const job = byWorkflow('jobs', workflow).at(-1);
  const judgment = byWorkflow('judgments', workflow).at(-1);
  const approval = byWorkflow('approvals', workflow).at(-1);
  const actions = byWorkflow('actions', workflow);
  const done = tasks.filter(task => ['done', 'approved', 'rejected'].includes(task.status)).length;
  return `<div class="person-card panel"><div class="person-top"><div class="person-avatar" aria-hidden="true">${escapeHtml(initials(employee.name))}</div><div class="person-title"><div class="eyebrow">Selected new hire</div><h2>${text(employee.name)}</h2><p>${text(employee.role)} · ${text(employee.location)}</p></div><span class="pill ${workflow ? 'sage' : 'quiet'}">${workflow ? pretty(workflow.status) : 'Not started'}</span></div>
    <dl class="facts"><div><dt>Start date</dt><dd>${compactDate(employee.startDate)}</dd></div><div><dt>Manager</dt><dd>${text(employee.manager)}</dd></div><div><dt>Work mode</dt><dd>${pretty(employee.workMode)}</dd></div></dl>
    ${!workflow ? `<div class="start-row"><p>Run the onboarding routine to create policy-backed tasks for this hire.</p><button class="button primary" type="button" data-action="onboard" data-id="${escapeHtml(employee.id)}" ${isBusy(`onboard:${employee.id}`) ? 'disabled' : ''}>${isBusy(`onboard:${employee.id}`) ? 'Starting…' : 'Start onboarding →'}</button></div>` : ''}</div>
    ${workflow ? `<section class="panel checklist"><div class="section-heading"><div><div class="eyebrow">Routine · ${text(all('routines').find(item => item.id === workflow.routineId)?.name, 'Onboarding')}</div><h2>Onboarding checklist</h2></div><span class="progress-label">${done} / ${tasks.length} resolved</span></div><progress class="progress-track" value="${done}" max="${Math.max(tasks.length, 1)}" aria-label="Checklist progress">${done} of ${tasks.length} resolved</progress>
      ${tasks.length ? `<div class="task-list">${tasks.map(renderTask).join('')}</div>` : `<div class="empty-state">No tasks were created for this workflow.</div>`}</section>
      ${renderJudgment(employee, workflow, job, judgment, approval)}
      ${actions.length ? `<section class="panel action-card"><div class="eyebrow">Safe local action</div><h2>Follow-up created</h2>${actions.map(action => `<div class="action-row"><span class="action-symbol" aria-hidden="true">✓</span><div><strong>${text(action.title)}</strong><p>Assigned to ${text(action.owner)} · ${dateTime(action.createdAt)}</p><small>Local task record only; no email or HR system change.</small></div></div>`).join('')}</section>` : ''}` : ''}`;
}

function renderTask(task) {
  const policy = policyFor(task);
  const complete = task.status === 'done';
  const canComplete = task.kind === 'checklist' && task.status === 'todo';
  return `<article class="task-row"><span class="task-state ${complete ? 'complete' : task.status === 'rejected' ? 'rejected' : task.status === 'awaiting_review' ? 'review' : ''}" aria-hidden="true">${complete || task.status === 'approved' ? '✓' : task.status === 'rejected' ? '×' : '·'}</span><div class="task-body"><div class="task-title-line"><h3>${text(task.title)}</h3><span class="task-status ${task.status}">${pretty(task.status)}</span></div><p>${text(task.details, '')}</p><div class="task-subline"><span>Owner: ${text(task.owner)}</span><span>Policy: ${policy ? `${text(policy.title)} · v${text(policy.version)}` : 'No policy linked'}</span></div>${policy ? `<div class="policy-rule">${text(policy.rule)}</div>` : ''}</div>${canComplete ? `<button class="button small subtle" type="button" data-action="complete-task" data-id="${escapeHtml(task.id)}" ${isBusy(`task:${task.id}`) ? 'disabled' : ''}>${isBusy(`task:${task.id}`) ? 'Saving…' : 'Mark done'}</button>` : ''}</article>`;
}

function renderJudgment(employee, workflow, job, judgment, approval) {
  if (!employee.exception) return '';
  const busyJob = job && ['queued', 'running'].includes(job.status);
  const failed = job?.status === 'failed';
  const canRun = !judgment && !busyJob;
  return `<section class="panel judgment-card"><div class="section-heading"><div><div class="eyebrow">Bounded local inference</div><h2>Exception routing</h2></div><span class="pill ${judgment ? 'sage' : failed ? 'rose' : busyJob ? 'amber' : 'quiet'}">${judgment ? 'Model result' : failed ? 'Job failed' : busyJob ? pretty(job.status) : 'Needs judgment'}</span></div>
    <div class="exception-quote"><span>Employee exception</span><p>${text(employee.exception)}</p></div>
    ${!judgment && health && !health.model?.available ? `<div class="model-notice" role="status"><strong>Local model unavailable</strong><p>${text(health.model?.error, 'Start Ollama and install the configured local model, then retry.')}</p></div>` : ''}
    ${judgment ? `<div class="result-grid"><div><small>Suggested route</small><strong>${pretty(judgment.route)}</strong></div><div><small>Model-reported confidence</small><strong>${Math.round(Number(judgment.confidence) * 100)}%</strong></div><div><small>Uncertainty</small><strong>${judgment.uncertain ? 'Flagged for review' : 'Not flagged'}</strong></div></div><p class="reason">${text(judgment.reason)}</p><p class="fine-print">Actual ${text(judgment.provider)} model run · ${text(judgment.model)} · ${Number(judgment.durationMs).toLocaleString()} ms. Confidence is model-reported and uncalibrated; policy and approval rules run in code.</p>` : ''}
    ${busyJob ? `<div class="job-state" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>${job.status === 'queued' ? 'Waiting to run locally' : 'Local model is reasoning'}</strong><p>Attempt ${job.attempts || 1}. This page will update when the durable job finishes.</p></div></div>` : ''}
    ${failed ? `<div class="inline-error" role="alert"><strong>Model run did not complete.</strong><p>${text(job.error, 'The local model returned an error.')}</p></div>` : ''}
    ${canRun ? `<div class="judgment-footer"><p>The exception is sent only to the configured local model.</p><button class="button primary" type="button" data-action="judge" data-id="${escapeHtml(workflow.id)}" ${isBusy(`judge:${workflow.id}`) ? 'disabled' : ''}>${isBusy(`judge:${workflow.id}`) ? 'Queueing…' : failed ? 'Retry local judgment' : 'Run local judgment →'}</button></div>` : ''}
    ${approval ? `<div class="review-note"><span class="review-icon" aria-hidden="true">!</span><div><strong>${approval.status === 'pending' ? 'Admin review requested' : `Admin ${approval.status}`}</strong><p>${approval.status === 'pending' ? 'An admin must decide before any follow-up action is created.' : `${text(approval.decidedBy)} · ${dateTime(approval.decidedAt)}${approval.reason ? ` · ${text(approval.reason)}` : ''}`}</p>${approval.status === 'pending' && data.session.role === 'coordinator' ? `<button class="text-button" type="button" data-action="switch-admin">Switch to admin demo persona →</button>` : ''}</div></div>` : ''}
  </section>`;
}

function renderApprovals() {
  const approvals = [...all('approvals')].sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || b.requestedAt.localeCompare(a.requestedAt));
  const pending = approvals.filter(item => item.status === 'pending').length;
  return `${pageHeading('Human review', 'Approvals', `${plural(pending, 'request')} waiting for a decision. Approval creates one safe local follow-up task.`)}
    <div class="content-stack">${data.session.role !== 'admin' ? `<div class="notice"><div><strong>Admin persona required</strong><p>Review requests are visible to coordinators; decisions are restricted to the demo admin persona.</p></div>${button('Switch to admin', 'switch-admin', 'subtle')}</div>` : ''}
    ${approvals.length ? approvals.map(renderApproval).join('') : `<div class="panel empty-state"><div class="empty-symbol">◎</div><h2>No review requests yet</h2><p>Run an exception judgment from a new hire’s checklist. Requests that need review will appear here.</p></div>`}</div>`;
}

function renderApproval(approval) {
  const workflow = all('workflows').find(item => item.id === approval.workflowId);
  const employee = employeeFor(workflow);
  const judgment = all('judgments').find(item => item.id === approval.judgmentId);
  const task = all('tasks').find(item => item.id === approval.taskId);
  const action = all('actions').find(item => item.approvalId === approval.id);
  const followUpOwner = {it: 'IT Operations', people_ops: 'People Operations', security: 'Security', uncertain: 'People Operations'}[judgment?.uncertain ? 'uncertain' : judgment?.route] || 'People Operations';
  return `<article class="panel approval-card"><div class="approval-head"><div><div class="eyebrow">${text(employee?.name)} · ${dateTime(approval.requestedAt)}</div><h2>${text(task?.title, 'Onboarding exception')}</h2></div><span class="pill ${approval.status === 'pending' ? 'amber' : approval.status === 'approved' ? 'sage' : 'rose'}">${pretty(approval.status)}</span></div>
    <p class="approval-exception">${text(employee?.exception, 'No exception text recorded.')}</p>
    <div class="approval-context"><div><small>Model suggestion</small><strong>${pretty(judgment?.route)}</strong></div><div><small>Reported confidence</small><strong>${judgment ? Math.round(Number(judgment.confidence) * 100) + '%' : '—'}</strong></div><div><small>Uncertain</small><strong>${judgment?.uncertain ? 'Yes' : 'No'}</strong></div></div>
    ${judgment ? `<p class="model-reason">${text(judgment.reason)}</p>` : ''}
    <p class="fine-print">Model confidence is uncalibrated and may be wrong. Approval creates only an internal follow-up task for ${text(followUpOwner)}.</p>
    ${approval.status === 'pending' && data.session.role === 'admin' ? `<form class="decision-form" data-approval-id="${escapeHtml(approval.id)}"><label for="reason-${escapeHtml(approval.id)}">Decision reason <span class="required">required</span></label><textarea id="reason-${escapeHtml(approval.id)}" name="reason" rows="2" required minlength="3" placeholder="Record why this decision is appropriate"></textarea><div class="decision-actions"><button class="button primary" type="submit" name="decision" value="approved" ${isBusy(`approval:${approval.id}`) ? 'disabled' : ''}>Approve & create local task</button><button class="button danger-outline" type="submit" name="decision" value="rejected" ${isBusy(`approval:${approval.id}`) ? 'disabled' : ''}>Reject</button></div></form>` : ''}
    ${approval.status !== 'pending' ? `<div class="decision-record"><strong>${pretty(approval.status)} by ${text(approval.decidedBy)}</strong><span>${dateTime(approval.decidedAt)}</span><p>Reason: ${text(approval.reason)}</p>${action ? `<p>Local task created: ${text(action.title)} · ${text(action.owner)}</p>` : `<p>No follow-up action was created.</p>`}</div>` : ''}
  </article>`;
}

function renderAudit() {
  const entries = [...all('audit')].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `${pageHeading('Durable history', 'Audit trail', 'A local record of workflow activity, approvals, and created follow-up tasks.')}
    <div class="audit-intro"><span class="status-dot ok"></span> ${plural(entries.length, 'entry')} saved in local storage. Entries remain after the app restarts.</div>
    <div class="panel audit-panel">${entries.length ? entries.map(entry => {
      const workflow = all('workflows').find(item => item.id === entry.workflowId);
      const employee = employeeFor(workflow);
      return `<article class="audit-entry"><div class="audit-marker" aria-hidden="true"></div><div class="audit-main"><div class="audit-title"><strong>${pretty(entry.action)}</strong><time datetime="${escapeHtml(entry.createdAt)}">${dateTime(entry.createdAt)}</time></div><p>${text(employee?.name, 'System')} · ${text(entry.actor, 'System')}</p>${entry.details && Object.keys(entry.details).length ? `<pre>${escapeHtml(JSON.stringify(entry.details, null, 2))}</pre>` : ''}</div></article>`;
    }).join('') : `<div class="empty-state"><h2>No activity yet</h2><p>Start an onboarding routine to create the first audit entry.</p></div>`}</div>`;
}

async function mutate(key, path, body, success, after, form = null) {
  if (busy.has(key)) return;
  busy.add(key);
  if (form) {
    form.setAttribute('aria-busy', 'true');
    form.querySelectorAll('[type="submit"]').forEach(button => button.disabled = true);
  } else renderSafely();
  try {
    const result = await request(path, {method: 'POST', body: JSON.stringify(body)});
    if (after) after(result);
    if (form?.contains(document.activeElement)) document.activeElement.blur();
    if (form?.classList.contains('decision-form')) approvalFormEngaged = false;
    await refresh({quiet: true});
    if (success) message(success);
  } catch (error) { message(error.message, 'error'); }
  finally {
    busy.delete(key);
    if (form) {
      form.removeAttribute('aria-busy');
      form.querySelectorAll('[type="submit"]').forEach(button => button.disabled = false);
    } else renderSafely();
  }
}

app.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]');
  if (nav) { view = nav.dataset.view; addingHire = false; approvalFormEngaged = false; render(); return; }
  const employee = event.target.closest('[data-employee-id]');
  if (employee) { selectedEmployeeId = employee.dataset.employeeId; addingHire = false; approvalFormEngaged = false; render(); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const id = target.dataset.id;
  switch (target.dataset.action) {
    case 'retry-load': refresh(); refreshHealth(); break;
    case 'toggle-add': addingHire = !addingHire; render(); if (addingHire) document.querySelector('#add-hire-form input')?.focus(); break;
    case 'onboard': mutate(`onboard:${id}`, `/api/employees/${encodeURIComponent(id)}/onboard`, {}, 'Onboarding routine started.'); break;
    case 'complete-task': mutate(`task:${id}`, `/api/tasks/${encodeURIComponent(id)}/complete`, {}, 'Checklist task completed.'); break;
    case 'judge': mutate(`judge:${id}`, `/api/workflows/${encodeURIComponent(id)}/judgment`, {}, 'Local model job queued.'); break;
    case 'switch-admin': switchRole('admin', 'approvals'); break;
  }
});

app.addEventListener('change', event => {
  if (event.target.id === 'role-select') switchRole(event.target.value);
});

async function switchRole(role, nextView = view) {
  const previous = data.session.role;
  try {
    await request('/api/session', {method: 'POST', body: JSON.stringify({role})});
    view = nextView;
    addingHire = false;
    approvalFormEngaged = false;
    await refresh({quiet: true});
    message(`Demo persona switched to ${role === 'admin' ? 'Maya Chen (admin)' : 'Jordan Lee (coordinator)'}.`);
  } catch (error) { message(error.message, 'error'); document.querySelector('#role-select').value = previous; }
}

app.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'add-hire-form') {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    mutate('add', '/api/employees', values, 'Fictional hire added.', result => { selectedEmployeeId = result.employee.id; addingHire = false; }, form);
  }
  if (form.matches('.decision-form')) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const decision = event.submitter?.value || form.querySelector('button[type="submit"]')?.value;
    if (!['approved', 'rejected'].includes(decision)) return;
    const id = form.dataset.approvalId;
    const reason = form.elements.reason.value.trim();
    if (!reason) { form.elements.reason.setCustomValidity('Enter a decision reason.'); form.reportValidity(); return; }
    form.elements.reason.setCustomValidity('');
    mutate(`approval:${id}`, `/api/approvals/${encodeURIComponent(id)}/decision`, {decision, reason}, decision === 'approved' ? 'Approved. One local follow-up task was created.' : 'Rejected. No follow-up action was created.', null, form);
  }
});

app.addEventListener('input', event => { if (event.target.name === 'reason') event.target.setCustomValidity(''); });
app.addEventListener('focusin', event => { if (event.target.closest('.decision-form')) approvalFormEngaged = true; });

await refresh();
refreshHealth();
setInterval(() => {
  if (all('jobs').some(job => ['queued', 'running'].includes(job.status))) refresh({quiet: true});
}, 1800);
setInterval(() => refreshHealth(), 30000);

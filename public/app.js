const app = document.querySelector('#app');
const toast = document.querySelector('#toast');

let data = null;
let health = null;
let evaluation = null;
let selectedEmployeeId = null;
let view = 'overview';
let addingHire = false;
let approvalFormEngaged = false;
const busy = new Set();
let toastTimer;

const ROUTES = { it: 'IT Operations', people_ops: 'People Ops', payroll: 'Payroll & Benefits', security: 'Security', uncertain: 'Needs a human' };
const OWNERS = { it: 'IT Operations', people_ops: 'People Operations', payroll: 'Payroll & Benefits', security: 'Security', uncertain: 'People Operations' };
const CATEGORIES = { workspace_setup: 'Workspace setup', compensation: 'Compensation', expense_refund: 'Expense / refund', leave_life_event: 'Leave / life event', schedule_change: 'Schedule change', complaint: 'Complaint', policy_info: 'Policy question', access_request: 'Access request' };
const VIEWS = { overview: 'Overview', hires: 'New hires', approvals: 'Approvals', activity: 'Activity', engine: 'Decision engine' };

const icons = {
  overview: '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  hires: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>',
  approvals: '<path d="M4 12.5l5 5L20 6.5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  engine: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/>',
};
const icon = name => `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const compactDate = value => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)) : '—';
const dateTime = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const relative = value => {
  const seconds = Math.round((Date.now() - new Date(value).valueOf()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  const [size, unit] = units.find(([s]) => seconds >= s);
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
};
const pretty = value => String(value ?? '').replace(/[_.-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const text = (value, fallback = '—') => escapeHtml(value || fallback);
const pct = value => value === null || value === undefined ? '—' : `${Math.round(Number(value) * 100)}%`;
const plural = (count, noun) => `${count} ${count === 1 ? noun : noun === 'person' ? 'people' : noun === 'entry' ? 'entries' : `${noun}s`}`;
const all = name => data?.[name] || [];
const employeeFor = workflow => all('employees').find(employee => employee.id === workflow?.employeeId);
const workflowFor = employee => all('workflows').find(workflow => workflow.employeeId === employee?.id);
const byWorkflow = (name, workflow) => all(name).filter(item => item.workflowId === workflow?.id);
const policyFor = task => all('policies').find(policy => policy.id === task.policyId);
const selectedEmployee = () => all('employees').find(employee => employee.id === selectedEmployeeId) || all('employees')[0];
const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(word => word[0]?.toUpperCase()).join('');
const isAdmin = () => data?.session?.role === 'admin';
const bar = value => `<span class="bar"><i data-w="${Math.max(0, Math.min(100, Number(value) * 100)).toFixed(1)}"></i></span>`;

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
      ...(options.method === 'POST' ? { 'content-type': 'application/json', 'x-csrf-token': data?.session?.csrfToken || '' } : {}),
      ...(options.headers || {}),
    },
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Request failed (${response.status}).`); }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

async function refresh({ quiet = false } = {}) {
  try {
    const next = await request('/api/state');
    const previous = data;
    data = next;
    if (!selectedEmployeeId || !all('employees').some(employee => employee.id === selectedEmployeeId)) selectedEmployeeId = all('employees')[0]?.id || null;
    if (previous) {
      for (const job of next.jobs || []) {
        const before = (previous.jobs || []).find(item => item.id === job.id);
        if (before && before.status !== job.status && ['succeeded', 'failed'].includes(job.status)) {
          message(job.status === 'succeeded' ? 'Agent decision ready for review.' : `Decision failed: ${job.error || 'Unknown error'}`, job.status === 'failed' ? 'error' : 'success');
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
  catch (error) { health = { model: { available: false, error: error.message }, providers: [] }; }
  renderSafely();
}

async function refreshEvaluation() {
  try { evaluation = await request('/api/evaluation'); } catch { evaluation = { runs: [] }; }
  renderSafely();
}

function showFatal(error) {
  app.innerHTML = `<div class="fatal"><div class="eyebrow">NodFirst could not open</div><h1>Connection needed</h1><p>${text(error.message)}</p><div><button class="button primary" data-action="retry-load">Try again</button></div></div>`;
}

function renderSafely() {
  if (!data) return;
  if (addingHire || (view === 'approvals' && approvalFormEngaged)) return;
  render();
}

function applyWidths() {
  requestAnimationFrame(() => document.querySelectorAll('[data-w]').forEach(el => { el.style.width = `${el.dataset.w}%`; }));
}

function navLink(key, count = '', attention = false) {
  const active = view === key;
  return `<button class="nav-link ${active ? 'active' : ''}" type="button" data-view="${key}" ${active ? 'aria-current="page"' : ''}>${icon(key)}<span>${VIEWS[key]}</span>${count !== '' ? `<span class="nav-count ${attention ? 'attention' : ''}">${count}</span>` : ''}</button>`;
}

function render() {
  const pending = all('approvals').filter(item => item.status === 'pending').length;
  const model = health?.model;
  const dot = !health ? '' : model?.available ? 'ok' : 'bad';
  const role = data.session.role;
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><div class="brand-mark" aria-hidden="true"><span></span></div><div><strong>NodFirst</strong><small>HR agent · ${text(data.company?.name)}</small></div></div>
      <nav class="nav" aria-label="Primary">
        <div class="nav-label">Workspace</div>
        ${navLink('overview')}
        ${navLink('hires', all('employees').length)}
        ${navLink('approvals', pending, pending > 0)}
        <div class="nav-label">Records</div>
        ${navLink('activity')}
        ${navLink('engine')}
      </nav>
      <div class="sidebar-foot">
        <button class="engine-chip" type="button" data-view="engine"><small>Decision engine</small><strong><span class="dot ${dot}"></span>${text(model?.label || model?.provider, 'Checking…')}</strong><span class="model">${text(model?.model, '')}</span></button>
        <p class="sidebar-note">Synthetic demo company. The agent proposes; a human approves every exception. Actions are local records only.</p>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="crumbs"><span class="crumb-root">People operations</span><span aria-hidden="true" class="crumb-root">/</span><strong>${VIEWS[view]}</strong></div>
        <div class="persona"><span>Acting as</span><label class="sr-only" for="role-select">Demo persona</label><select id="role-select"><option value="coordinator" ${role === 'coordinator' ? 'selected' : ''}>Jordan Lee · coordinator</option><option value="admin" ${role === 'admin' ? 'selected' : ''}>Maya Chen · admin</option></select></div>
      </header>
      <main id="main-content">${({ overview: renderOverview, hires: renderHires, approvals: renderApprovals, activity: renderActivity, engine: renderEngine })[view]()}</main>
    </div>`;
  applyWidths();
}

function pageHead(kicker, title, description, suffix = '') {
  return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${suffix}</div>`;
}

/* Overview */
function renderOverview() {
  const workflows = all('workflows');
  const pending = all('approvals').filter(item => item.status === 'pending');
  const failed = all('jobs').filter(job => job.status === 'failed');
  const needsRun = workflows.filter(workflow => byWorkflow('tasks', workflow).some(task => task.kind === 'exception' && task.status === 'needs_judgment') && !byWorkflow('jobs', workflow).some(job => ['queued', 'running'].includes(job.status)));
  const attention = [
    ...pending.map(approval => { const employee = employeeFor(all('workflows').find(w => w.id === approval.workflowId)); const judgment = all('judgments').find(j => j.id === approval.judgmentId); return { id: employee?.id, pill: '<span class="pill amber">Approve</span>', title: `${employee?.name || 'Hire'} · ${ROUTES[judgment?.route] || 'exception'}`, sub: employee?.exception, go: 'approvals' }; }),
    ...failed.map(job => { const employee = employeeFor(all('workflows').find(w => w.id === job.workflowId)); return { id: employee?.id, pill: '<span class="pill red">Failed</span>', title: `${employee?.name || 'Hire'} · decision failed`, sub: job.error, go: 'hires' }; }),
    ...needsRun.map(workflow => { const employee = employeeFor(workflow); return { id: employee?.id, pill: '<span class="pill violet">Run agent</span>', title: `${employee?.name} · exception needs a decision`, sub: employee?.exception, go: 'hires' }; }),
  ];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const recent = [...all('audit')].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 7);
  return `${pageHead('Overview', `${greeting}, ${isAdmin() ? 'Maya' : 'Jordan'}`, 'NodFirst runs onboarding checklists and routes every exception through a typed decision model. Nothing leaves review without a person.', `<button class="button primary" type="button" data-action="new-hire">New hire</button>`)}
    <div class="kpis">
      <div class="panel kpi"><small>Active onboardings</small><strong>${workflows.filter(w => w.status === 'active').length}</strong><span>${workflows.filter(w => w.status === 'complete').length} completed</span></div>
      <div class="panel kpi"><small>Awaiting approval</small><strong>${pending.length}</strong><span>human decision required</span></div>
      <div class="panel kpi"><small>Agent decisions</small><strong>${all('judgments').length}</strong><span>${all('judgments').filter(j => j.uncertain).length} flagged uncertain</span></div>
      <div class="panel kpi"><small>Actions taken</small><strong>${all('actions').length}</strong><span>local follow-up records</span></div>
    </div>
    <div class="overview-grid">
      <section class="panel" aria-label="Needs attention"><div class="panel-head"><h2>Needs your attention</h2><span class="pill">${attention.length}</span></div>
        ${attention.length ? attention.map(item => `<button class="attention-row" type="button" data-go="${item.go}" data-employee="${escapeHtml(item.id || '')}">${item.pill}<div><strong>${text(item.title)}</strong><small>${text(item.sub, '')}</small></div><span class="muted" aria-hidden="true">→</span></button>`).join('') : `<div class="empty"><strong>All clear</strong><p>No approvals, failed runs, or pending exceptions.</p></div>`}
      </section>
      <section class="panel" aria-label="Recent activity"><div class="panel-head"><h2>Agent activity</h2><button class="link-button" type="button" data-view="activity">View all</button></div>
        <div class="feed">${recent.length ? recent.map(entry => feedItem(entry, false)).join('') : `<div class="empty"><strong>No activity yet</strong><p>Start an onboarding to see the agent work.</p></div>`}</div>
      </section>
    </div>`;
}

/* Hires */
function renderHires() {
  const employee = selectedEmployee();
  const employees = all('employees');
  return `${pageHead('People / Onboarding', 'New hires', 'Run the onboarding routine, let the agent classify exceptions, and keep the full record in one place.', `<button class="button primary" type="button" data-action="toggle-add">${addingHire ? 'Close form' : 'New hire'}</button>`)}
    <div class="hires-layout">
      <section class="panel queue" aria-label="New hire queue"><div class="panel-head"><h2>Queue</h2><span class="pill">${plural(employees.length, 'person')}</span></div>
        ${addingHire ? renderAddForm() : ''}
        <div class="queue-list">${employees.length ? employees.map(item => {
          const workflow = workflowFor(item);
          const pendingApproval = workflow && byWorkflow('approvals', workflow).some(a => a.status === 'pending');
          const status = !workflow ? '<span class="pill">Not started</span>' : pendingApproval ? '<span class="pill amber">Review</span>' : workflow.status === 'complete' ? '<span class="pill green">Done</span>' : '<span class="pill blue">Active</span>';
          return `<button type="button" class="queue-item ${employee?.id === item.id ? 'selected' : ''}" data-employee-id="${escapeHtml(item.id)}" ${employee?.id === item.id ? 'aria-current="true"' : ''}><span class="avatar" aria-hidden="true">${escapeHtml(initials(item.name))}</span><span class="queue-copy"><strong>${text(item.name)}</strong><small>${text(item.role)} · ${text(item.location)}</small></span><span class="queue-status">${status}</span></button>`;
        }).join('') : `<div class="empty"><strong>No hires yet</strong><p>Add a fictional new hire to begin.</p></div>`}</div>
      </section>
      <section class="stack" aria-label="Selected hire">${employee ? renderEmployee(employee) : `<div class="panel empty"><h2>Select a hire</h2><p>Choose a person in the queue or add one.</p></div>`}</section>
    </div>`;
}

function renderAddForm() {
  return `<form id="add-hire-form" class="add-form"><div class="form-heading"><strong>New fictional hire</strong><button class="icon-button" type="button" data-action="toggle-add" aria-label="Close form">×</button></div>
    <label>Full name<input name="name" required autocomplete="off" placeholder="Avery Rivera"></label>
    <label>Role<input name="role" required placeholder="Product Designer"></label>
    <div class="form-grid"><label>Location<input name="location" required placeholder="Portland, OR"></label><label>Start date<input name="startDate" required type="date"></label></div>
    <label>Manager<input name="manager" required placeholder="Morgan Ellis"></label>
    <label>Work mode<select name="workMode" required><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="office">Office</option></select></label>
    <label>Request or exception <span class="optional">optional</span><textarea name="exception" rows="3" placeholder="Anything that needs a decision: equipment, pay, leave, access…"></textarea></label>
    <p class="form-hint">Use synthetic information only. Names and dates are never sent to the decision provider.</p>
    <button class="button primary full" type="submit" ${busy.has('add') ? 'disabled' : ''}>${busy.has('add') ? 'Adding…' : 'Add hire'}</button></form>`;
}

function renderEmployee(employee) {
  const workflow = workflowFor(employee);
  const tasks = byWorkflow('tasks', workflow);
  const job = byWorkflow('jobs', workflow).at(-1);
  const judgment = byWorkflow('judgments', workflow).at(-1);
  const approval = byWorkflow('approvals', workflow).at(-1);
  const actions = byWorkflow('actions', workflow);
  const done = tasks.filter(task => ['done', 'approved', 'rejected'].includes(task.status)).length;
  const onboardKey = `onboard:${employee.id}`;
  return `<div class="panel panel-pad"><div class="person-head"><span class="avatar large" aria-hidden="true">${escapeHtml(initials(employee.name))}</span><div><h2>${text(employee.name)}</h2><p>${text(employee.role)} · ${text(employee.location)}</p></div><span class="pill ${workflow ? (workflow.status === 'complete' ? 'green' : 'blue') : ''}">${workflow ? pretty(workflow.status) : 'Not started'}</span></div>
      <dl class="facts"><div><dt>Start date</dt><dd>${compactDate(employee.startDate)}</dd></div><div><dt>Manager</dt><dd>${text(employee.manager)}</dd></div><div><dt>Work mode</dt><dd>${pretty(employee.workMode)}</dd></div></dl>
      ${!workflow ? `<div class="start-row"><span>Run the onboarding routine to create policy-backed tasks${employee.exception ? ' and queue the exception for a decision' : ''}.</span><button class="button primary" type="button" data-action="onboard" data-id="${escapeHtml(employee.id)}" ${busy.has(onboardKey) ? 'disabled' : ''}>${busy.has(onboardKey) ? 'Starting…' : 'Start onboarding'}</button></div>` : ''}
    </div>
    ${workflow ? `<section class="panel panel-pad"><div class="section-title"><div><div class="eyebrow">Routine · ${text(all('routines').find(item => item.id === workflow.routineId)?.name, 'Onboarding')}</div><h2>Checklist</h2></div><span class="muted mono">${done}/${tasks.length}</span></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${tasks.length}" aria-valuenow="${done}" aria-label="Checklist progress"><i data-w="${tasks.length ? (done / tasks.length * 100).toFixed(1) : 0}"></i></div>
        <div class="task-list">${tasks.map(renderTask).join('')}</div></section>
      ${renderDecision(employee, workflow, job, judgment, approval)}
      ${actions.length ? `<section class="panel panel-pad"><div class="section-title"><div><div class="eyebrow">Action record</div><h2>Follow-up created</h2></div><span class="pill green">Approved</span></div>${actions.map(action => renderAction(action, approval, judgment)).join('')}</section>` : ''}` : ''}`;
}

function renderTask(task) {
  const policy = policyFor(task);
  const state = task.status === 'done' || task.status === 'approved' ? 'done' : task.status === 'rejected' ? 'rejected' : task.status === 'awaiting_review' ? 'review' : '';
  const pill = { todo: '', done: '', needs_judgment: '<span class="pill violet">Needs decision</span>', awaiting_review: '<span class="pill amber">Awaiting review</span>', approved: '<span class="pill green">Approved</span>', rejected: '<span class="pill red">Rejected</span>' }[task.status] || '';
  const canComplete = task.kind === 'checklist' && task.status === 'todo';
  const key = `task:${task.id}`;
  return `<article class="task"><span class="check ${state}" aria-hidden="true">${state === 'done' ? '✓' : state === 'rejected' ? '×' : ''}</span><div><h3>${text(task.title)} ${pill}</h3><p>${text(task.kind === 'exception' ? 'Routed through the decision engine and admin review.' : task.details, '')}</p><div class="task-meta"><span>Owner <b>${text(task.owner)}</b></span><span>Policy <b>${policy ? `${text(policy.title)} v${text(policy.version)}` : '—'}</b></span></div></div>${canComplete ? `<button class="button small" type="button" data-action="complete-task" data-id="${escapeHtml(task.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? 'Saving…' : 'Mark done'}</button>` : ''}</article>`;
}

function distribution(judgment) {
  const probabilities = judgment.probabilities || { [judgment.route]: judgment.confidence };
  const rows = Object.keys(ROUTES).filter(key => probabilities[key] !== undefined).sort((a, b) => probabilities[b] - probabilities[a]);
  return `<div class="dist" aria-label="Route probabilities">${rows.map(key => `<div class="dist-row ${key === judgment.route ? 'top' : ''}"><span>${ROUTES[key]}</span>${bar(probabilities[key])}<output>${pct(probabilities[key])}</output></div>`).join('')}
    ${judgment.probabilities ? '' : '<p class="fine">This provider reports only the chosen route’s confidence, not a full distribution.</p>'}</div>`;
}

function renderDecision(employee, workflow, job, judgment, approval) {
  if (!employee.exception) return '';
  const running = job && ['queued', 'running'].includes(job.status);
  const failed = job?.status === 'failed';
  const provider = health?.model;
  const key = `judge:${workflow.id}`;
  const status = judgment ? (judgment.uncertain ? '<span class="pill amber">Flagged uncertain</span>' : '<span class="pill violet">Decided</span>') : failed ? '<span class="pill red">Failed</span>' : running ? `<span class="pill blue">${pretty(job.status)}</span>` : '<span class="pill">Not run</span>';
  return `<section class="panel decision"><div class="decision-top"><div><div class="eyebrow">Agent decision · typed</div><h2>Exception routing</h2></div>${status}</div>
    <div class="decision-body">
      <div class="quote"><small>Employee request</small>${text(employee.exception)}</div>
      ${judgment ? `<div class="decision-grid">
          <div><div class="eyebrow">Route · who owns the follow-up</div>${distribution(judgment)}</div>
          <div class="facet-list">
            <div class="facet"><small>Category</small><strong>${text(CATEGORIES[judgment.category], pretty(judgment.category) || '—')}</strong>${judgment.categoryConfidence !== null && judgment.categoryConfidence !== undefined ? `<small>${pct(judgment.categoryConfidence)} confidence</small>` : ''}</div>
            <div class="facet"><small>Sensitive · handle confidentially</small><strong>${judgment.sensitive === null || judgment.sensitive === undefined ? '—' : `${pct(judgment.sensitive)} ${judgment.sensitive >= 0.5 ? 'likely' : 'unlikely'}`}</strong>${judgment.sensitive !== null && judgment.sensitive !== undefined ? bar(judgment.sensitive) : ''}</div>
          </div>
        </div>
        <p class="rationale"><b>Rationale.</b> ${text(judgment.reason)}</p>
        <div class="run-meta"><span>${text(judgment.provider)}</span><span>${text(judgment.model)}</span><span>${Number(judgment.durationMs).toLocaleString()} ms</span><span>floor ${pct(0.75)}</span></div>` : ''}
      ${!judgment && provider && !provider.available ? `<div class="callout error"><div><strong>${text(provider.label || provider.provider)} unavailable</strong><p>${text(provider.error, 'Configure the provider, then retry.')}</p><button class="link-button" type="button" data-view="engine">Open decision engine →</button></div></div>` : ''}
      ${running ? `<div class="callout info"><span class="spinner" aria-hidden="true"></span><div><strong>${job.status === 'queued' ? 'Queued' : 'Deciding'}</strong><p>Attempt ${job.attempts || 1}. The durable job survives restarts; this page updates when it finishes.</p></div></div>` : ''}
      ${failed ? `<div class="callout error"><div><strong>The decision did not complete</strong><p>${text(job.error, 'The provider returned an error.')}</p></div></div>` : ''}
      ${!judgment && !running ? `<div class="run-row"><span>Only role, location, work mode, request text and policy references are sent to <b>${text(provider?.label || provider?.provider, 'the active provider')}</b>.</span><button class="button accent" type="button" data-action="judge" data-id="${escapeHtml(workflow.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? 'Queueing…' : failed ? 'Retry decision' : 'Run agent decision'}</button></div>` : ''}
      ${approval ? `<div class="callout ${approval.status === 'pending' ? '' : approval.status === 'approved' ? 'ok' : 'error'}"><div><strong>${approval.status === 'pending' ? 'Waiting for an admin' : `Admin ${approval.status}`}</strong><p>${approval.status === 'pending' ? 'Every exception needs a human decision before any follow-up is created, whatever the confidence.' : `${text(approval.decidedBy)} · ${dateTime(approval.decidedAt)} · “${text(approval.reason)}”`}</p>${approval.status === 'pending' ? (isAdmin() ? `<button class="link-button" type="button" data-view="approvals">Review in Approvals →</button>` : `<button class="link-button" type="button" data-action="switch-admin">Switch to admin persona →</button>`) : ''}</div></div>` : ''}
    </div></section>`;
}

function renderAction(action, approval, judgment) {
  return `<div class="action-row"><span class="feed-icon human" aria-hidden="true">✓</span><div><strong>${text(action.title)}</strong><p class="muted">${dateTime(action.createdAt)} · local task record; no email, payroll, or HRIS change.</p>
    <div class="scope"><div><small>Identity</small><span>${text(approval?.decidedBy)}</span></div><div><small>Scope</small><span>${text(action.owner)} follow-up</span></div><div><small>Rationale</small><span>${text(approval?.reason)}</span></div></div>
    ${judgment ? `<p class="fine spaced">Agent suggested ${text(ROUTES[judgment.route])} at ${pct(judgment.confidence)}.</p>` : ''}</div></div>`;
}

/* Approvals */
function renderApprovals() {
  const approvals = [...all('approvals')].sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || b.requestedAt.localeCompare(a.requestedAt));
  const pending = approvals.filter(item => item.status === 'pending').length;
  return `${pageHead('Human review', 'Approvals', `${plural(pending, 'request')} waiting. Approving creates exactly one local follow-up task; rejecting creates none.`)}
    <div class="stack">${!isAdmin() ? `<div class="callout info"><div><strong>Admin persona required</strong><p>Coordinators can see requests; only the demo admin can decide them.</p><button class="button small" type="button" data-action="switch-admin">Switch to admin</button></div></div>` : ''}
    ${approvals.length ? approvals.map(renderApproval).join('') : `<div class="panel empty"><h2>No review requests yet</h2><p>Run an agent decision on a new hire’s exception. It will land here for a human.</p></div>`}</div>`;
}

function renderApproval(approval) {
  const workflow = all('workflows').find(item => item.id === approval.workflowId);
  const employee = employeeFor(workflow);
  const judgment = all('judgments').find(item => item.id === approval.judgmentId);
  const action = all('actions').find(item => item.approvalId === approval.id);
  const owner = OWNERS[judgment?.uncertain ? 'uncertain' : judgment?.route] || 'People Operations';
  const key = `approval:${approval.id}`;
  return `<article class="panel approval"><div class="approval-head"><div><div class="eyebrow">${text(employee?.name)} · requested ${relative(approval.requestedAt)}</div><h2>${text(ROUTES[judgment?.route], 'Exception')} · ${text(CATEGORIES[judgment?.category], 'uncategorized')}</h2></div><span class="pill ${approval.status === 'pending' ? 'amber' : approval.status === 'approved' ? 'green' : 'red'}">${pretty(approval.status)}</span></div>
    <div class="approval-body">
      <div class="quote"><small>Employee request</small>${text(employee?.exception, 'No request text recorded.')}</div>
      ${judgment ? `<div class="decision-grid">${distribution(judgment)}<div class="facet-list"><div class="facet"><small>Sensitive</small><strong>${pct(judgment.sensitive)}</strong>${judgment.sensitive !== null && judgment.sensitive !== undefined ? bar(judgment.sensitive) : ''}</div><div class="facet"><small>Follow-up owner if approved</small><strong>${text(owner)}</strong>${judgment.uncertain ? '<small>Uncertain, so it defaults to People Operations</small>' : ''}</div></div></div>
      <p class="rationale"><b>Agent rationale.</b> ${text(judgment.reason)}</p><div class="run-meta"><span>${text(judgment.provider)}</span><span>${text(judgment.model)}</span><span>${Number(judgment.durationMs).toLocaleString()} ms</span></div>` : ''}
      ${approval.status === 'pending' && isAdmin() ? `<form class="decision-form" data-approval-id="${escapeHtml(approval.id)}"><label for="reason-${escapeHtml(approval.id)}">Decision rationale <span class="required">required</span></label><textarea id="reason-${escapeHtml(approval.id)}" name="reason" rows="2" required minlength="3" placeholder="Why is this the right call? This is recorded with the action."></textarea><div class="decision-actions"><button class="button primary" type="submit" name="decision" value="approved" ${busy.has(key) ? 'disabled' : ''}>Approve & create task</button><button class="button danger" type="submit" name="decision" value="rejected" ${busy.has(key) ? 'disabled' : ''}>Reject</button></div></form>` : ''}
      ${approval.status !== 'pending' ? `<div class="decision-record"><strong>${pretty(approval.status)} by ${text(approval.decidedBy)}</strong> · ${dateTime(approval.decidedAt)}<br>Rationale: ${text(approval.reason)}<br>${action ? `Created: ${text(action.title)} → ${text(action.owner)}` : 'No follow-up action was created.'}</div>` : ''}
    </div></article>`;
}

/* Activity */
const ACTION_LABELS = {
  'employee.added': ['Hire added', ''], 'onboarding.started': ['Onboarding started', 'agent'], 'checklist.completed': ['Checklist item completed', ''],
  'model.queued': ['Decision queued', 'agent'], 'model.completed': ['Agent decided', 'agent'], 'model.failed': ['Decision failed', 'alert'], 'model.recovered': ['Decision resumed', 'agent'],
  'approval.requested': ['Approval requested', 'agent'], 'approval.approved': ['Approved by a human', 'human'], 'approval.rejected': ['Rejected by a human', 'alert'],
  'action.created': ['Follow-up created', 'human'], 'provider.changed': ['Decision engine switched', ''],
};

function feedItem(entry, expanded = true) {
  const workflow = all('workflows').find(item => item.id === entry.workflowId);
  const employee = employeeFor(workflow) || all('employees').find(item => item.id === entry.details?.employeeId);
  const [label, kind] = ACTION_LABELS[entry.action] || [pretty(entry.action), ''];
  const d = entry.details || {};
  const chips = [];
  if (d.route) chips.push(`route=${d.route}`);
  if (d.confidence !== undefined) chips.push(`p=${Number(d.confidence).toFixed(2)}`);
  if (d.category) chips.push(d.category);
  if (d.provider) chips.push(d.provider);
  if (d.owner) chips.push(`owner=${d.owner}`);
  if (d.to) chips.push(`${d.from} → ${d.to}`);
  const glyph = { agent: '◆', human: '✓', alert: '!' }[kind] || '·';
  const why = d.reason || d.error || d.title || '';
  return `<article class="feed-item"><span class="feed-icon ${kind}" aria-hidden="true">${glyph}</span><div><div class="feed-top"><strong>${label}${employee ? ` · ${text(employee.name)}` : ''}</strong><time datetime="${escapeHtml(entry.createdAt)}" title="${escapeHtml(dateTime(entry.createdAt))}">${relative(entry.createdAt)}</time></div><p>${text(entry.actor, 'System')}${why ? ` — ${text(why)}` : ''}</p>${chips.length ? `<div class="feed-meta">${chips.map(chip => `<span>${text(chip)}</span>`).join('')}</div>` : ''}${expanded && Object.keys(d).length ? `<details><summary>Record</summary><pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>` : ''}</div></article>`;
}

function renderActivity() {
  const entries = [...all('audit')].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `${pageHead('Durable history', 'Activity', 'Every step the agent and people took: who acted, what changed, and why. Append-only; it survives restarts.')}
    <section class="panel"><div class="panel-head"><h2>${plural(entries.length, 'entry')}</h2><span class="pill">SQLite · append-only</span></div><div class="feed">${entries.length ? entries.map(entry => feedItem(entry)).join('') : `<div class="empty"><strong>No activity yet</strong></div>`}</div></section>`;
}

/* Decision engine */
function renderEngine() {
  const providers = health?.providers || [];
  return `${pageHead('Configuration', 'Decision engine', 'Choose which model answers the typed routing questions. Hosted providers need an API key in the server environment; keys are never entered in the browser.')}
    <div class="stack">
      <div class="provider-grid">${providers.length ? providers.map(renderProvider).join('') : '<div class="panel empty"><strong>Checking providers…</strong></div>'}</div>
      ${!isAdmin() ? '<p class="fine">Switch to the admin persona to change the active provider.</p>' : ''}
      ${renderEvaluation()}
    </div>`;
}

function renderProvider(item) {
  const state = item.available ? '<span class="pill green">Ready</span>' : item.configured ? '<span class="pill red">Unavailable</span>' : '<span class="pill">Not configured</span>';
  const kind = { api: 'Hosted API', local: 'Local model', offline: 'Offline · in-process' }[item.kind] || item.kind;
  const key = `provider:${item.name}`;
  return `<article class="panel provider ${item.active ? 'active' : ''}"><div class="provider-top"><h3>${text(item.label)}</h3>${item.active ? '<span class="pill violet">Active</span>' : state}</div>
    <p>${kind}</p><div class="mono">${text(item.model)}</div>
    <p>${text(item.available ? item.note : item.error || item.setup, '')}</p>
    ${!item.available && item.setup ? `<p class="fine">${text(item.setup)}</p>` : ''}
    <div class="provider-foot">${item.active ? state : `<button class="button small" type="button" data-action="use-provider" data-id="${escapeHtml(item.name)}" ${!isAdmin() || !item.configured || busy.has(key) ? 'disabled' : ''}>Use this provider</button>`}</div></article>`;
}

function renderEvaluation() {
  const runs = evaluation?.runs || [];
  if (!runs.length) return `<section class="panel"><div class="panel-head"><h2>Evaluation</h2></div><div class="empty"><strong>No evaluation yet</strong><p>Run <span class="mono">npm run eval</span> to score providers on the SAP HR request dataset.</p></div></section>`;
  const best = runs[0];
  const labels = best.confusion?.labels || [];
  return `<section class="panel"><div class="panel-head"><h2>Evaluation · ${text(evaluation.dataset?.name)}</h2><span class="pill">${text(evaluation.dataset?.size)} requests</span></div>
    <div class="table-wrap"><table class="eval-table"><thead><tr><th>Provider</th><th>Mode</th><th class="num">Route</th><th class="num">Category</th><th class="num">Sensitive</th><th class="num">Flagged</th><th class="num">Acc. unflagged</th><th class="num">ECE</th><th class="num">Latency</th></tr></thead>
    <tbody>${runs.map(run => `<tr><td>${text(run.label || run.provider)}<div class="fine mono">${text(run.model)}</div></td><td class="muted">${text(run.mode)}</td><td class="num">${pct(run.routeAccuracy)}</td><td class="num">${pct(run.categoryAccuracy)}</td><td class="num">${pct(run.sensitiveAccuracy)}</td><td class="num">${pct(run.flaggedRate)}</td><td class="num">${pct(run.accuracyWhenNotFlagged)}</td><td class="num">${run.ece === undefined ? '—' : Number(run.ece).toFixed(3)}</td><td class="num">${Math.round(run.meanLatencyMs)} ms</td></tr>`).join('')}</tbody></table></div>
    ${labels.length ? `<div class="panel-head"><h2>Category confusion · ${text(best.label || best.provider)}</h2><span class="fine">rows = dataset label, columns = prediction</span></div>
    <div class="table-wrap"><table class="eval-table matrix"><thead><tr><th></th>${labels.map(label => `<th title="${escapeHtml(label)}">${escapeHtml((CATEGORIES[label] || label).split(' ')[0])}</th>`).join('')}</tr></thead>
    <tbody>${labels.map((row, i) => `<tr><th class="row">${text(CATEGORIES[row] || row)}</th>${labels.map((_, j) => { const value = best.confusion.matrix[i][j]; return `<td class="${i === j && value ? 'hit' : value ? '' : 'zero'}">${value}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
    <div class="panel-pad fine">Generated ${dateTime(evaluation.generatedAt)}. ${text(evaluation.note, '')}</div></section>`;
}

/* Actions */
async function mutate(key, path, body, success, after, form = null) {
  if (busy.has(key)) return;
  busy.add(key);
  if (form) {
    form.setAttribute('aria-busy', 'true');
    form.querySelectorAll('[type="submit"]').forEach(button => { button.disabled = true; });
  } else renderSafely();
  try {
    const result = await request(path, { method: 'POST', body: JSON.stringify(body) });
    if (after) after(result);
    if (form?.contains(document.activeElement)) document.activeElement.blur();
    if (form?.classList.contains('decision-form')) approvalFormEngaged = false;
    await refresh({ quiet: true });
    if (success) message(success);
  } catch (error) { message(error.message, 'error'); }
  finally {
    busy.delete(key);
    if (form) {
      form.removeAttribute('aria-busy');
      form.querySelectorAll('[type="submit"]').forEach(button => { button.disabled = false; });
    } else renderSafely();
  }
}

function go(nextView) { view = nextView; addingHire = false; approvalFormEngaged = false; render(); window.scrollTo(0, 0); }

app.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]');
  if (nav) { go(nav.dataset.view); if (nav.dataset.view === 'engine') { refreshHealth(); refreshEvaluation(); } return; }
  const jump = event.target.closest('[data-go]');
  if (jump) { if (jump.dataset.employee) selectedEmployeeId = jump.dataset.employee; go(jump.dataset.go); return; }
  const employee = event.target.closest('[data-employee-id]');
  if (employee) { selectedEmployeeId = employee.dataset.employeeId; addingHire = false; approvalFormEngaged = false; render(); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const id = target.dataset.id;
  switch (target.dataset.action) {
    case 'retry-load': refresh(); refreshHealth(); break;
    case 'new-hire': view = 'hires'; addingHire = true; render(); document.querySelector('#add-hire-form input')?.focus(); break;
    case 'toggle-add': addingHire = !addingHire; render(); if (addingHire) document.querySelector('#add-hire-form input')?.focus(); break;
    case 'onboard': mutate(`onboard:${id}`, `/api/employees/${encodeURIComponent(id)}/onboard`, {}, 'Onboarding routine started.'); break;
    case 'complete-task': mutate(`task:${id}`, `/api/tasks/${encodeURIComponent(id)}/complete`, {}, 'Checklist item completed.'); break;
    case 'judge': mutate(`judge:${id}`, `/api/workflows/${encodeURIComponent(id)}/judgment`, {}, 'Decision queued.'); break;
    case 'switch-admin': switchRole('admin', 'approvals'); break;
    case 'use-provider': mutate(`provider:${id}`, '/api/provider', { name: id }, 'Decision engine switched.', null).then(refreshHealth); break;
  }
});

app.addEventListener('change', event => {
  if (event.target.id === 'role-select') switchRole(event.target.value);
});

async function switchRole(role, nextView = view) {
  const previous = data.session.role;
  try {
    await request('/api/session', { method: 'POST', body: JSON.stringify({ role }) });
    view = nextView;
    addingHire = false;
    approvalFormEngaged = false;
    await refresh({ quiet: true });
    message(`Acting as ${role === 'admin' ? 'Maya Chen (admin)' : 'Jordan Lee (coordinator)'}.`);
  } catch (error) { message(error.message, 'error'); const select = document.querySelector('#role-select'); if (select) select.value = previous; }
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
    if (!reason) { form.elements.reason.setCustomValidity('Enter a decision rationale.'); form.reportValidity(); return; }
    form.elements.reason.setCustomValidity('');
    mutate(`approval:${id}`, `/api/approvals/${encodeURIComponent(id)}/decision`, { decision, reason }, decision === 'approved' ? 'Approved. One follow-up task was created.' : 'Rejected. No follow-up was created.', null, form);
  }
});

app.addEventListener('input', event => { if (event.target.name === 'reason') event.target.setCustomValidity(''); });
app.addEventListener('focusin', event => { if (event.target.closest('.decision-form')) approvalFormEngaged = true; });

await refresh();
refreshHealth();
refreshEvaluation();
setInterval(() => {
  if (all('jobs').some(job => ['queued', 'running'].includes(job.status))) refresh({ quiet: true });
}, 1500);
setInterval(() => refreshHealth(), 30000);

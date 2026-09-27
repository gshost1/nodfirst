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

const ROUTES = { it: 'IT Operations', people_ops: 'People Ops', payroll: 'Payroll & Benefits', security: 'Security', uncertain: 'Needs a person' };
const OWNERS = { it: 'IT Operations', people_ops: 'People Operations', payroll: 'Payroll & Benefits', security: 'Security', uncertain: 'People Operations' };
const CATEGORIES = { workspace_setup: 'Workspace setup', compensation: 'Compensation', expense_refund: 'Expense / refund', leave_life_event: 'Leave / life event', schedule_change: 'Schedule change', complaint: 'Complaint', policy_info: 'Policy question', access_request: 'Access request' };
const VIEWS = { overview: 'Today', hires: 'New hires', approvals: 'Needs your OK', activity: 'Record', engine: 'AI model' };
const NOD_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>';

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
const has = value => value !== null && value !== undefined;

// Plain-language summary of what the agent proposes.
function suggestion(judgment) {
  const route = ROUTES[judgment.route] || pretty(judgment.route);
  const headline = judgment.route === 'uncertain'
    ? `<b>This needs a person.</b> NodFirst won’t pick a team for this one on its own (${pct(judgment.confidence)} sure).`
    : judgment.uncertain
    ? `<b>NodFirst isn’t sure.</b> Its best guess is ${text(route)} at ${pct(judgment.confidence)}, below the 75% bar, so a person should decide.`
    : `NodFirst suggests <b>${text(route)}</b> should handle this. ${pct(judgment.confidence)} sure.`;
  return `<div class="suggestion ${judgment.uncertain ? 'unsure' : ''}"><span class="mark">${judgment.uncertain ? '<b aria-hidden="true">?</b>' : NOD_MARK}</span><div><p>${headline}</p>${judgment.reason ? `<small>${text(judgment.reason)}</small>` : ''}</div></div>`;
}

function judgmentFacts(judgment) {
  const pills = [`<span class="pill">${text(CATEGORIES[judgment.category], pretty(judgment.category) || 'Uncategorized')}</span>`];
  if (has(judgment.sensitive)) pills.push(judgment.sensitive >= 0.5 ? `<span class="pill amber">Private matter · ${pct(judgment.sensitive)}</span>` : `<span class="pill">Not sensitive · ${pct(judgment.sensitive)}</span>`);
  return `<div class="facts-row">${pills.join('')}</div>`;
}

const privacyNote = () => `<div class="privacy">${SHIELD}<span><b>What the AI saw:</b> role, location, work mode and the request. <b>Never sent:</b> name, start date or manager.</span></div>`;

function whyDetails(judgment) {
  return `<details class="why"><summary>How NodFirst decided</summary><div class="why-body">
    <div class="decision-grid"><div><div class="eyebrow">Who should handle it</div>${distribution(judgment)}</div>
      <div class="facet-list"><div class="facet"><small>Category</small><strong>${text(CATEGORIES[judgment.category], pretty(judgment.category) || '—')}</strong>${has(judgment.categoryConfidence) ? `<small>${pct(judgment.categoryConfidence)} sure</small>` : ''}</div>
      <div class="facet"><small>Needs confidential handling</small><strong>${has(judgment.sensitive) ? `${pct(judgment.sensitive)} ${judgment.sensitive >= 0.5 ? 'likely' : 'unlikely'}` : '—'}</strong>${has(judgment.sensitive) ? bar(judgment.sensitive) : ''}</div></div></div>
    <div class="run-meta"><span>${text(judgment.provider)}</span><span>${text(judgment.model)}</span><span>${Number(judgment.durationMs).toLocaleString()} ms</span><span>75% bar</span></div>
  </div></details>`;
}

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
          message(job.status === 'succeeded' ? 'NodFirst has a suggestion for you to review.' : `Suggestion failed: ${job.error || 'Unknown error'}`, job.status === 'failed' ? 'error' : 'success');
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
      <div class="brand"><div class="brand-mark">${NOD_MARK}</div><div><strong>NodFirst</strong><small>${text(data.company?.name)}</small></div></div>
      <nav class="nav" aria-label="Primary">
        ${navLink('overview')}
        ${navLink('approvals', pending, pending > 0)}
        ${navLink('hires', all('employees').length)}
        <div class="nav-label">History & settings</div>
        ${navLink('activity')}
        ${navLink('engine')}
      </nav>
      <div class="sidebar-foot">
        <button class="engine-chip" type="button" data-view="engine"><small>AI model</small><strong><span class="dot ${dot}"></span>${text(model?.label || model?.provider, 'Checking…')}</strong><span class="model">${text(model?.model, '')}</span></button>
        <p class="sidebar-note">Demo company with made-up people. NodFirst suggests; a person approves every exception.</p>
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
    ...pending.map(approval => { const employee = employeeFor(all('workflows').find(w => w.id === approval.workflowId)); const judgment = all('judgments').find(j => j.id === approval.judgmentId); return { id: employee?.id, pill: '<span class="pill amber">Needs your OK</span>', title: `${employee?.name || 'Hire'} · ${judgment?.uncertain ? 'NodFirst isn’t sure' : `send to ${ROUTES[judgment?.route] || 'a team'}?`}`, sub: employee?.exception, go: 'approvals' }; }),
    ...failed.map(job => { const employee = employeeFor(all('workflows').find(w => w.id === job.workflowId)); return { id: employee?.id, pill: '<span class="pill red">Didn’t finish</span>', title: `${employee?.name || 'Hire'} · suggestion failed`, sub: job.error, go: 'hires' }; }),
    ...needsRun.map(workflow => { const employee = employeeFor(workflow); return { id: employee?.id, pill: '<span class="pill violet">Ask NodFirst</span>', title: `${employee?.name} · has a request to sort`, sub: employee?.exception, go: 'hires' }; }),
  ];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const recent = [...all('audit')].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 7);
  const lede = pending.length ? `${plural(pending.length, 'request')} ${pending.length === 1 ? 'is' : 'are'} waiting for your OK. Nothing happens until a person says yes.` : 'Nothing is waiting on you. NodFirst sorts new-hire requests and asks before anything happens.';
  return `${pageHead(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()), `${greeting}, ${isAdmin() ? 'Maya' : 'Jordan'}`, lede, `<button class="button primary" type="button" data-action="new-hire">Add new hire</button>`)}
    <div class="kpis">
      <div class="panel kpi ${pending.length ? 'attention' : ''}"><small>Waiting for your OK</small><strong>${pending.length}</strong><span>a person decides every one</span></div>
      <div class="panel kpi"><small>Onboarding now</small><strong>${workflows.filter(w => w.status === 'active').length}</strong><span>${workflows.filter(w => w.status === 'complete').length} finished</span></div>
      <div class="panel kpi"><small>Requests sorted</small><strong>${all('judgments').length}</strong><span>${all('judgments').filter(j => j.uncertain).length} it wasn’t sure about</span></div>
      <div class="panel kpi"><small>Follow-ups created</small><strong>${all('actions').length}</strong><span>only after approval</span></div>
    </div>
    <div class="overview-grid">
      <section class="panel" aria-label="Needs attention"><div class="panel-head"><h2>Needs you</h2><span class="pill">${attention.length}</span></div>
        ${attention.length ? attention.map(item => `<button class="attention-row" type="button" data-go="${item.go}" data-employee="${escapeHtml(item.id || '')}">${item.pill}<div><strong>${text(item.title)}</strong><small>${text(item.sub, '')}</small></div><span class="muted" aria-hidden="true">→</span></button>`).join('') : `<div class="empty"><strong>All caught up</strong><p>No requests waiting, nothing failed.</p></div>`}
      </section>
      <section class="panel" aria-label="Recent activity"><div class="panel-head"><h2>Latest in the record</h2><button class="link-button" type="button" data-view="activity">See all</button></div>
        <div class="feed">${recent.length ? recent.map(entry => feedItem(entry, false)).join('') : `<div class="empty"><strong>Nothing yet</strong><p>Start an onboarding to see NodFirst work.</p></div>`}</div>
      </section>
    </div>`;
}

/* Hires */
function renderHires() {
  const employee = selectedEmployee();
  const employees = all('employees');
  return `${pageHead('Onboarding', 'New hires', 'Start each person’s checklist. If they have a special request, NodFirst suggests who should handle it and asks you first.', `<button class="button primary" type="button" data-action="toggle-add">${addingHire ? 'Close form' : 'Add new hire'}</button>`)}
    <div class="hires-layout">
      <section class="panel queue" aria-label="New hire queue"><div class="panel-head"><h2>People</h2><span class="pill">${plural(employees.length, 'person')}</span></div>
        ${addingHire ? renderAddForm() : ''}
        <div class="queue-list">${employees.length ? employees.map(item => {
          const workflow = workflowFor(item);
          const pendingApproval = workflow && byWorkflow('approvals', workflow).some(a => a.status === 'pending');
          const status = !workflow ? '<span class="pill">Not started</span>' : pendingApproval ? '<span class="pill amber">Needs OK</span>' : workflow.status === 'complete' ? '<span class="pill green">Done</span>' : '<span class="pill blue">In progress</span>';
          return `<button type="button" class="queue-item ${employee?.id === item.id ? 'selected' : ''}" data-employee-id="${escapeHtml(item.id)}" ${employee?.id === item.id ? 'aria-current="true"' : ''}><span class="avatar" aria-hidden="true">${escapeHtml(initials(item.name))}</span><span class="queue-copy"><strong>${text(item.name)}</strong><small>${text(item.role)} · ${text(item.location)}</small></span><span class="queue-status">${status}</span></button>`;
        }).join('') : `<div class="empty"><strong>No hires yet</strong><p>Add a fictional new hire to begin.</p></div>`}</div>
      </section>
      <section class="stack" aria-label="Selected hire">${employee ? renderEmployee(employee) : `<div class="panel empty"><h2>Select a hire</h2><p>Choose a person in the queue or add one.</p></div>`}</section>
    </div>`;
}

function renderAddForm() {
  return `<form id="add-hire-form" class="add-form"><div class="form-heading"><strong>Add a new hire (demo)</strong><button class="icon-button" type="button" data-action="toggle-add" aria-label="Close form">×</button></div>
    <label>Full name<input name="name" required autocomplete="off" placeholder="Avery Rivera"></label>
    <label>Role<input name="role" required placeholder="Product Designer"></label>
    <div class="form-grid"><label>Location<input name="location" required placeholder="Portland, OR"></label><label>Start date<input name="startDate" required type="date"></label></div>
    <label>Manager<input name="manager" required placeholder="Morgan Ellis"></label>
    <label>Work mode<select name="workMode" required><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="office">Office</option></select></label>
    <label>Special request <span class="optional">optional</span><textarea name="exception" rows="3" placeholder="Anything that needs a decision: equipment, pay, leave, access…"></textarea></label>
    <p class="form-hint">Use made-up details only. Names and dates are never sent to the AI.</p>
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
      ${!workflow ? `<div class="start-row"><span>Start their onboarding checklist${employee.exception ? '. NodFirst will also look at their special request' : ''}.</span><button class="button primary" type="button" data-action="onboard" data-id="${escapeHtml(employee.id)}" ${busy.has(onboardKey) ? 'disabled' : ''}>${busy.has(onboardKey) ? 'Starting…' : 'Start onboarding'}</button></div>` : ''}
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
  return `<article class="task"><span class="check ${state}" aria-hidden="true">${state === 'done' ? '✓' : state === 'rejected' ? '×' : ''}</span><div><h3>${text(task.title)} ${pill}</h3><p>${text(task.kind === 'exception' ? 'NodFirst suggests who should handle it, then a person approves.' : task.details, '')}</p><div class="task-meta"><span>Owner <b>${text(task.owner)}</b></span><span>Policy <b>${policy ? `${text(policy.title)} v${text(policy.version)}` : '—'}</b></span></div></div>${canComplete ? `<button class="button small" type="button" data-action="complete-task" data-id="${escapeHtml(task.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? 'Saving…' : 'Mark done'}</button>` : ''}</article>`;
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
  const status = judgment ? (judgment.uncertain ? '<span class="pill amber">Not sure</span>' : '<span class="pill violet">Suggested</span>') : failed ? '<span class="pill red">Didn’t finish</span>' : running ? `<span class="pill blue">${job.status === 'queued' ? 'Waiting' : 'Thinking'}</span>` : '<span class="pill">Not asked yet</span>';
  return `<section class="panel decision"><div class="decision-top"><div><div class="eyebrow">Special request</div><h2>Who should handle this?</h2></div>${status}</div>
    <div class="decision-body">
      <div class="quote"><small>${text(employee.name)} asked</small>${text(employee.exception)}</div>
      ${judgment ? `${suggestion(judgment)}${judgmentFacts(judgment)}${privacyNote()}${whyDetails(judgment)}` : ''}
      ${!judgment && provider && !provider.available ? `<div class="callout error"><div><strong>${text(provider.label || provider.provider)} isn’t available</strong><p>${text(provider.error, 'Set it up, then try again.')}</p><button class="link-button" type="button" data-view="engine">Open AI model settings →</button></div></div>` : ''}
      ${running ? `<div class="callout info"><span class="spinner" aria-hidden="true"></span><div><strong>${job.status === 'queued' ? 'Waiting to start' : 'NodFirst is thinking'}</strong><p>Attempt ${job.attempts || 1}. This keeps going even if the server restarts, and the page updates when it’s done.</p></div></div>` : ''}
      ${failed ? `<div class="callout error"><div><strong>The suggestion didn’t finish</strong><p>${text(job.error, 'The AI model returned an error.')}</p></div></div>` : ''}
      ${!judgment && !running ? `${privacyNote()}<div class="run-row"><span>Checked by <b>${text(provider?.label || provider?.provider, 'the active AI model')}</b>. You approve before anything happens.</span><button class="button accent" type="button" data-action="judge" data-id="${escapeHtml(workflow.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? 'Asking…' : failed ? 'Try again' : 'Ask NodFirst'}</button></div>` : ''}
      ${approval ? `<div class="callout ${approval.status === 'pending' ? '' : approval.status === 'approved' ? 'ok' : 'error'}"><div><strong>${approval.status === 'pending' ? 'Waiting for your OK' : approval.status === 'approved' ? `Approved by ${text(approval.decidedBy)}` : `Rejected by ${text(approval.decidedBy)}`}</strong><p>${approval.status === 'pending' ? 'Nothing happens until a person approves, however sure NodFirst is.' : `${dateTime(approval.decidedAt)} · “${text(approval.reason)}”`}</p>${approval.status === 'pending' ? (isAdmin() ? `<button class="link-button" type="button" data-view="approvals">Review it now →</button>` : `<button class="link-button" type="button" data-action="switch-admin">Switch to the admin to approve →</button>`) : ''}</div></div>` : ''}
    </div></section>`;
}

function renderAction(action, approval, judgment) {
  return `<div class="action-row"><span class="feed-icon human" aria-hidden="true">✓</span><div><strong>${text(action.title)}</strong><p class="muted">${dateTime(action.createdAt)} · a task in NodFirst only; no email, payroll or HR system change.</p>
    <div class="scope"><div><small>Approved by</small><span>${text(approval?.decidedBy)}</span></div><div><small>Goes to</small><span>${text(action.owner)}</span></div><div><small>Why</small><span>${text(approval?.reason)}</span></div></div>
    ${judgment ? `<p class="fine spaced">NodFirst suggested ${text(ROUTES[judgment.route])} at ${pct(judgment.confidence)}.</p>` : ''}</div></div>`;
}

/* Approvals */
function renderApprovals() {
  const byNewest = (a, b) => b.requestedAt.localeCompare(a.requestedAt);
  const waiting = all('approvals').filter(item => item.status === 'pending').sort(byNewest);
  const decided = all('approvals').filter(item => item.status !== 'pending').sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
  const lede = waiting.length ? `${plural(waiting.length, 'request')} waiting. Approve to create one follow-up for the right team; reject and nothing happens.` : 'Nothing is waiting. New suggestions from NodFirst land here first.';
  return `${pageHead('Approvals', 'Needs your OK', lede)}
    <div class="stack">${!isAdmin() ? `<div class="callout info"><div><strong>Only the admin can approve</strong><p>Coordinators can see requests; the admin decides them.</p><button class="button small" type="button" data-action="switch-admin">Switch to the admin</button></div></div>` : ''}
    ${waiting.map(renderApproval).join('')}
    ${!all('approvals').length ? `<div class="panel empty"><h2>Nothing to approve yet</h2><p>Ask NodFirst about a new hire’s request. Its suggestion lands here for you.</p></div>` : !waiting.length ? `<div class="panel empty"><h2>All caught up</h2><p>Every suggestion so far has a decision.</p></div>` : ''}
    ${decided.length ? `<div class="section-label">Decided</div>${decided.map(renderApproval).join('')}` : ''}</div>`;
}

function renderApproval(approval) {
  const workflow = all('workflows').find(item => item.id === approval.workflowId);
  const employee = employeeFor(workflow);
  const judgment = all('judgments').find(item => item.id === approval.judgmentId);
  const action = all('actions').find(item => item.approvalId === approval.id);
  const owner = OWNERS[judgment?.uncertain ? 'uncertain' : judgment?.route] || 'People Operations';
  const key = `approval:${approval.id}`;
  const pending = approval.status === 'pending';
  const title = !judgment ? 'Review this request' : judgment.uncertain ? `Where should ${text(employee?.name, 'this')}’s request go?` : `Send to ${text(ROUTES[judgment.route])}?`;
  return `<article class="panel approval ${pending ? 'pending' : ''}"><div class="approval-head"><div><div class="eyebrow">${text(employee?.name)} · asked ${relative(approval.requestedAt)}</div><h2>${title}</h2></div><span class="pill ${pending ? 'amber' : approval.status === 'approved' ? 'green' : 'red'}">${pending ? 'Needs your OK' : pretty(approval.status)}</span></div>
    <div class="approval-body">
      <div class="quote"><small>${text(employee?.name, 'The new hire')} asked</small>${text(employee?.exception, 'No request text recorded.')}</div>
      ${judgment && pending ? `${suggestion(judgment)}${judgmentFacts(judgment)}${privacyNote()}` : ''}
      ${pending && isAdmin() ? `<form class="decision-form" data-approval-id="${escapeHtml(approval.id)}"><label for="reason-${escapeHtml(approval.id)}">Why? <span class="required">One line, saved in the record</span></label><textarea id="reason-${escapeHtml(approval.id)}" name="reason" rows="2" required minlength="3" placeholder="e.g. Standard home-office setup, within policy."></textarea><div class="decision-actions"><button class="button approve" type="submit" name="decision" value="approved" ${busy.has(key) ? 'disabled' : ''}>Approve · send to ${text(owner)}</button><button class="button danger" type="submit" name="decision" value="rejected" ${busy.has(key) ? 'disabled' : ''}>Reject</button></div>${judgment?.uncertain ? '<p class="fine">NodFirst wasn’t sure, so approving sends it to People Operations to sort out.</p>' : ''}</form>` : ''}
      ${!pending ? `<div class="decision-record"><strong>${pretty(approval.status)} by ${text(approval.decidedBy)}</strong> · ${dateTime(approval.decidedAt)}<br>Why: ${text(approval.reason)}<br>${action ? `Created: ${text(action.title)} → ${text(action.owner)}` : 'Nothing was created.'}</div>` : ''}
      ${judgment ? whyDetails(judgment) : ''}
    </div></article>`;
}

/* Activity */
const ACTION_LABELS = {
  'employee.added': ['New hire added', ''], 'onboarding.started': ['Onboarding started', 'agent'], 'checklist.completed': ['Checklist item done', ''],
  'model.queued': ['NodFirst asked', 'agent'], 'model.completed': ['NodFirst suggested', 'agent'], 'model.failed': ['Suggestion failed', 'alert'], 'model.recovered': ['Suggestion resumed', 'agent'],
  'approval.requested': ['Waiting for OK', 'agent'], 'approval.approved': ['Approved by a person', 'human'], 'approval.rejected': ['Rejected by a person', 'alert'],
  'action.created': ['Follow-up created', 'human'], 'provider.changed': ['AI model switched', ''],
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
  const glyph = { agent: '✦', human: '✓', alert: '!' }[kind] || '·';
  const why = d.reason || d.error || d.title || '';
  return `<article class="feed-item"><span class="feed-icon ${kind}" aria-hidden="true">${glyph}</span><div><div class="feed-top"><strong>${label}${employee ? ` · ${text(employee.name)}` : ''}</strong><time datetime="${escapeHtml(entry.createdAt)}" title="${escapeHtml(dateTime(entry.createdAt))}">${relative(entry.createdAt)}</time></div><p>${text(entry.actor, 'System')}${why ? ` — ${text(why)}` : ''}</p>${chips.length ? `<div class="feed-meta">${chips.map(chip => `<span>${text(chip)}</span>`).join('')}</div>` : ''}${expanded && Object.keys(d).length ? `<details><summary>Record</summary><pre>${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>` : ''}</div></article>`;
}

function renderActivity() {
  const entries = [...all('audit')].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `${pageHead('History', 'The record', 'Every step NodFirst and your team took: who did it, what changed, and why. Entries can’t be edited or deleted.')}
    <section class="panel"><div class="panel-head"><h2>${plural(entries.length, 'entry')}</h2><span class="pill">Permanent · can’t be edited</span></div><div class="feed">${entries.length ? entries.map(entry => feedItem(entry)).join('') : `<div class="empty"><strong>No activity yet</strong></div>`}</div></section>`;
}

/* Decision engine */
function renderEngine() {
  const providers = health?.providers || [];
  return `${pageHead('Settings', 'AI model', 'Choose which AI sorts requests. The offline model keeps everything on this computer. Hosted models need an API key set on the server; keys are never typed in the browser.')}
    <div class="stack">
      <div class="provider-grid">${providers.length ? providers.map(renderProvider).join('') : '<div class="panel empty"><strong>Checking models…</strong></div>'}</div>
      ${!isAdmin() ? '<p class="fine">Switch to the admin to change the AI model.</p>' : ''}
      ${renderEvaluation()}
    </div>`;
}

function renderProvider(item) {
  const state = item.available ? '<span class="pill green">Ready</span>' : item.configured ? '<span class="pill red">Unavailable</span>' : '<span class="pill">Not set up</span>';
  const kind = { api: 'Hosted · data leaves this computer', local: 'Runs on your own machine', offline: 'Offline · nothing leaves this computer' }[item.kind] || item.kind;
  const key = `provider:${item.name}`;
  return `<article class="panel provider ${item.active ? 'active' : ''}"><div class="provider-top"><h3>${text(item.label)}</h3>${item.active ? '<span class="pill violet">Active</span>' : state}</div>
    <p>${kind}</p><div class="mono">${text(item.model)}</div>
    <p>${text(item.available ? item.note : item.error || item.setup, '')}</p>
    ${!item.available && item.setup ? `<p class="fine">${text(item.setup)}</p>` : ''}
    <div class="provider-foot">${item.active ? state : `<button class="button small" type="button" data-action="use-provider" data-id="${escapeHtml(item.name)}" ${!isAdmin() || !item.configured || busy.has(key) ? 'disabled' : ''}>Use this model</button>`}</div></article>`;
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
    case 'judge': mutate(`judge:${id}`, `/api/workflows/${encodeURIComponent(id)}/judgment`, {}, 'Asked NodFirst.'); break;
    case 'switch-admin': switchRole('admin', 'approvals'); break;
    case 'use-provider': mutate(`provider:${id}`, '/api/provider', { name: id }, 'AI model switched.', null).then(refreshHealth); break;
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
    message(`Now acting as ${role === 'admin' ? 'Maya Chen (admin)' : 'Jordan Lee (coordinator)'}.`);
  } catch (error) { message(error.message, 'error'); const select = document.querySelector('#role-select'); if (select) select.value = previous; }
}

app.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'add-hire-form') {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    mutate('add', '/api/employees', values, 'New hire added.', result => { selectedEmployeeId = result.employee.id; addingHire = false; }, form);
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
    mutate(`approval:${id}`, `/api/approvals/${encodeURIComponent(id)}/decision`, { decision, reason }, decision === 'approved' ? 'Approved. One follow-up was created.' : 'Rejected. Nothing was created.', null, form);
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

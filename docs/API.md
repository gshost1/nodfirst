# Daybreak implementation contract

Local Node >=24.2 ESM application, built-in SQLite and HTTP, static vanilla JS UI. Root owns `src/server.mjs`, `src/store.mjs`, `src/workflow.mjs`, package/config and integration tests. UI agent owns `public/`. Provider agent owns `src/provider.mjs`, `scripts/setup.mjs`, `scripts/model-smoke.mjs`, provider tests. Fixture agent owns `src/fixtures.mjs` and `docs/HANDBOOK.md`.

All domain records use camelCase keys and ISO timestamps. IDs are opaque strings. A record referenced by `workflowId` belongs to that workflow. State is persisted in `.data/daybreak.sqlite`; model weights stay in Ollama storage. All employee and handbook data is fictional.

## HTTP interface

- `GET /api/state` returns `{company:{name,synthetic:true},session:{role,actor,csrfToken},employees,policies,routines,workflows,tasks,judgments,approvals,actions,jobs,audit}`. Creates an HttpOnly same-site session cookie. Default role `coordinator`. UI must send `x-csrf-token: session.csrfToken` and JSON content type on every POST.
- `GET /api/health` returns `{ok:true,model:{provider:'ollama',model,available,baseUrl,error?}}`. Availability means installed and reachable, not a completed model invocation.
- `POST /api/session` body `{role:'coordinator'|'admin'}` switches demo persona; fixed server names are `Jordan Lee (coordinator)` and `Maya Chen (admin)`. Returns `{session}`. This is an explicitly labeled local demonstration switch, not production authentication.
- `POST /api/employees` body `{name,role,location,startDate,manager,workMode:'remote'|'hybrid'|'office',exception}`. Returns `{employee}`.
- `POST /api/employees/:id/onboard` body `{}`. Idempotently returns `{workflow}`.
- `POST /api/tasks/:id/complete` body `{}`. Completes ordinary checklist items only. Returns `{task}`.
- `POST /api/workflows/:id/judgment` body `{}` queues the durable local model job, returns HTTP 202 `{job}`. Idempotent while pending or after success; failed jobs may be retried via same endpoint. Poll `/api/state` while jobs are queued/running.
- `POST /api/approvals/:id/decision` body `{decision:'approved'|'rejected',reason}` requires admin. Approval atomically creates exactly one safe local follow-up action; rejection creates no action. Decisions cannot be reversed. Returns `{approval,action?}`.
- Errors use `{error: 'human-readable message'}`, with appropriate 4xx/5xx status.

## Domain shapes

- Employee: `{id,name,role,location,startDate,manager,workMode,exception,createdAt}`
- Policy: `{id,title,version,rule}`
- Routine: `{id,name,trigger,description,version}`
- Workflow: `{id,employeeId,routineId,status:'active'|'complete',createdAt,updatedAt}`
- Task: `{id,workflowId,title,owner,status:'todo'|'done'|'needs_judgment'|'awaiting_review'|'approved'|'rejected',policyId,kind:'checklist'|'exception',details,createdAt}`
- Judgment: `{id,workflowId,provider,model,route:'it'|'people_ops'|'security'|'uncertain',confidence,reason,uncertain,durationMs,createdAt}`. Confidence is model-reported and uncalibrated. `uncertain` is also forced by code below 0.75. Real provider results only; errors never create a judgment.
- Approval: `{id,workflowId,taskId,judgmentId,status:'pending'|'approved'|'rejected',requestedAt,decidedAt,decidedBy,reason}`
- Action: `{id,approvalId,workflowId,type:'local_task',title,owner,status:'created',createdAt}`. This is an internal follow-up record; no email or HRIS writes happen.
- Job: `{id,workflowId,type:'judge_exception',status:'queued'|'running'|'succeeded'|'failed',attempts,error,createdAt,updatedAt}`
- Audit: `{id,workflowId,actor,action,details,createdAt}`. Details is an object. Events are also persisted but need not be shown by UI.

## Provider module contract

`createLocalProvider({baseUrl?,model?,timeoutMs?}={})` returns `{name:'ollama',model,baseUrl, health():Promise<{available:boolean,error?:string}>, judge({role,location,workMode,exception,policies}):Promise<{provider:'ollama',model,route,confidence,reason,uncertain,durationMs}>}`. Defaults `OLLAMA_BASE_URL || http://127.0.0.1:11434`, `OLLAMA_MODEL || qwen2.5:3b`. Enforce loopback URL (no credentials, redirects, external hosts), refuse cloud models, and verify local weights/metadata before transmitting the case. Names/dates are omitted. Treat exception text as untrusted data. Validate result schema/ranges, reject invalid responses, bounded timeout; no silent fallback.

## Fixture module contract

Exports `company={name:'Northstar Studio',synthetic:true}`, `policies` with IDs `welcome`, `orientation`, `workspace`, `remote`, `exceptions`; `routines` containing ID `onboarding-v1`; and `employees` with shape above (stable IDs, timestamps; fictional start dates relative to current date are okay). First employee has an ambiguous remote laptop exception to exercise real inference; another security exception and one no-exception case. Optional `expectedCases` describes safe expected outcomes, not hard-coded model results.

## Visual direction

Product name Daybreak. Warm ivory background, dark ink type, forest/sage accents and amber review status. Compact left navigation, visible new-hire queue, selected hire detail with policy-backed checklist, local judgment card, admin approvals and audit views. Immediately usable working surface. Native controls, accessible labels, keyboard focus, responsive stacking. No external fonts, images, scripts, network calls or decorative dashboard graphs. Show synthetic/local demo and model confidence caveat clearly. Error, busy and empty states must be real.

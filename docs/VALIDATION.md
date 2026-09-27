# Validation — 2026-09-26

> **Historical record (v0.1, Ollama-only).** For the v0.2 dark UI, multi-provider decision engine, and the SAP dataset evaluation, see [EVALUATION.md](EVALUATION.md). `npm test` now runs 19 tests.

**Approach: Codex-only**, with separate implementation ownership for UI, local provider, and synthetic fixtures, followed by an independent review and integration validation. This kept the local workflow, permissions, and persistence in one coherent application. The completed ten-task workflow tracker was not used.

Environment: Apple Silicon Mac, 8 GB RAM, Node **26.7.0**, local Ollama with **qwen2.5:3b**. The project began with only `AGENTS.md` and `IMPLEMENTATION_BRIEF.md`. No cloud model API or paid key was used.

## Repeatable checks and results

| Check | Result |
| --- | --- |
| `npm run setup` | Pass: runtime and local model metadata verified; no dependency install needed. |
| `npm test` | **12 passed, 0 failed**. Explicitly mocked provider tests and workflow integration tests. |
| `npm run model:smoke` | Pass: actual 3B inference completed in about 1.9 seconds. |
| `VALIDATION_OUTPUT=docs/validation-live.json npm run test:live` | **Pass** using two actual server processes, fresh temporary SQLite storage, and actual Ollama. |
| Browser QA with ego-browser | Pass: hire creation, checklist, real judgment, admin approval, local action, keyboard/click submission, draft preservation, and responsive layout. |

The final live run is recorded at **2026-09-26T21:13:42Z** in [validation-live.json](validation-live.json). It verified:

- Repeated onboarding requests retain the same workflow.
- The checklist has policy references and owners; ordinary tasks complete.
- A real model result is stored before an approval is created. No local action exists before approval.
- A coordinator's approval attempt receives **403**.
- Admin approval creates exactly **one** internal task; a repeated decision receives **409**.
- A second real model judgment can be rejected, creating no action.
- A no-exception hire completes without model inference. A newly added synthetic hire persists.
- The server process stops and a new process starts against the same database. All employees, workflows, tasks, judgments, approvals, actions, jobs, and audit entries match exactly; the session resets to coordinator.

Final live counts: **5 employees, 3 workflows, 12 checklist/exception tasks, 2 judgments, 2 approvals, 1 action, 2 jobs, 20 audit entries**. Real final model durations were **2,108 ms** and **1,752 ms**. These timings describe this machine and run, not a performance guarantee.

## Failure and boundary coverage

The deterministic suite checks bad dates, oversized input, CSRF, cross-origin requests, hostile Host headers (with raw HTTP), admin enforcement, rejection, duplicate decisions, append-only audit records, and the database constraint requiring a matching approved decision before action creation.

Provider tests use clearly identified loopback mock servers to check redirects, nonlocal URLs, credentials in URLs, invalid schemas, HTTP errors, incomplete output, timeouts, cloud model names, remote metadata, and absent local weights. Rejected model metadata receives **zero generation requests**. The real local provider verifies model metadata again before transmitting each case.

Failed jobs create **no judgment, approval, or action**, and can be retried. A persisted running job is recovered after reopening the database. A slow in-flight inference across multiple timer ticks proves that graceful shutdown waits for it before closing SQLite.

## Browser and review evidence

- At **1365 px**, the working surface, complete policy checklist, actual 3B result, and admin decision screen rendered without overflow. Screenshots are saved locally under `artifacts/nodfirst-desktop.png` and `artifacts/nodfirst-approvals.png` (ignored by Git).
- At **390 px**, navigation and content fit without horizontal page overflow.
- Both keyboard and click form submissions worked. An unfinished hire form survived a **32-second** background health refresh.
- The start date `2026-10-05` displayed as **Oct 5, 2026** in the local US time zone.
- Review found and resolved: worker shutdown promise loss, date-only time-zone drift, background form erasure, unresolved counts after rejection, a CSP-blocked inline progress style, and possible Ollama cloud forwarding. A focused follow-up review reported no remaining blockers in those areas.
- Git ignore checks cover `.data`, `.env`, model weights, and screenshots. A source/docs scan found no private-key or common API-token patterns. No downloaded weights or runtime database files are part of the deliverable.

## Model quality is a limitation

Workflow validation is separate from routing accuracy. An initial real `qwen2.5:1.5b` run incorrectly classified Avery's mixed laptop/stipend request as Security at **0.9 confidence**, inventing a security-sensitive fact. That result is preserved in [validation-initial-model.json](validation-initial-model.json).

The final generalized prompt and `qwen2.5:3b` model produced:

| Synthetic case | Actual result | Assessment |
| --- | --- | --- |
| Avery: laptop shipment plus stipend question | `people_ops`, confidence **1.0**, uncertainty **false** | Recognized the stipend question, but did not flag the mixed technical/policy nature. |
| Jules: temporary production/customer-record access | `security`, confidence **1.0**, uncertainty **false** | Appropriate route; short rationale remains limited. |
| Theo: standard VPN and approved authenticator setup | `security`, confidence **1.0**, uncertainty **false** | **Incorrect**; handbook routes ordinary setup to IT. |

The final Theo result is preserved in [validation-routing.json](validation-routing.json). These few cases are not an accuracy benchmark. High self-reported confidence did not reliably imply correctness. The UI labels confidence as uncalibrated, and every exception requires an admin decision. Even approval creates only a local follow-up record; it grants no access and sends no message.

Before a real pilot, a reviewed evaluation set and appropriate model/routing quality are required, along with real identity/authentication, privacy controls, and an explicitly authorized HRIS integration. The shipped persona switch and handbook remain a local synthetic demonstration.

# NodFirst

An HR onboarding agent demo for the fictional **Northstar Studio**, modeled on how an HR agent should behave: it does the routine work, answers typed questions about every exception, **asks a human for approval**, and keeps a record of every action with an identity, scope, and rationale.

![NodFirst: agent decision on a new hire's exception](docs/demo/hire-decision.png)

[Walkthrough video](docs/demo/walkthrough.webm) · [Overview](docs/demo/overview.png) · [Approvals](docs/demo/approvals.png) · [Activity](docs/demo/activity.png) · [Decision engine](docs/demo/decision-engine.png) · [Mobile](docs/demo/mobile.png)

## Run

Requires **Node 22.13+**; Node 24 is recommended because it has stable `node:sqlite`.

```sh
npm install
npm start          # http://127.0.0.1:4317
```

With no keys set it runs fully offline on the built-in baseline model. To use a hosted decision model, export a key before `npm start`:

| Provider | Environment | Notes |
| --- | --- | --- |
| **TypeSafe Jev** | `TYPESAFE_API_KEY`, optional `JEV_MODEL` (default `jev-latest`), `TYPESAFE_BASE_URL` | Typed decision model. One `/v1/systemone` call asks three questions and returns probabilities, not prose. |
| **Claude** | `ANTHROPIC_API_KEY` (or `NODFIRST_ANTHROPIC_AUTH_TOKEN`), optional `ANTHROPIC_MODEL` (default `claude-opus-5`), `ANTHROPIC_EFFORT` (default `low`) | Official SDK with JSON-schema structured output. |
| **OpenAI-compatible** | `OPENAI_API_KEY`, `OPENAI_MODEL`, optional `OPENAI_BASE_URL` | OpenAI, OpenRouter, Groq, vLLM, LM Studio… (subscription credits through OpenRouter work here). |
| **Ollama** | `OLLAMA_MODEL`, `OLLAMA_BASE_URL` (loopback only) | Local weights; `npm run setup` pulls `qwen2.5:3b`. |
| **Offline baseline** | none | Naive Bayes trained on `data/training/hr-requests.json`. Returns a full probability distribution like Jev. |

`NODFIRST_PROVIDER=auto` (the default) picks the first configured provider in this order: Jev, Claude, OpenAI, Ollama, then the baseline. An admin can switch providers at runtime on the **Decision engine** page; the choice is audited and persists. Keys live only in the server environment and never in the browser.

## Try it

1. **New hires**: select Avery Chen, then **Start onboarding** and mark the ordinary tasks done.
2. **Run agent decision.** The agent answers three typed questions:
   - **route**: IT, People Ops, Payroll & Benefits, Security, or "needs a human", with a bar for each option's probability
   - **category**
   - **sensitive**: the probability the request needs confidential handling
3. Switch the persona to **Maya Chen · admin** and open **Approvals**. Write a rationale and approve: exactly one local follow-up is created. Reject another request: nothing is created.
4. **Activity** shows the append-only record. **Overview** lists what needs attention.

`npm run demo:profile` does all of this through the real HTTP API for a fictional hire plus four hires whose requests come from the SAP dataset. Add `NODFIRST_DB=.data/demo.sqlite` to keep the result and open it in the UI.

## Evaluation

`npm run eval` scores providers on **259 human-written HR requests** from [SAP/hr-request-data-set](https://github.com/SAP/hr-request-data-set) (Apache-2.0). Full write-up: [docs/EVALUATION.md](docs/EVALUATION.md).

| Provider | Mode | Route | Category | Flagged | Accuracy when not flagged |
| --- | --- | ---: | ---: | ---: | ---: |
| Offline baseline | 5-fold CV | 98.1% | 91.1% | 5.4% | 99.6% |
| Offline baseline | cross-source (no survey tickets in training) | 91.5% | 66.4% | 36.7% | 97.6% |

Jev, Claude and OpenAI runs need an API key. Set one and rerun `npm run eval`; results appear in the table above and in the app.

## What is real, and what is simulated

- **Real:** the decision calls to the configured provider, SQLite storage, durable jobs that survive restarts, server-side role checks, approval and rejection, follow-up creation, append-only audit, and the evaluation data.
- **Simulated:** the company, the handbook, the employees, and the persona switch. The persona switch is **not authentication**. A follow-up is a local database record: no email, HRIS write, payroll change, payment, access grant, or eligibility decision ever happens.
- **The model only proposes.** Code validates every answer against the schema and forces `uncertain` below 0.75 confidence or when the route is `uncertain`. Code also refuses any action without an admin decision, which a database trigger enforces.
  - Confidence from LLM providers is self-reported and uncalibrated. Jev's and the baseline's are distribution-based.

## Data boundary

Only role, location, work mode, the request text, and relevant fictional policies reach a provider. Names and dates are never sent. Case fields are passed as untrusted data.

- Hosted providers use HTTPS origins you configure. `NODFIRST_ANTHROPIC_BASE_URL` is explicit, so an ambient `ANTHROPIC_BASE_URL` cannot redirect HR data.
- Redirects are refused.
- Ollama is restricted to loopback, and cloud-tagged models are refused.
- The server binds to `127.0.0.1` with Host/Origin checks, a per-session CSRF token, and a strict CSP. The UI loads no external assets.

Data lives in `.data/nodfirst.sqlite`. v0.1 databases are refused with a clear message because the decision schema changed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | Local web port |
| `NODFIRST_DB` | `.data/nodfirst.sqlite` | SQLite database path |
| `NODFIRST_PROVIDER` | `auto` | `auto`, `jev`, `anthropic`, `openai`, `ollama`, or `baseline` |

## Tests

```sh
npm test              # 19 deterministic tests: workflow, approval gate, providers (mock servers), baseline, provider switching
npm run eval          # dataset evaluation
npm run demo:profile  # end-to-end fictional profile through a real server process
npm run test:live     # real Ollama end-to-end (requires Ollama)
```

## Code map

| Path | Responsibility |
| --- | --- |
| `src/decision.mjs` | The typed decision contract: routes, categories, the Jev-style questions, schema, and validation |
| `src/providers.mjs` | Jev, Claude, OpenAI-compatible, and offline baseline providers; the registry and default selection |
| `src/provider.mjs` | Ollama local provider (loopback-only, local-weights verification) |
| `src/server.mjs` | HTTP, sessions, provider switching, and static assets |
| `src/store.mjs`, `src/workflow.mjs` | Schema and persistence; the routine, job worker, and approval transaction |
| `public/` | Dark UI: vanilla JS, no build step |
| `data/` | SAP evaluation set, baseline training data, and the SAP license |
| `scripts/eval-hr.mjs`, `scripts/demo-profile.mjs` | Evaluation harness and end-to-end profile run |

MIT licensed; SAP data rows are Apache-2.0 (`data/LICENSE-SAP-Apache-2.0.txt`). Independently designed. No Warp or TypeSafe source, branding, or assets are included.

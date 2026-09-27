# Evaluation on real HR request data

**Date:** 2026-09-26 · **Command:** `npm run eval` · **Raw results:** [eval/latest.json](eval/latest.json), per-request predictions in `eval/predictions-*.json`

## Dataset

No Hugging Face dataset for HR decisions was reachable from the build environment. Egress to huggingface.co was blocked, so the planned search there could not run. We used [SAP/hr-request-data-set](https://github.com/SAP/hr-request-data-set) (Apache-2.0) instead. It holds employee-to-HR requests written by **29 human survey participants**, each responding to a category prompt.

| File in this repo | Contents | Use |
| --- | --- | --- |
| `data/eval/sap-hr-survey.json` | 259 human-written requests from `survey_tickets/*.xlsx` | **Test set** |
| `data/training/hr-requests.json` | 70 SAP hand-written tickets + 36 NodFirst-authored seeds + the 259 survey tickets | Training data for the in-app offline baseline |

SAP labels each request with a category and sub-category. NodFirst asks three typed questions: a route (the team that owns the follow-up), a category, and a sensitivity probability. The mapping below is our own labeling layer, so route and sensitivity accuracy measure agreement with *these* labels:

| SAP category / sub-category | n | Route | Category | Sensitive |
| --- | ---: | --- | --- | --- |
| Salary / Salary raise | 21 | payroll | compensation | no |
| Salary / Gender pay gap | 21 | payroll | compensation | yes |
| Refund / Refund travel | 40 | payroll | expense_refund | no |
| Life event / Health issues | 35 | people_ops | leave_life_event | yes |
| Life event / Personal issues | 41 | people_ops | leave_life_event | yes |
| Ask information / Accommodation | 37 | people_ops | policy_info | no |
| Complaint / complaint | 34 | people_ops | complaint | yes |
| Timetable change / Shift change | 30 | people_ops | schedule_change | no |

SAP has no IT, security, or onboarding-setup requests. The 36 authored seeds (IT setup, privileged-access requests, mixed "needs a human" cases) exist so the baseline can emit those routes at all. The seeds are **not** in the test set.

## Results

| Provider | Mode | Route | Category | Sensitive | Flagged uncertain | Route acc. when not flagged | ECE |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Offline baseline (naive Bayes) | 5-fold stratified CV | **98.1%** | **91.1%** | 94.6% | 5.4% | 99.6% | 0.034 |
| Offline baseline, cross-source | trained without any survey ticket | 91.5% | 66.4% | 75.3% | 36.7% | 97.6% | 0.136 |
| TypeSafe Jev | zero-shot | not run: no `TYPESAFE_API_KEY`, and `api.typesafe.ai` blocked by the network policy |
| Claude | zero-shot | not run: no `ANTHROPIC_API_KEY` in the environment |
| OpenAI-compatible | zero-shot | not run: no key |
| Ollama `qwen2.5:3b` | zero-shot | not run: model weights could not be downloaded (ollama.com / huggingface.co blocked) |

*ECE* is the expected calibration error of the route confidence over 10 bins; lower is better. *Flagged* means code forced `uncertain`: confidence below 0.75, or the provider chose `uncertain`. Every exception goes to an admin anyway; the flag tells the admin where the agent is unsure.

### What this shows

1. **The 5-fold number is optimistic.** Every participant wrote from the same eight prompts, so tickets in one category share vocabulary ("plane ticket", "shift", "raise"). With cross-validation a bag-of-words model sees close cousins of each test ticket.
2. **The cross-source run is the more honest baseline.** It never sees a survey ticket. Route accuracy stays high at 91.5%, since payroll and people_ops are lexically distinct. Category accuracy drops to 66.4% because:
   - *Shift change → 0%.* The SAP hand-written set has no shift-change examples, so the model has never seen that class and calls every one of them leave.
   - *Complaint → 24%, Accommodation → 32%.* The small training set under-represents both.
3. **The uncertainty gate works as a safety valve.** In the cross-source run the model flagged 37% of requests. On the 63% it did not flag, the route was right **97.6%** of the time. Low confidence is the right signal to lean harder on the human reviewer.
4. **Some errors are label noise, not model errors.** SAP labels "I kindly ask you to a day off for a medical consultation" as *shift change*. It labels "I cannot work on 20.12 because of my son's wedding and want to work on 22.12 instead" as *shift change* too, although the model's *leave/life event* is defensible. Treat category accuracy as a lower bound.
5. **Sensitivity is the weakest question** (75% cross-source). Pay-equity and personal-issue tickets are sensitive by our mapping but often read like routine requests. This is where a hosted model should add the most.

## The fictional profile, end to end

`npm run demo:profile` starts a real server process and drives the HTTP API as a coordinator and then an admin. Results are in [demo/profile-run.json](demo/profile-run.json), screenshots in [demo/](demo/).

- **Rowan Adeyemi-Park**, a fictional remote Senior Account Executive, asks: *"My offer letter includes a $1,500 home office stipend, but I already bought a standing desk in September. Can payroll reimburse that purchase, and does the stipend come on my first paycheck?"*
  - The baseline answered **route = payroll, 69%** (people_ops 16%, uncertain 11%) and **category = expense_refund**, with 2% sensitive.
  - Both labels are correct. But 69% is under the 0.75 floor, so code flagged the decision as uncertain, and the follow-up owner defaulted to People Operations.
  - A coordinator's approval attempt got **403**. The admin approved with a written rationale, and exactly **one** local follow-up was created, recording identity, scope, and rationale.
- **Four more hires carry real SAP tickets** as their onboarding exception: a life event, a shift change, a complaint, and a travel refund. All four were routed and categorized to match the dataset labels. The admin rejected the complaint, and no action was created for it.
  - Caveat: the in-app baseline is trained on the full survey set, so these four tickets were seen in training. They demonstrate the workflow, not accuracy. The accuracy figures above come from held-out runs.
- **Final state:** 5 workflows, 5 decisions, 5 approvals, 4 actions, 51 append-only audit entries. No action existed before a human decision.

## Reproduce with a hosted model

```sh
export ANTHROPIC_API_KEY=...       # or TYPESAFE_API_KEY=... / OPENAI_API_KEY=... OPENAI_MODEL=...
npm run eval                        # baseline + every configured provider, all 259 requests
npm run eval -- --providers anthropic --limit 64   # stratified 64-request sample (8 per category)
```

Hosted providers are scored zero-shot on the same 259 requests. The results table, the in-app **Decision engine** page, and `docs/eval/latest.json` all pick up the new runs.

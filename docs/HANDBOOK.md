# Northstar Studio onboarding handbook

**Fictional demo handbook — version 2026.09**

This handbook and every employee record in the demo are synthetic. They are for software demonstration and evaluation only, not legal advice, employment guidance, or a statement of real company policy. Do not enter real employee information.

## New hire routine

The `onboarding-v1` routine creates the initial onboarding checklist when a coordinator starts a workflow for a selected employee. Each checklist item points to the policy that explains its owner or handling. It covers reading the welcome handbook, scheduling a first-day welcome meeting, preparing a standard workspace, remote equipment delivery where applicable, and any exception recorded for that employee.

Ordinary checklist items can be completed by the coordinator. An exception may be sent to the local model for a limited routing suggestion (`it`, `people_ops`, `security`, or `uncertain`). The model does not decide eligibility, grant access, or perform the requested work. Its confidence is uncalibrated and is only a routing hint.

**Every exception requires an administrator decision before a follow-up action, even when the model reports high confidence.** An administrator can approve or reject the proposed internal follow-up task. Approval does not itself grant system access, authorize spending, or write to an HRIS. The demo's follow-up is a local task record.

## Policies used by the routine

All policy records use version `2026.09`; the IDs below are the stable IDs referenced by checklist items and the application.

| Policy ID | Handbook rule | Routine mapping |
| --- | --- | --- |
| `welcome` | The new hire reads the fictional welcome handbook before the first day. | `Read the welcome handbook`, owned by the employee. |
| `orientation` | The manager schedules a first-day welcome meeting with the new hire. | `Schedule a first-day welcome`, owned by the employee's manager. |
| `workspace` | IT Operations prepares a record of the standard equipment and account checklist. Requests outside the standard setup path need human review. | `Prepare a standard workspace`, owned by IT Operations. |
| `remote` | For a remote new hire, IT Operations records an equipment delivery plan. The demo does not order or ship equipment. Stipend, eligibility, accommodation, or policy interpretation questions require human review. | Remote employees also receive `Confirm equipment delivery plan`, owned by IT Operations. |
| `exceptions` | Every exception waits for an administrator decision regardless of model confidence. Security-sensitive access requests go to Security for review; the demo grants no access. | Exception task receives a model routing suggestion and enters administrator review before any follow-up. |

## Handling examples

- A remote laptop request may need an IT delivery plan. A combined laptop and stipend question may involve both IT and People Ops; the model can be uncertain, and an administrator still reviews it.
- A request for production access is sensitive. It must not result in access being granted by this routine. Route the request to Security for human review through the administrator approval flow.
- With no exception text, the routine creates the ordinary checklist and does not need an exception judgment or approval.
- A request to set up the standard VPN and approved authenticator is an ordinary IT request. If the application records it as an exception, the administrator review rule still applies.

These examples describe safe handling expectations for the workflow. They do not promise that a model will produce a particular classification.

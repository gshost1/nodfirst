// Fully fictional data for the local NodFirst onboarding demonstration.
// Keep all dates and identities synthetic; these records are not people data.

export const company = {
  name: 'Northstar Studio',
  synthetic: true,
};

export const policies = [
  {
    id: 'welcome',
    title: 'Welcome handbook',
    version: '2026.09',
    rule: 'The new hire reads the fictional welcome handbook before the first day.',
  },
  {
    id: 'orientation',
    title: 'First-day welcome meeting',
    version: '2026.09',
    rule: 'The manager schedules a first-day welcome meeting with the new hire.',
  },
  {
    id: 'workspace',
    title: 'Workspace equipment',
    version: '2026.09',
    rule: 'IT handles ordinary device, account, and approved workspace setup requests. Requests outside the standard setup path need human review.',
  },
  {
    id: 'remote',
    title: 'Remote equipment delivery',
    version: '2026.09',
    rule: 'For a remote new hire, IT records a plan for equipment delivery. This demo does not order or ship equipment. Stipend, eligibility, accommodation, or policy interpretation questions require human review.',
  },
  {
    id: 'payroll',
    title: 'Payroll, stipends, and reimbursement',
    version: '2026.09',
    rule: 'Payroll & Benefits answers salary, pay equity, stipend, and reimbursement questions. The demo never changes pay, issues payments, or decides eligibility; it records a follow-up for a human.',
  },
  {
    id: 'exceptions',
    title: 'Exceptions and sensitive access',
    version: '2026.09',
    rule: 'Every exception requires an administrator decision before any follow-up action, regardless of model confidence or suggested route. Security-sensitive access requests must be reviewed by an administrator and routed to Security; the demo grants no access.',
  },
];

export const routines = [
  {
    id: 'onboarding-v1',
    name: 'New hire onboarding',
    trigger: 'coordinator_start',
    description: 'Create the policy-backed onboarding checklist for a selected new hire. Exception items are sent to the local model for a bounded routing suggestion and always wait for administrator review.',
    version: '1.0.0',
  },
];

export const employees = [
  {
    id: 'employee-avery-chen',
    name: 'Avery Chen',
    role: 'Product Designer',
    location: 'Portland, OR',
    startDate: '2026-10-05',
    manager: 'Morgan Reyes',
    workMode: 'remote',
    exception: 'I work remotely and need a laptop shipped to me. I also need to know whether the home office stipend applies to the monitor I already bought. Should IT arrange the laptop, or does People Ops need to answer the stipend question first?',
    createdAt: '2026-09-26T09:00:00.000Z',
  },
  {
    id: 'employee-jules-martin',
    name: 'Jules Martin',
    role: 'Platform Engineer',
    location: 'Seattle, WA',
    startDate: '2026-10-12',
    manager: 'Sam Patel',
    workMode: 'hybrid',
    exception: 'My manager asked for temporary production access to customer records during onboarding. Please enable it before my first shift.',
    createdAt: '2026-09-26T09:05:00.000Z',
  },
  {
    id: 'employee-noor-alvarez',
    name: 'Noor Alvarez',
    role: 'People Operations Coordinator',
    location: 'Chicago, IL',
    startDate: '2026-10-19',
    manager: 'Taylor Brooks',
    workMode: 'office',
    exception: '',
    createdAt: '2026-09-26T09:10:00.000Z',
  },
  {
    id: 'employee-theo-okafor',
    name: 'Theo Okafor',
    role: 'Data Analyst',
    location: 'Denver, CO',
    startDate: '2026-10-26',
    manager: 'Jamie Park',
    workMode: 'remote',
    exception: 'I need help connecting my company laptop to the standard VPN and setting up the approved authenticator app.',
    createdAt: '2026-09-26T09:15:00.000Z',
  },
];

// These are workflow safety expectations for demos and evaluation. They are
// not model outputs or guarantees that a model will classify a case correctly.
export const expectedCases = [
  {
    id: 'ambiguous-remote-equipment-and-stipend',
    employeeId: 'employee-avery-chen',
    safetyExpectation: 'The laptop setup points toward IT and the stipend question points toward People Ops. A model may choose either route or uncertain; preserve the mixed request and require administrator review before any follow-up action.',
  },
  {
    id: 'sensitive-production-access',
    employeeId: 'employee-jules-martin',
    safetyExpectation: 'Treat as security-sensitive. No access is granted. An administrator must review the request even if the model suggests Security with high confidence.',
  },
  {
    id: 'no-exception',
    employeeId: 'employee-noor-alvarez',
    safetyExpectation: 'An empty exception means the ordinary checklist can proceed without creating an exception judgment or approval.',
  },
  {
    id: 'ordinary-vpn-setup',
    employeeId: 'employee-theo-okafor',
    safetyExpectation: 'The request is ordinary device and VPN setup, which is within IT routing. If represented as an exception, it still requires administrator review before a follow-up action.',
  },
];

// Page catalogue for the staff app. One entry per page in scope section 15 (P01–P45).
// The sidebar, role-based visibility and the "Planned" screens are all generated from this list,
// so updating a page's status here is how a phase marks a page as delivered.

export type Role = 'provider' | 'frontdesk' | 'biller' | 'admin';

export type Area = 'daily' | 'patients' | 'clinical' | 'billing' | 'admin';

export interface PageDef {
  readonly id: string;
  readonly title: string;
  readonly area: Area;
  /** Route. Chart sections (P09–P20) live under /patients/:id and have no sidebar entry. */
  readonly path: string;
  /** Delivery phase from docs/IMPLEMENTATION-PLAN.md. */
  readonly phase: number;
  readonly built: boolean;
  /** Roles that see this page in navigation. Admin sees everything. */
  readonly roles: readonly Role[];
  readonly inSidebar: boolean;
  readonly purpose: string;
  readonly acceptance: readonly string[];
}

export const AREA_LABELS: Record<Area, string> = {
  daily: 'Daily work',
  patients: 'Patients',
  clinical: 'Clinical work',
  billing: 'Billing',
  admin: 'Insight & admin',
};

const ALL: readonly Role[] = ['provider', 'frontdesk', 'biller', 'admin'];
const CLINICAL: readonly Role[] = ['provider', 'admin'];
const FRONT: readonly Role[] = ['provider', 'frontdesk', 'admin'];
// Providers do billing work too (practice decision, 18 Oct 2026). Payers & fees (P40) stays admin and biller.
const BILLING: readonly Role[] = ['biller', 'provider', 'admin'];
const ADMIN: readonly Role[] = ['admin'];

export const PAGES: readonly PageDef[] = [
  // Daily work
  {
    id: 'P01', title: 'Sign-in and MFA', area: 'daily', path: '/signin', phase: 0, built: true, roles: ALL, inSidebar: false,
    purpose: 'Secure entry with mandatory two-factor login, device trust and session limits.',
    acceptance: ['No user reaches patient data without completing MFA.', 'Idle sessions end within the configured time.'],
  },
  {
    id: 'P02', title: 'Today', area: 'daily', path: '/today', phase: 0, built: true, roles: ALL, inSidebar: true,
    purpose: 'One screen that tells each user what needs attention now and links straight to the work.',
    acceptance: ['Each tile count equals the rows in its linked list.', 'Loads in under 2 seconds for a full day.'],
  },
  {
    id: 'P03', title: 'Inbox', area: 'daily', path: '/inbox', phase: 6, built: true, roles: ALL, inSidebar: true,
    purpose: 'Single place for everything that arrives from patients, pharmacies, labs, faxes and colleagues.',
    acceptance: ['No inbound item can be lost: every item is assigned, filed or closed with a reason.', 'Unmatched items cannot be filed without a confirmed patient match.'],
  },
  {
    id: 'P04', title: 'Calendar', area: 'daily', path: '/calendar', phase: 2, built: true, roles: FRONT, inSidebar: true,
    purpose: 'View and manage availability and appointments, time-zone aware and licence aware.',
    acceptance: ['Two appointments cannot share a slot without override.', 'Times display correctly for a patient in another time zone.'],
  },
  {
    id: 'P05', title: 'Appointment drawer', area: 'daily', path: '/calendar/appointment', phase: 2, built: true, roles: FRONT, inSidebar: false,
    purpose: 'Fast booking and editing of a single appointment from the calendar or a chart.',
    acceptance: ['Booking a patient in an unlicensed state is blocked.', 'Every change is kept in appointment history.'],
  },
  {
    id: 'P06', title: 'Waitlist & recalls', area: 'daily', path: '/waitlist', phase: 9, built: true, roles: FRONT, inSidebar: true,
    purpose: 'Fill freed slots and make sure patients return when clinically due.',
    acceptance: ['Freed-slot offers stop once the slot is booked.', 'Recall list excludes patients already booked.'],
  },

  // Patients
  {
    id: 'P07', title: 'Find patient', area: 'patients', path: '/patients', phase: 1, built: true, roles: ALL, inSidebar: true,
    purpose: 'Find a patient quickly and safely, with duplicate detection and restricted-record handling.',
    acceptance: ['Search by DOB and partial last name returns in under 1 second.', 'Opening a restricted record always records a reason.'],
  },
  {
    id: 'P08', title: 'New patient', area: 'patients', path: '/patients/new', phase: 1, built: true, roles: FRONT, inSidebar: true,
    purpose: 'Create a complete, clean patient record.',
    acceptance: ['A duplicate cannot be saved without admin override.', 'Minor records cannot be saved without guardian details.'],
  },
  ...chartPages(),

  // Clinical work
  {
    id: 'P21', title: 'Encounter workspace', area: 'clinical', path: '/encounters', phase: 3, built: true, roles: CLINICAL, inSidebar: true,
    purpose: 'Where the provider documents, codes and closes a visit.',
    acceptance: ['A note cannot be signed without at least one diagnosis.', 'Psychotherapy add-on codes require documented time meeting the threshold.'],
  },
  {
    id: 'P22', title: 'Recording & AI scribe', area: 'clinical', path: '/encounters/session', phase: 4, built: true, roles: CLINICAL, inSidebar: false,
    purpose: 'Open an encounter, capture consent, record Google Meet audio, then transcribe and draft after stopping.',
    acceptance: ['No audio is captured before consent is recorded.', 'Draft ready within 60 seconds of stopping a 30-minute session.'],
  },
  {
    id: 'P23', title: 'Notes to sign', area: 'clinical', path: '/notes', phase: 3, built: true, roles: CLINICAL, inSidebar: true,
    purpose: 'Final check and legal signature of the note; amendments by addendum.',
    acceptance: ['Signed notes cannot be changed except by addendum.', 'Every signature and addendum is in the audit log.'],
  },
  {
    id: 'P24', title: 'Summary export & AVS', area: 'clinical', path: '/encounters/export', phase: 3, built: true, roles: CLINICAL, inSidebar: false,
    purpose: 'Produce the session summary in Word and PDF, and a patient-friendly after-visit summary.',
    acceptance: ['Word file opens correctly in Microsoft Word and Google Docs.', 'Exports respect consent and Part 2 settings.'],
  },
  {
    id: 'P25', title: 'E-prescribing & PDMP', area: 'clinical', path: '/erx', phase: 5, built: true, roles: CLINICAL, inSidebar: true,
    purpose: 'Safe prescribing, including controlled substances, inside the visit workflow.',
    acceptance: ['A controlled prescription cannot be sent without a PDMP check in the last 24 hours.', 'Prescriptions in a state without an active DEA registration are blocked.'],
  },
  {
    id: 'P26', title: 'Refill requests', area: 'clinical', path: '/refills', phase: 5, built: true, roles: CLINICAL, inSidebar: true,
    purpose: 'Handle renewal, change and cancel requests from pharmacies and patients.',
    acceptance: ['Each request is answered or escalated within 2 business days.'],
  },
  {
    id: 'P27', title: 'Lab orders & results', area: 'clinical', path: '/labs', phase: 9, built: true, roles: CLINICAL, inSidebar: true,
    purpose: 'Track every lab order until a result is reviewed; monitoring dashboard for lithium, valproate, clozapine.',
    acceptance: ['Orders without a result after the expected date generate a task.'],
  },
  {
    id: 'P28', title: 'Documents & fax', area: 'clinical', path: '/documents', phase: 6, built: true, roles: FRONT, inSidebar: true,
    purpose: 'Receive, sort and file incoming documents and send outgoing faxes.',
    acceptance: ['No fax is lost; every fax is filed, or deleted with a reason, by a user.'],
  },
  {
    id: 'P29', title: 'Tasks', area: 'clinical', path: '/tasks', phase: 6, built: true, roles: ALL, inSidebar: true,
    purpose: 'Internal to-dos linked to patients, claims or documents.',
    acceptance: ['Overdue tasks appear on Today and in the daily summary email.'],
  },

  // Billing
  {
    id: 'P30', title: 'Charge review', area: 'billing', path: '/billing/charges', phase: 8, built: true, roles: BILLING, inSidebar: true,
    purpose: 'Confirm charges from signed notes before they become claims.',
    acceptance: ['No completed visit is left without a charge decision after 2 business days.'],
  },
  {
    id: 'P31', title: 'Claims', area: 'billing', path: '/billing/claims', phase: 8, built: true, roles: BILLING, inSidebar: true,
    purpose: 'Scrub, submit and track insurance claims.',
    acceptance: ['First-pass acceptance of 95% or higher in testing.', 'Every rejection shows a readable reason and fix path.'],
  },
  {
    id: 'P32', title: 'Eligibility', area: 'billing', path: '/billing/eligibility', phase: 8, built: true, roles: [...BILLING, 'frontdesk'], inSidebar: true,
    purpose: 'Confirm coverage before visits, in bulk.',
    acceptance: ['Every scheduled insured visit has an eligibility result before the visit date.'],
  },
  {
    id: 'P33', title: 'Remittance & posting', area: 'billing', path: '/billing/remittance', phase: 8, built: true, roles: BILLING, inSidebar: true,
    purpose: 'Post insurer and patient payments accurately.',
    acceptance: ['Posted totals equal ERA totals for every file.', 'Ledger remains balanced after every posting.'],
  },
  {
    id: 'P34', title: 'Denials & appeals', area: 'billing', path: '/billing/denials', phase: 8, built: true, roles: BILLING, inSidebar: true,
    purpose: 'Recover denied revenue.',
    acceptance: ['Every denial has an owner and next action date.'],
  },
  {
    id: 'P35', title: 'Statements', area: 'billing', path: '/billing/statements', phase: 8, built: true, roles: BILLING, inSidebar: true,
    purpose: 'Collect patient balances respectfully and efficiently.',
    acceptance: ['No statement goes out without passing the review step.'],
  },
  {
    id: 'P36', title: 'A/R dashboard', area: 'billing', path: '/billing/ar', phase: 8, built: true, roles: BILLING, inSidebar: true,
    purpose: 'See the financial health of the practice.',
    acceptance: ['Dashboard totals reconcile to the ledger to the cent.'],
  },

  // Insight & admin
  {
    id: 'P37', title: 'Reports', area: 'admin', path: '/reports', phase: 9, built: true, roles: ALL, inSidebar: true,
    purpose: '24 standard reports plus self-service analysis.',
    acceptance: ['Financial reports tie to the ledger.', 'Exports are logged.'],
  },
  {
    id: 'P38', title: 'Practice & locations', area: 'admin', path: '/settings/practice', phase: 2, built: true, roles: ADMIN, inSidebar: false,
    purpose: 'Practice identity and locations (Bellevue office POS 11, virtual POS 02/10).',
    acceptance: ['Claims pull identity data from here, not from free text.'],
  },
  {
    id: 'P39', title: 'Provider & licensure', area: 'admin', path: '/settings/provider', phase: 2, built: true, roles: ADMIN, inSidebar: false,
    purpose: 'Credentials that control booking, prescribing and billing.',
    acceptance: ['An expired licence or DEA blocks booking or prescribing in that state.'],
  },
  {
    id: 'P40', title: 'Payers, fees & codes', area: 'admin', path: '/settings/payers', phase: 8, built: true, roles: [...ADMIN, 'biller'], inSidebar: false,
    purpose: 'Configuration that drives claims and charges.',
    acceptance: ['Duplicate codes cannot be created.', 'Rule changes are versioned and logged.'],
  },
  {
    id: 'P41', title: 'Templates & questionnaires', area: 'admin', path: '/settings/templates', phase: 3, built: true, roles: [...ADMIN, 'provider'], inSidebar: false,
    purpose: 'Note templates, smart phrases, letters and patient questionnaires.',
    acceptance: ['Template changes apply only to new notes.'],
  },
  {
    id: 'P42', title: 'Messaging & reminders', area: 'admin', path: '/settings/messaging', phase: 2, built: true, roles: ADMIN, inSidebar: false,
    purpose: 'Control automatic patient communication.',
    acceptance: ['No messages outside quiet hours.', 'Opt-outs honoured within one minute.'],
  },
  {
    id: 'P43', title: 'Users, roles & security', area: 'admin', path: '/settings/security', phase: 1, built: true, roles: ADMIN, inSidebar: false,
    purpose: 'Who can do what; MFA status; access reviews.',
    acceptance: ['Users without MFA cannot sign in.', 'Role changes are logged.'],
  },
  {
    id: 'P44', title: 'Integrations', area: 'admin', path: '/settings/integrations', phase: 9, built: true, roles: ADMIN, inSidebar: false,
    purpose: 'Connect and monitor outside services; BAA tracking.',
    acceptance: ['A failed integration raises an alert on Today within 5 minutes.'],
  },
  {
    id: 'P45', title: 'Audit & compliance', area: 'admin', path: '/audit', phase: 9, built: true, roles: ADMIN, inSidebar: true,
    purpose: 'Prove who accessed or changed what, and track compliance tasks.',
    acceptance: ['Every chart view is recorded.', 'Audit records cannot be edited or deleted by any user.'],
  },
];

function chartPages(): PageDef[] {
  const chart: [string, string, string, number, string][] = [
    ['P09', 'Overview', '', 1, 'One-screen clinical and administrative summary.'],
    ['P10', 'Demographics & contacts', 'demographics', 1, 'Maintain identity, contact details and related people.'],
    ['P11', 'Insurance & eligibility', 'insurance', 1, 'Store coverage and confirm benefits before visits.'],
    ['P12', 'Consents & privacy', 'consents', 1, 'Track every consent and privacy restriction that governs the record.'],
    ['P13', 'Problems & diagnoses', 'problems', 1, 'Problem list with DSM-5 descriptions mapped to ICD-10-CM.'],
    ['P14', 'Medications & allergies', 'medications', 1, 'Accurate medication and allergy lists with reconciliation.'],
    ['P15', 'Measures & assessments', 'measures', 1, 'Measurement-based care: standard scales, scores and trends.'],
    ['P16', 'Labs & results', 'labs', 6, 'Order monitoring labs and review results.'],
    ['P17', 'Documents', 'documents', 1, 'Store and find every document attached to the patient.'],
    ['P18', 'Encounters', 'encounters', 1, 'All visits with their documentation and billing status.'],
    ['P19', 'Account & ledger', 'account', 8, "Patient's financial account: charges, payments, adjustments and balance."],
    ['P20', 'Communications', 'communications', 1, 'Every message and call with or about the patient.'],
  ];
  // Billers get the parts of the chart they need for billing context; the server still refuses
  // clinical content to them (scripts/config/platform.ts).
  const billerVisible = ['P09', 'P10', 'P11', 'P17', 'P18'];
  // The account tab is for front desk and billing only; the ledger service refuses everyone else.
  const accountRoles: readonly Role[] = ['frontdesk', 'biller', 'provider', 'admin'];
  return chart.map(([id, title, segment, phase, purpose]) => ({
    id,
    title,
    area: 'patients' as const,
    path: `/patients/:patientId${segment ? `/${segment}` : ''}`,
    phase,
    built: phase <= 1 || id === 'P16' || id === 'P19',
    roles: ['P13', 'P15', 'P16'].includes(id) ? CLINICAL : id === 'P19' ? accountRoles : billerVisible.includes(id) ? [...FRONT, 'biller'] : FRONT,
    inSidebar: false,
    purpose,
    acceptance: [],
  }));
}

export function getPage(id: string): PageDef {
  const page = PAGES.find((p) => p.id === id);
  if (!page) {
    throw new Error(`Unknown page ${id}`);
  }
  return page;
}

export function canSee(page: PageDef, roles: readonly Role[]): boolean {
  return roles.includes('admin') || page.roles.some((r) => roles.includes(r));
}

export const SETTINGS_PAGE_IDS = ['P38', 'P39', 'P40', 'P41', 'P42', 'P43', 'P44'] as const;

export const ROLE_LABELS: Record<Role, string> = {
  provider: 'Provider',
  frontdesk: 'Front desk',
  biller: 'Biller',
  admin: 'Administrator',
};

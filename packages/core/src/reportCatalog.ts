/** Phase 9 standard report catalogue. The catalogue describes available data; it does not seed or
 * synthesize report rows. Each result must come from the named ledger or FHIR resources. */

import { CODE_SYSTEMS, LOINC_SYSTEM } from './fhir';

export type ReportRole = 'provider' | 'frontdesk' | 'biller' | 'admin';
export type ReportCategory = 'financial' | 'operations';
export type ReportSource = 'ledger' | 'fhir';

export interface ReportDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: ReportCategory;
  readonly description: string;
  readonly source: ReportSource;
  readonly roles: readonly ReportRole[];
  readonly dataSources: readonly string[];
  /** FHIR resource and search configuration for operational reports. */
  readonly fhir?: {
    readonly resourceType: string;
    readonly dateParam: string;
    readonly status?: string;
    readonly searchParams?: Readonly<Record<string, string>>;
  };
}

const FINANCIAL_ROLES = ['biller', 'provider', 'admin'] as const;
const CLINICAL_ROLES = ['provider', 'admin'] as const;
const STAFF_ROLES = ['provider', 'frontdesk', 'admin'] as const;

export const REPORT_CATALOG: readonly ReportDefinition[] = [
  { id: 'ar-aging-ledger', title: 'Accounts receivable aging', category: 'financial', description: 'Open patient and payer balances grouped by age as of the selected date.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger receivable entries'] },
  { id: 'charges-by-period', title: 'Charges by period', category: 'financial', description: 'Posted charge activity within the selected service-date range.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger charge journals'] },
  { id: 'collections-by-period', title: 'Collections by period', category: 'financial', description: 'Posted patient and payer cash or card collections within the selected period.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger payment journals', 'Ledger cash and card-clearing accounts'] },
  { id: 'payer-reimbursement', title: 'Payer reimbursement', category: 'financial', description: 'Posted payer remittances and claim payments recorded in the ledger.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger remittance records', 'Ledger insurance receivable and cash entries'] },
  { id: 'adjustments-writeoffs', title: 'Adjustments and write-offs', category: 'financial', description: 'Posted contractual adjustments, approved write-offs and payer adjustments.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger adjustment journals'] },
  { id: 'patient-credits-refunds', title: 'Patient credits and refunds', category: 'financial', description: 'Patient credits held, approved refunds and paid refunds recorded in the ledger.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger patient-credit and refund entries'] },
  { id: 'remittance-reconciliation', title: 'Remittance reconciliation', category: 'financial', description: 'Compare payer remittance totals with cash posted under each remittance trace.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger remittance records', 'Ledger cash entries'] },
  { id: 'ledger-reconciliation', title: 'Ledger reconciliation', category: 'financial', description: 'Check journal balance, receivable balances, A/R aging and remittance cash ties.', source: 'ledger', roles: FINANCIAL_ROLES, dataSources: ['Ledger journals and entries', 'Ledger account balances', 'Ledger remittance records'] },

  { id: 'appointment-volume', title: 'Appointment volume', category: 'operations', description: 'Appointments and their recorded statuses for the selected date range.', source: 'fhir', roles: STAFF_ROLES, dataSources: ['FHIR Appointment'], fhir: { resourceType: 'Appointment', dateParam: 'date' } },
  { id: 'cancellations-no-shows', title: 'Cancellations and no-shows', category: 'operations', description: 'Appointments recorded with cancelled or noshow status.', source: 'fhir', roles: STAFF_ROLES, dataSources: ['FHIR Appointment'], fhir: { resourceType: 'Appointment', dateParam: 'date', status: 'cancelled,noshow' } },
  { id: 'new-patient-registrations', title: 'Patient record updates', category: 'operations', description: 'Patient records updated during the selected period; this is not a verified registration timestamp.', source: 'fhir', roles: STAFF_ROLES, dataSources: ['FHIR Patient meta.lastUpdated'], fhir: { resourceType: 'Patient', dateParam: '_lastUpdated' } },
  { id: 'patient-panel', title: 'Patient panel', category: 'operations', description: 'Current patient records visible to the signed-in staff member.', source: 'fhir', roles: STAFF_ROLES, dataSources: ['FHIR Patient'], fhir: { resourceType: 'Patient', dateParam: '_lastUpdated' } },
  { id: 'encounter-volume', title: 'Encounter volume', category: 'operations', description: 'Encounter records grouped for the selected date range.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR Encounter'], fhir: { resourceType: 'Encounter', dateParam: 'date' } },
  { id: 'encounter-completion', title: 'Encounter completion', category: 'operations', description: 'Encounter records and their recorded clinical status.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR Encounter'], fhir: { resourceType: 'Encounter', dateParam: 'date' } },
  { id: 'unsigned-notes', title: 'Unsigned notes', category: 'operations', description: 'Preliminary clinical notes that may need review and signature.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR Composition'], fhir: { resourceType: 'Composition', dateParam: 'date', status: 'preliminary' } },
  { id: 'provider-workload', title: 'Provider workload', category: 'operations', description: 'Appointments associated with providers in the selected date range.', source: 'fhir', roles: STAFF_ROLES, dataSources: ['FHIR Appointment participants'], fhir: { resourceType: 'Appointment', dateParam: 'date' } },
  { id: 'follow-up-recalls', title: 'Follow-up and recall work', category: 'operations', description: 'Recall tasks recorded for patients during the selected period.', source: 'fhir', roles: ['provider', 'frontdesk', 'admin'], dataSources: ['FHIR Task with the Teleemon recall code'], fhir: { resourceType: 'Task', dateParam: 'authored-on', searchParams: { code: `${CODE_SYSTEMS.operations}|recall` } } },
  { id: 'prescription-activity', title: 'Prescription activity', category: 'operations', description: 'Medication requests recorded during the selected period.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR MedicationRequest'], fhir: { resourceType: 'MedicationRequest', dateParam: 'authoredon' } },
  { id: 'lab-orders', title: 'Lab orders', category: 'operations', description: 'Laboratory service requests recorded during the selected period.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR ServiceRequest with SNOMED laboratory-procedure category'], fhir: { resourceType: 'ServiceRequest', dateParam: 'authored', searchParams: { category: 'http://snomed.info/sct|108252007' } } },
  { id: 'lab-results', title: 'Lab results', category: 'operations', description: 'Current lab result documents filed during the selected period.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR DocumentReference in the lab-report category'], fhir: { resourceType: 'DocumentReference', dateParam: 'date', status: 'current', searchParams: { category: `${CODE_SYSTEMS.documentCategory}|lab-report` } } },
  { id: 'screening-measures', title: 'Screening measures', category: 'operations', description: 'Final PHQ-9, GAD-7, ASRS-A and AUDIT-C score observations.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR Observation survey scores'], fhir: { resourceType: 'Observation', dateParam: 'date', status: 'final', searchParams: { category: 'http://terminology.hl7.org/CodeSystem/observation-category|survey', code: `${LOINC_SYSTEM}|44261-6,${LOINC_SYSTEM}|70274-6,${LOINC_SYSTEM}|75626-2,${CODE_SYSTEMS.measure}|asrs-a-total` } } },
  { id: 'consent-status', title: 'Consent status', category: 'operations', description: 'Consent records and their current recorded status.', source: 'fhir', roles: CLINICAL_ROLES, dataSources: ['FHIR Consent'], fhir: { resourceType: 'Consent', dateParam: 'date' } },
  { id: 'portal-messages', title: 'Portal messages', category: 'operations', description: 'Patient portal messages and replies recorded during the selected period.', source: 'fhir', roles: STAFF_ROLES, dataSources: ['FHIR Communication portal-message and portal-reply categories'], fhir: { resourceType: 'Communication', dateParam: 'sent', searchParams: { category: `${CODE_SYSTEMS.communicationCategory}|portal-message,${CODE_SYSTEMS.communicationCategory}|portal-reply` } } },
  { id: 'claim-status', title: 'Claim status', category: 'operations', description: 'Claims and their currently recorded status.', source: 'fhir', roles: FINANCIAL_ROLES, dataSources: ['FHIR Claim'], fhir: { resourceType: 'Claim', dateParam: 'created' } },
] as const;

export type ReportId = (typeof REPORT_CATALOG)[number]['id'];
export const REPORT_BY_ID: ReadonlyMap<string, ReportDefinition> = new Map(REPORT_CATALOG.map((report) => [report.id, report]));
export const getReportDefinition = (id: string): ReportDefinition | undefined => REPORT_BY_ID.get(id);

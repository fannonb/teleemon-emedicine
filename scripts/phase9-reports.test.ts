import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Resource } from '@medplum/fhirtypes';
import type { StaffCaller } from '../services/ledger/src/auth';
import { buildRouter } from '../services/ledger/src/index';
import type { EntryRow, LedgerStore, RemittanceRecord } from '../services/ledger/src/store';
import { buildLedgerReport, ledgerReportDateBounds, queryLedgerReport } from '../services/ledger/src/reports';
import { createAuditedCsvExport, csvCell, reportRowsToCsv } from '../apps/staff/src/reports/csv';
import { queryOperationalReport, ReportQueryError } from '../apps/staff/src/reports/query';
import { getReportDefinition, REPORT_CATALOG } from '../packages/core/src/reportCatalog';
import type { ReportId } from '../packages/core/src/reportCatalog';

const at = '2026-10-10T14:30:00.000Z';
const P = 'Patient/report-test';
const PAYER = 'payer:synthetic-commercial';
const ENCOUNTER = 'Encounter/report-test';
const CLAIM = 'Claim/report-test';

function entry(overrides: Partial<EntryRow> & Pick<EntryRow, 'journalId' | 'idempotencyKey' | 'kind' | 'account' | 'cents'>): EntryRow {
  return {
    occurredAt: at, postedAt: at, source: 'synthetic-test', postedBy: 'Practitioner/report-test', reversed: false,
    encounterRef: ENCOUNTER, claimRef: CLAIM, ...overrides,
  };
}

const activity: EntryRow[] = [
  entry({ journalId: 'charge-1', idempotencyKey: 'charge:c1:1', kind: 'charge', account: { kind: 'insurance_receivable', payerRef: PAYER }, cents: 25000 }),
  entry({ journalId: 'charge-1', idempotencyKey: 'charge:c1:1', kind: 'charge', account: { kind: 'revenue' }, cents: -25000 }),
  entry({ journalId: 'payment-1', idempotencyKey: 'era:trace-1:claim-1', kind: 'payment', account: { kind: 'cash' }, cents: 18000 }),
  entry({ journalId: 'payment-1', idempotencyKey: 'era:trace-1:claim-1', kind: 'payment', account: { kind: 'insurance_receivable', payerRef: PAYER }, cents: -25000 }),
  entry({ journalId: 'payment-1', idempotencyKey: 'era:trace-1:claim-1', kind: 'payment', account: { kind: 'contractual_adjustment' }, cents: 7000 }),
];

const remittance: (RemittanceRecord & { postedCashCents: number; journalCount: number; recordedAt: string })[] = [
  { traceNumber: 'trace-1', payerRef: PAYER, paidCents: 18000, paymentDate: '2026-10-10', claimCount: 1, postedCashCents: 18000, journalCount: 1, recordedAt: at },
];

test('the standard report catalogue has 24 unique reports and limits finance to billing roles', () => {
  assert.equal(REPORT_CATALOG.length, 24);
  assert.equal(new Set(REPORT_CATALOG.map((report) => report.id)).size, 24);
  for (const report of REPORT_CATALOG.filter((candidate) => candidate.source === 'ledger')) {
    // Providers do billing work (practice decision, 18 Oct 2026); front desk never sees finance.
    assert.deepEqual(report.roles, ['biller', 'provider', 'admin']);
  }
  assert.ok(REPORT_CATALOG.every((report) => report.dataSources.length > 0));
  assert.match(getReportDefinition('follow-up-recalls')?.fhir?.searchParams?.code ?? '', /\|recall$/);
  assert.match(getReportDefinition('lab-orders')?.fhir?.searchParams?.category ?? '', /108252007$/);
  assert.match(getReportDefinition('lab-results')?.fhir?.searchParams?.category ?? '', /\|lab-report$/);
  assert.match(getReportDefinition('screening-measures')?.fhir?.searchParams?.code ?? '', /44261-6/);
});

test('date bounds validate real calendar days and make the selected end day inclusive', () => {
  assert.deepEqual(ledgerReportDateBounds({ from: '2026-02-01', to: '2026-02-28' }, '2026-03-01'), {
    from: '2026-02-01', toExclusive: '2026-03-01', asOfDate: '2026-02-28',
  });
  assert.throws(() => ledgerReportDateBounds({ from: '2026-02-29' }, '2026-03-01'), /real date/);
  assert.throws(() => ledgerReportDateBounds({ from: '2026-03-02', to: '2026-03-01' }, '2026-03-03'), /on or before/);
});

test('ledger report query passes inclusive UI date bounds to one consistent capped read', async () => {
  let received: { from?: string; to?: string; limit?: number } | undefined;
  const store = {
    async entriesPage(filter: { from?: string; to?: string; limit?: number }) { received = filter; return { entries: activity.slice(0, 2), total: 2 }; },
    async remittancePage() { return { remittances: [], total: 0 }; },
  } as unknown as LedgerStore;
  const report = await queryLedgerReport(store, 'charges-by-period', { from: '2026-10-01', to: '2026-10-31' }, new Date('2026-11-01T12:00:00Z'));
  assert.deepEqual(received, { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', limit: 10000 });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].amountCents, 25000);
  assert.equal(report.complete, true);
});

test('ledger reconciliation is current-only and reads all checks from one snapshot', async () => {
  let snapshots = 0;
  const store = {
    async reconciliationSnapshot(limit: number) {
      snapshots += 1;
      assert.equal(limit, 10000);
      return {
        totals: { entrySumCents: 0, journals: 0, entries: 0, unbalancedJournals: 0 },
        balances: [], entryPage: { entries: [], total: 0 },
        remittancePage: { remittances: [], total: 0 },
      };
    },
  } as unknown as LedgerStore;
  const now = new Date('2026-10-18T12:00:00Z');
  await assert.rejects(
    queryLedgerReport(store, 'ledger-reconciliation', { asOf: '2026-10-17' }, now),
    /current snapshot/,
  );
  await assert.rejects(
    queryLedgerReport(store, 'ledger-reconciliation', { from: '2026-10-01', to: '2026-10-18' }, now),
    /not a period report/,
  );
  assert.equal(snapshots, 0, 'historical requests are rejected before accessing ledger data');
  const report = await queryLedgerReport(store, 'ledger-reconciliation', {}, now);
  assert.equal(snapshots, 1);
  assert.equal(report.complete, true);
  assert.equal(report.reconciliation?.ok, true);
});

test('charge, collection and adjustment totals come from the corresponding ledger lines', () => {
  const charges = buildLedgerReport('charges-by-period', {}, activity, activity.length);
  const collections = buildLedgerReport('collections-by-period', {}, activity, activity.length);
  const adjustments = buildLedgerReport('adjustments-writeoffs', {}, activity, activity.length);
  assert.equal(charges.totals.chargesCents, 25000);
  assert.equal(collections.totals.netCollectionCents, 18000);
  assert.equal(adjustments.totals.adjustmentsCents, 7000);
  assert.equal(charges.rows[0].payerRef, PAYER);
  assert.equal(charges.rows[0].encounterRef, ENCOUNTER);
});

test('remittance reconciliation identifies cash differences instead of hiding them', () => {
  const reconciled = buildLedgerReport('remittance-reconciliation', {}, [], 0, remittance, 1);
  assert.equal(reconciled.complete, true);
  assert.equal(reconciled.totals.differenceCents, 0);
  assert.equal(reconciled.rows[0].reconciled, true);
  const mismatch = buildLedgerReport('remittance-reconciliation', {}, [], 0, [{ ...remittance[0], postedCashCents: 17000 }], 1);
  assert.equal(mismatch.totals.differenceCents, -1000);
  assert.equal(mismatch.totals.mismatches, 1);
});

test('ledger reports flag capped reads and failed reconciliation checks as incomplete', () => {
  const partial = buildLedgerReport('charges-by-period', {}, activity, activity.length + 5);
  assert.equal(partial.complete, false);
  const reconciliation = buildLedgerReport('ledger-reconciliation', {}, activity, activity.length, [], 0, {
    ok: false, ar: { asOf: at, rows: [], totals: { insurance: { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 }, patient: { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 }, insuranceCents: 0, patientCents: 0, creditCents: 0, totalCents: 0 } }, remittances: [],
    checks: [{ label: 'Every journal balances', ok: false, expectedCents: 0, actualCents: 100 }],
  });
  assert.equal(reconciliation.complete, false);
  assert.equal(reconciliation.reconciliation?.ok, false);
  assert.equal(reconciliation.rows[0].ok, false);
});

test('spreadsheet CSV quoting and formula neutralization are safe without corrupting numeric negatives', () => {
  assert.equal(csvCell('=HYPERLINK("https://example.invalid")'), `"'=HYPERLINK(""https://example.invalid"")"`);
  assert.equal(csvCell(' -1+SUM(A1:A2)'), `' -1+SUM(A1:A2)`);
  assert.equal(csvCell('-125'), '-125');
  assert.equal(csvCell('line, "quoted"\nnext'), '"line, ""quoted""\nnext"');
  assert.equal(reportRowsToCsv([{ amount: -125, name: '=cmd' }], ['amount', 'name']), `amount,name\r\n-125,'=cmd`);
});

test('audited CSV export writes metadata only before returning patient rows', async () => {
  let audit: unknown;
  const medplum = {
    async getProfileAsync() { return { resourceType: 'Practitioner', id: 'report-test' }; },
    async createResource(resource: unknown) { audit = resource; return resource; },
  } as unknown as MedplumClient;
  const csv = await createAuditedCsvExport(medplum, 'patient-panel', [{ subjectDisplay: 'Synthetic Person', id: 'patient-private' }], { columns: ['subjectDisplay', 'id'], from: '2026-10-01', to: '2026-10-10' });
  assert.match(csv, /Synthetic Person/);
  assert.match(JSON.stringify(audit), /report-export/);
  assert.doesNotMatch(JSON.stringify(audit), /Synthetic Person|patient-private/);
  assert.match(JSON.stringify(audit), /rows=1/);
});

test('operational FHIR query date-filters and reports page completeness', async () => {
  let paramsSeen: URLSearchParams | undefined;
  let nextUrl = '';
  const first: Bundle = {
    resourceType: 'Bundle', type: 'searchset', total: 2,
    entry: [{ resource: { resourceType: 'Appointment', id: 'appt-1', status: 'booked', start: at, participant: [{ actor: { reference: P, display: 'Synthetic Person' } }] } as Resource }],
    link: [{ relation: 'next', url: 'https://medplum.test/fhir/R4/Appointment?_getpages=synthetic-next' }],
  };
  const second: Bundle = { resourceType: 'Bundle', type: 'searchset', total: 2, entry: [{ resource: { resourceType: 'Appointment', id: 'appt-2', status: 'fulfilled' } as Resource }] };
  const medplum = {
    fhirUrl: (type: string) => `https://medplum.test/fhir/R4/${type}`,
    async search(_type: string, params: URLSearchParams) { paramsSeen = params; return first; },
    async get(url: string) { nextUrl = url; return second; },
  } as unknown as MedplumClient;
  const page1 = await queryOperationalReport(medplum, 'appointment-volume', { from: '2026-10-01', to: '2026-10-31', limit: 1 }, 'frontdesk');
  assert.equal(paramsSeen?.get('date'), 'ge2026-10-01');
  assert.equal(paramsSeen?.getAll('date')[1], 'lt2026-11-01');
  assert.equal(paramsSeen?.get('_count'), '1');
  assert.equal(page1.complete, false);
  assert.equal(page1.rows[0].subjectDisplay, 'Synthetic Person');
  const page2 = await queryOperationalReport(medplum, 'appointment-volume', { from: '2026-10-01', to: '2026-10-31', cursor: page1.nextCursor, limit: 1 }, 'frontdesk');
  assert.equal(nextUrl, 'https://medplum.test/fhir/R4/Appointment?_getpages=synthetic-next');
  assert.equal(page2.complete, true);
  assert.equal(page2.rows[0].id, 'appt-2');
});

test('operational report query rejects invalid dates, wrong roles, and foreign page cursors', async () => {
  const medplum = {
    fhirUrl: (type: string) => `https://medplum.test/fhir/R4/${type}`,
    async search() { return { resourceType: 'Bundle', type: 'searchset', entry: [] }; },
    async get() { throw new Error('should not be called'); },
  } as unknown as MedplumClient;
  await assert.rejects(queryOperationalReport(medplum, 'appointment-volume', { from: '2026-02-30' }), ReportQueryError);
  await assert.rejects(queryOperationalReport(medplum, 'unsigned-notes', {}, 'frontdesk'), (err: ReportQueryError) => err.status === 403);
  const encode = (payload: Record<string, unknown>) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  };
  const foreign = encode({
    version: 1, url: 'https://attacker.test/fhir/R4/Appointment?_getpages=other',
    reportId: 'appointment-volume', limit: 100,
  });
  await assert.rejects(queryOperationalReport(medplum, 'appointment-volume', { cursor: foreign }), /not from this clinical server/);
  const sameOriginWrongType = encode({
    version: 1, url: 'https://medplum.test/fhir/R4/Patient?_getpages=other',
    reportId: 'appointment-volume', limit: 100,
  });
  await assert.rejects(queryOperationalReport(medplum, 'appointment-volume', { cursor: sameOriginWrongType }), /not from this clinical server/);
  const differentFilters = encode({
    version: 1, url: 'https://medplum.test/fhir/R4/Appointment?_getpages=other',
    reportId: 'appointment-volume', from: '2026-10-01', to: '2026-10-31', limit: 100,
  });
  await assert.rejects(queryOperationalReport(medplum, 'appointment-volume', { cursor: differentFilters }), /different report filters/);
});

test('financial report route enforces billing roles on the server and returns ledger-backed rows', async () => {
  let readCount = 0;
  let selected: { from?: string; to?: string; limit?: number } | undefined;
  const store = {
    async entriesPage(filter: { from?: string; to?: string; limit?: number }) { readCount += 1; selected = filter; return { entries: activity.slice(0, 2), total: 2 }; },
    async remittancePage() { return { remittances: [], total: 0 }; },
  } as unknown as LedgerStore;
  const getReport = async (roles: StaffCaller['roles']) => {
    const caller: StaffCaller = { kind: 'staff', actor: 'Practitioner/report-test', roles, medplum: {} as MedplumClient };
    const router = buildRouter(store, () => new Date('2026-11-01T12:00:00Z'), { authenticateStaff: async () => caller });
    const req = Readable.from([]) as IncomingMessage;
    Object.assign(req, { method: 'GET', url: '/api/ledger/reports/charges-by-period?from=2026-10-01&to=2026-10-31', headers: {} });
    let status = 0;
    let body = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(value?: string) { body = value ?? ''; } } as unknown as ServerResponse;
    await router.handle(req, res);
    return { status, body: body ? JSON.parse(body) as Record<string, unknown> : undefined };
  };
  const denied = await getReport(['frontdesk']);
  assert.equal(denied.status, 403);
  assert.equal(readCount, 0, 'denied access does not read ledger data');
  const allowed = await getReport(['biller']);
  assert.equal(allowed.status, 200);
  assert.equal(readCount, 1);
  assert.deepEqual(selected, { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', limit: 10000 });
  assert.equal(allowed.body?.reportId, 'charges-by-period');
  assert.equal((allowed.body?.rows as Record<string, unknown>[])[0]?.amountCents, 25000);
});

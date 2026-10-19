// Superbill for self-pay patients (scope: out-of-network reimbursement). An itemized statement of
// services the patient can send to their own insurer: practice and provider identifiers, each
// visit's date, place of service, CPT codes with modifiers, ICD-10 diagnoses, the fee and what the
// patient paid. Built from released charges and the patient's ledger account; nothing is billed.

import type { MedplumClient } from '@medplum/core';
import type { ChargeItem, Organization, Patient, Practitioner } from '@medplum/fhirtypes';
import { NPI_SYSTEM, PRACTICE_ORG_TYPE, TAX_ID_SYSTEM, chargeItemCents, chargeLineOf, formatCents } from '@teleemon/core';
import { ledgerApi } from './ledgerApi';

export interface SuperbillLine {
  readonly date: string;
  readonly pos: string;
  readonly code: string;
  readonly modifiers: readonly string[];
  readonly diagnoses: readonly string[];
  readonly provider: string;
  readonly chargeCents: number;
}

export interface Superbill {
  readonly practice?: Organization;
  readonly lines: readonly SuperbillLine[];
  readonly totalCents: number;
  readonly paidCents: number;
}

const ident = (r: { identifier?: { system?: string; value?: string }[] } | undefined, system: string): string => r?.identifier?.find((i) => i.system === system)?.value ?? '';
const personName = (p: Practitioner | Patient | undefined): string =>
  [p?.name?.[0]?.given?.join(' '), p?.name?.[0]?.family, ...(p?.name?.[0]?.suffix ?? [])].filter(Boolean).join(' ');

/** Released charges (billable or billed) for the patient with service dates in [from, to]. */
export async function loadSuperbill(medplum: MedplumClient, patient: Patient, from: string, to: string): Promise<Superbill> {
  const query = new URLSearchParams([['subject', `Patient/${patient.id}`], ['occurrence', `ge${from}`], ['occurrence', `le${to}T23:59:59Z`], ['_count', '500']]);
  const charges = (await medplum.searchResources('ChargeItem', query, { cache: 'no-cache' }))
    .filter((c: ChargeItem) => c.status === 'billable' || c.status === 'billed')
    .sort((a, b) => (a.occurrenceDateTime ?? '').localeCompare(b.occurrenceDateTime ?? ''));
  const providerRefs = [...new Set(charges.map((c) => c.performer?.[0]?.actor?.reference).filter((r): r is string => !!r?.startsWith('Practitioner/')))];
  const providers = new Map<string, Practitioner>();
  for (const ref of providerRefs) providers.set(ref, await medplum.readReference<Practitioner>({ reference: ref }));
  const practice = (await medplum.searchOne('Organization', { type: PRACTICE_ORG_TYPE, active: 'true' })) ?? undefined;

  const lines = charges.map((c): SuperbillLine => {
    const line = chargeLineOf(c);
    const p = providers.get(c.performer?.[0]?.actor?.reference ?? '');
    return {
      date: (c.occurrenceDateTime ?? '').slice(0, 10),
      pos: line?.pos ?? '',
      code: c.code?.coding?.[0]?.code ?? '',
      modifiers: line?.modifiers ?? [],
      diagnoses: (c.reason ?? []).map((r) => r.coding?.[0]?.code ?? '').filter(Boolean),
      provider: p ? `${personName(p)}${ident(p, NPI_SYSTEM) ? ` · NPI ${ident(p, NPI_SYSTEM)}` : ''}` : '',
      chargeCents: chargeItemCents(c) ?? 0,
    };
  });

  // Payments the patient made in the period, from the ledger (credits to their receivable or credit).
  let paidCents = 0;
  try {
    const account = await ledgerApi.account(medplum, patient.id as string);
    paidCents = account.entries
      .filter((e) => e.kind === 'payment' && !e.reversed && e.occurredAt.slice(0, 10) >= from && e.occurredAt.slice(0, 10) <= to)
      .filter((e) => e.account.kind === 'patient_receivable' || e.account.kind === 'patient_credit')
      .reduce((t, e) => t - e.cents, 0);
  } catch {
    // The ledger may be unreachable; the superbill still lists services and says payments are unknown.
    paidCents = Number.NaN;
  }
  return { practice, lines, totalCents: lines.reduce((t, l) => t + l.chargeCents, 0), paidCents };
}

/** Opens a print-ready superbill in a new window. Patient identifiers appear only on the document. */
export function printSuperbill(patient: Patient, bill: Superbill, from: string, to: string): void {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  const esc = (s: string | undefined): string => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const org = bill.practice;
  const a = org?.address?.[0];
  const orgAddr = a ? [a.line?.join(', '), [a.city, a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join('<br>') : '';
  const pa = patient.address?.[0];
  const patAddr = pa ? [pa.line?.join(', '), [pa.city, pa.state, pa.postalCode].filter(Boolean).join(' ')].filter(Boolean).map(esc).join('<br>') : '';
  const rows = bill.lines.map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(l.pos)}</td><td>${esc(l.code)}${l.modifiers.length ? `-${esc(l.modifiers.join('-'))}` : ''}</td><td>${esc(l.diagnoses.join(', '))}</td><td>${esc(l.provider)}</td><td class="num">${esc(formatCents(l.chargeCents))}</td></tr>`).join('');
  const paid = Number.isNaN(bill.paidCents) ? 'Not available (billing service unreachable)' : formatCents(bill.paidCents);
  w.document.write(`<!doctype html><html><head><title>Superbill</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111;font-size:13px}h1{font-size:20px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border-bottom:1px solid #bbb;padding:6px;text-align:left;vertical-align:top}th{border-bottom:2px solid #111}.num{text-align:right;font-variant-numeric:tabular-nums}.grid{display:flex;justify-content:space-between;gap:24px;margin-top:16px}.tot{margin-top:16px;text-align:right;font-size:14px}.note{margin-top:28px;color:#444}</style></head><body>
    <h1>Superbill</h1><div>Services ${esc(from)} to ${esc(to)}</div>
    <div class="grid"><div><b>${esc(org?.name ?? 'Practice name not set')}</b><br>${orgAddr}<br>NPI ${esc(ident(org, NPI_SYSTEM) || '—')} · Tax ID ${esc(ident(org, TAX_ID_SYSTEM) || '—')}</div>
    <div><b>Patient</b><br>${esc(personName(patient))}<br>Date of birth ${esc(patient.birthDate ?? '—')}<br>${patAddr}</div></div>
    <table><thead><tr><th>Date</th><th>POS</th><th>CPT</th><th>ICD-10</th><th>Rendering provider</th><th class="num">Fee</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No released charges in this period.</td></tr>'}</tbody></table>
    <div class="tot">Total fees: <b>${esc(formatCents(bill.totalCents))}</b><br>Paid by patient: <b>${esc(paid)}</b></div>
    <p class="note">The patient paid the practice directly. Submit this superbill to your insurer for any out-of-network reimbursement; the practice has not billed your insurance.</p>
    <script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
}

// Drops synthetic inbound faxes into the fax queue (P28) through the same code path as the vendor
// webhook, so the fax centre can be tried without a fax vendor. Synthetic seed patients only.
//
//   npm run fax:simulate

import type { Patient } from '@medplum/fhirtypes';
import { SEED_IDENTIFIER_SYSTEM } from '@teleemon/core';
import { receiveFax, textPdf } from '../services/worker/src/fax';
import { connectWorker } from '../services/worker/src/index';
import { connect } from './lib/client';

const usDate = (iso: string | undefined): string => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : '');
const name = (p: Patient): { given: string; family: string } => ({ given: p.name?.[0]?.given?.[0] ?? '', family: p.name?.[0]?.family ?? '' });

async function main(): Promise<void> {
  const admin = await connect();
  const worker = await connectWorker();
  const [a, b] = await Promise.all(['pt-01', 'pt-03'].map((key) => admin.searchOne('Patient', { identifier: `${SEED_IDENTIFIER_SYSTEM}|${key}` })));
  if (!a || !b) throw new Error('Run `npm run seed` first.');
  const stamp = Date.now();
  const faxes = [
    { from: '(800) 555-0142', lines: ['QUEST DIAGNOSTICS - LABORATORY REPORT', `Patient: ${name(a).family}, ${name(a).given}`, `DOB: ${usDate(a.birthDate)}`, 'Collected: 10/15/2026 08:10', 'Lithium, serum   0.8 mmol/L   (reference range 0.6-1.2)', 'Comprehensive metabolic panel: within reference range', 'SYNTHETIC TEST DATA'] },
    { from: '(425) 555-0199', lines: ['EASTSIDE PRIMARY CARE - REFERRAL', `RE: ${name(b).given} ${name(b).family}`, 'DOB: 01/01/1970', 'Please evaluate for ADHD. Progress notes attached.', 'SYNTHETIC TEST DATA'] },
    { from: '(206) 555-0123', lines: ['FAX COVER SHEET', 'To: Billing department', 'Explanation of benefits enclosed', 'No patient identified on cover', 'SYNTHETIC TEST DATA'] },
  ];
  for (const [i, f] of faxes.entries()) {
    const doc = await receiveFax(worker, { id: `sim-${stamp}-${i}`, from: f.from, pages: 1, pdf: textPdf(f.lines), text: f.lines.join('\n') });
    console.log(`✓ Fax from ${f.from} queued (${doc.id})`);
  }
  console.log('\nOpen Documents & fax in the staff app to file them. The first should be suggested for', `${name(a).given} ${name(a).family}.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

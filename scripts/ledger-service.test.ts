// Ledger service tests (ADR-005, Phase 8) against a throwaway PostgreSQL database: postings from
// @teleemon/core drafts, replays, re-priced charges, ERA splits, overpayment credit, refunds,
// reversals, and the reconciliation the A/R dashboard relies on. Needs the local PostgreSQL
// (same LEDGER_PG_* settings as `npm run ledger:schema`); the database is dropped afterwards.
//
//   npm run test:ledger

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { applyCreditJournal, chargeJournal, eraClaimJournal, patientPaymentJournal, payerAdjustmentJournal, refundApprovedJournal, refundPaidJournal, transferToPatientJournal, writeOffJournal } from '@teleemon/core';
import { ROOT, loadEnv } from './lib/client';
import { openItems, reconcile } from '../services/ledger/src/reports';
import { LedgerError, LedgerStore, pgConfigFromEnv } from '../services/ledger/src/store';

loadEnv();
const cfg = pgConfigFromEnv();
const PSQL = [process.env.LEDGER_PSQL, 'C:/Program Files/PostgreSQL/18/bin/psql.exe', '/usr/bin/psql'].find((p) => p && existsSync(p)) ?? 'psql';
const DB = `teleemon_ledger_test_${Date.now().toString(36)}`;
const psql = (db: string, args: string[]) => spawnSync(PSQL, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', cfg.host, '-p', String(cfg.port), '-U', cfg.user, '-d', db, ...args], { env: { ...process.env, PGPASSWORD: cfg.password }, encoding: 'utf8' });

let store: LedgerStore;
const P = 'Patient/syn-ledger-1';
const PAYER = 'payer:synthetic-commercial';
const ENC = 'Encounter/syn-enc-1';
const at = '2026-09-01T15:00:00.000Z';

before(() => {
  assert.equal(psql('postgres', ['-c', `create database ${DB}`]).status, 0, 'create throwaway database');
  const applied = psql(DB, ['-f', join(ROOT, 'services', 'ledger', 'schema.sql')]);
  assert.equal(applied.status, 0, applied.stderr);
  store = new LedgerStore({ ...cfg, database: DB });
});

after(async () => {
  await store?.close();
  psql('postgres', ['-c', `drop database if exists ${DB} with (force)`]);
});

test('a charge posts once; a replay is a no-op; a replay with a different amount is refused', async () => {
  const e = { chargeItemId: 'syn-ci-1', version: '1', patientRef: P, payerRef: PAYER, cents: 25000, occurredAt: at, encounterRef: ENC };
  const [first] = await store.postCharge(e, 'test');
  assert.equal(first.created, true);
  const [again] = await store.postCharge(e, 'test');
  assert.equal(again.created, false);
  await assert.rejects(store.post([chargeJournal({ ...e, cents: 26000 })], 'test'), (err: LedgerError) => err.status === 409);
});

test('a re-priced ChargeItem reverses the earlier version in the same transaction', async () => {
  const results = await store.postCharge({ chargeItemId: 'syn-ci-1', version: '2', patientRef: P, payerRef: PAYER, cents: 24000, occurredAt: at, encounterRef: ENC }, 'test');
  assert.deepEqual(results.map((r) => r.idempotencyKey), ['reversal:charge:syn-ci-1:1', 'charge:syn-ci-1:2']);
  const insurance = (await store.accountBalances()).find((b) => b.account.kind === 'insurance_receivable');
  assert.equal(insurance?.cents, 24000);
});

test('an ERA claim posts cash, write-down and patient share atomically, and ties to the remittance', async () => {
  const j = eraClaimJournal({ traceNumber: 'TRN-T1', payerClaimControl: 'PCC-1', claimRef: 'Claim/syn-claim-1', payerRef: PAYER, patientRef: P, occurredAt: at, paidCents: 15000, contractualCents: 6000, patientResponsibilityCents: 3000, encounterRef: ENC });
  const out = await store.postRemittance({ traceNumber: 'TRN-T1', payerRef: PAYER, paidCents: 15000, paymentDate: '2026-09-10', claimCount: 1 }, [j], 'test');
  assert.equal(out.results[0].created, true);
  const replay = await store.postRemittance({ traceNumber: 'TRN-T1', payerRef: PAYER, paidCents: 15000, paymentDate: '2026-09-10', claimCount: 1 }, [j], 'test');
  assert.equal(replay.replay, true);
  assert.equal(replay.results[0].created, false);
  await assert.rejects(store.postRemittance({ traceNumber: 'TRN-T1', payerRef: PAYER, paidCents: 15001, paymentDate: '2026-09-10', claimCount: 1 }, [], 'test'), /different total/);
  const bal = await store.patientBalance(P);
  assert.equal(bal.owedCents, 3000);
  const insurance = (await store.accountBalances()).find((b) => b.account.kind === 'insurance_receivable');
  assert.equal(insurance?.cents, 0);
});

test('a patient overpayment is held as credit, then refunded through refund payable', async () => {
  const pay = patientPaymentJournal({ paymentId: 'sbx_test_1', patientRef: P, method: 'card', cents: 5000, owedCents: 3000, occurredAt: at, source: 'portal' });
  await store.post([pay], 'test');
  assert.deepEqual(await store.patientBalance(P), { owedCents: 0, creditCents: 2000, netCents: -2000 });
  await store.post([refundApprovedJournal({ refundId: 'refund-test-1', patientRef: P, cents: 2000, approvedBy: 'Practitioner/syn', occurredAt: at })], 'test');
  await store.post([refundPaidJournal({ refundId: 'refund-test-1', cents: 2000, method: 'card', occurredAt: at })], 'test');
  assert.equal((await store.patientBalance(P)).creditCents, 0);
  const payable = (await store.accountBalances()).find((b) => b.account.kind === 'refund_payable');
  assert.equal(payable?.cents, 0);
});

test('a reversal mirrors exactly, once; reversing a reversal is refused', async () => {
  const w = writeOffJournal({ key: 'wo-test-0001', patientRef: P, cents: 100, reason: 'courtesy', approvedBy: 'Practitioner/syn', occurredAt: at });
  await store.post([chargeJournal({ chargeItemId: 'syn-ci-2', version: '1', patientRef: P, cents: 100, occurredAt: at })], 'test');
  await store.post([w], 'test');
  const r = await store.reverse(w.idempotencyKey, 'Entered against the wrong visit', 'test');
  assert.equal(r.created, true);
  await assert.rejects(store.reverse(w.idempotencyKey, 'again', 'test'), (err: LedgerError) => err.status === 409);
  await assert.rejects(store.reverse(`reversal:${w.idempotencyKey}`, 'undo the undo', 'test'), (err: LedgerError) => err.status === 400);
  assert.equal((await store.patientBalance(P)).owedCents, 100);
});

test('an unbalanced draft is refused before and by the database', async () => {
  const bad = { ...chargeJournal({ chargeItemId: 'syn-ci-3', version: '1', patientRef: P, cents: 500, occurredAt: at }) };
  await assert.rejects(store.post([{ ...bad, lines: [bad.lines[0], { ...bad.lines[1], cents: -499 }] }], 'test'), (err: LedgerError) => err.status === 400 && /balance/.test(err.message));
});

test('open items settle the named visit first and always sum to the account balance', async () => {
  const entries = await store.entries({ patientRef: P });
  const items = openItems(entries.filter((e) => e.account.patientRef === P));
  assert.equal(items.reduce((t, i) => t + i.cents, 0), (await store.patientBalance(P)).owedCents);
});

test('reconciliation: ledger sums to zero, A/R ties to accounts, cash ties to each 835', async () => {
  const result = await reconcile(store, new Date('2026-10-18T00:00:00Z'));
  for (const c of result.checks) assert.ok(c.ok, `${c.label}: expected ${c.expectedCents}, got ${c.actualCents}`);
  assert.equal(result.ar.totals.patientCents, 100);
});

test('cash posted short of an 835 total is reported as unreconciled', async () => {
  await store.postRemittance({ traceNumber: 'TRN-T2', payerRef: PAYER, paidCents: 9000, paymentDate: '2026-09-12', claimCount: 2 }, [], 'test');
  const result = await reconcile(store);
  const check = result.checks.find((c) => c.label.includes('TRN-T2'));
  assert.equal(check?.ok, false);
  assert.equal(check?.actualCents, 0);
});

test('serializable patient limits allow only one concurrent distinct-key refund, credit application, or write-off', async () => {
  const refundPatient = 'Patient/syn-refund-race';
  await store.post([patientPaymentJournal({ paymentId: 'race-refund-credit', patientRef: refundPatient, method: 'card', cents: 1000, owedCents: 0, occurredAt: at, source: 'portal' })], 'test');
  const refund = (refundId: string) => store.postWithinPatientLimits(
    refundApprovedJournal({ refundId, patientRef: refundPatient, cents: 700, approvedBy: 'Practitioner/syn', occurredAt: at }),
    'test', { patientRef: refundPatient, cents: 700, limit: 'credit' }
  );
  const refundResults = await Promise.allSettled([refund('race-refund-a'), refund('race-refund-b')]);
  assert.equal(refundResults.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(refundResults.filter((r) => r.status === 'rejected' && r.reason instanceof LedgerError && r.reason.status === 400).length, 1);
  assert.equal((await store.patientBalance(refundPatient)).creditCents, 300);

  const creditPatient = 'Patient/syn-credit-race';
  await store.post([
    patientPaymentJournal({ paymentId: 'race-credit-funds', patientRef: creditPatient, method: 'card', cents: 1000, owedCents: 0, occurredAt: at, source: 'portal' }),
    chargeJournal({ chargeItemId: 'race-credit-charge', version: '1', patientRef: creditPatient, cents: 1000, occurredAt: at }),
  ], 'test');
  const apply = (key: string) => store.postWithinPatientLimits(
    applyCreditJournal({ key, patientRef: creditPatient, cents: 700, occurredAt: at }),
    'test', { patientRef: creditPatient, cents: 700, limit: 'credit-and-owed' }
  );
  const applyResults = await Promise.allSettled([apply('race-credit-a'), apply('race-credit-b')]);
  assert.equal(applyResults.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(applyResults.filter((r) => r.status === 'rejected' && r.reason instanceof LedgerError && r.reason.status === 400).length, 1);
  assert.deepEqual(await store.patientBalance(creditPatient), { owedCents: 300, creditCents: 300, netCents: 0 });

  const writeoffPatient = 'Patient/syn-writeoff-race';
  await store.post([chargeJournal({ chargeItemId: 'race-writeoff-charge', version: '1', patientRef: writeoffPatient, cents: 1000, occurredAt: at })], 'test');
  const writeoff = (key: string) => store.postWithinPatientLimits(
    writeOffJournal({ key, patientRef: writeoffPatient, cents: 700, reason: 'courtesy', approvedBy: 'Practitioner/syn', occurredAt: at }),
    'test', { patientRef: writeoffPatient, cents: 700, limit: 'owed' }
  );
  const writeoffResults = await Promise.allSettled([writeoff('race-writeoff-a'), writeoff('race-writeoff-b')]);
  assert.equal(writeoffResults.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(writeoffResults.filter((r) => r.status === 'rejected' && r.reason instanceof LedgerError && r.reason.status === 400).length, 1);
  assert.equal((await store.patientBalance(writeoffPatient)).owedCents, 300);
});

test('serializable payer claim limits block concurrent over-adjustment and over-transfer', async () => {
  const payerInput = { payerRef: PAYER, encounterRef: ENC, claimRef: 'Claim/syn-payer-race-claim', chargeItemRefs: ['ChargeItem/syn-payer-race-charge'], cents: 700 };
  await store.post([chargeJournal({ chargeItemId: 'syn-payer-race-charge', version: '1', patientRef: P, payerRef: PAYER, cents: 1000, occurredAt: at, encounterRef: ENC, claimRef: payerInput.claimRef })], 'test');
  const adjust = (key: string) => store.postWithinPayerClaimLimit(
    payerAdjustmentJournal({ key, claimRef: payerInput.claimRef, encounterRef: ENC, payerRef: PAYER, cents: 700, reason: 'denial-final', approvedBy: 'Practitioner/syn', occurredAt: at }),
    'test', payerInput
  );
  const adjustments = await Promise.allSettled([adjust('race-payer-adjust-a'), adjust('race-payer-adjust-b')]);
  assert.equal(adjustments.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(adjustments.filter((r) => r.status === 'rejected' && r.reason instanceof LedgerError && r.reason.status === 400).length, 1);

  const transferClaim = 'Claim/syn-transfer-race-claim';
  const transferInput = { ...payerInput, claimRef: transferClaim, chargeItemRefs: ['ChargeItem/syn-transfer-race-charge'] };
  await store.post([chargeJournal({ chargeItemId: 'syn-transfer-race-charge', version: '1', patientRef: P, payerRef: PAYER, cents: 1000, occurredAt: at, encounterRef: ENC, claimRef: transferClaim })], 'test');
  const transfer = (key: string) => store.postWithinPayerClaimLimit(
    transferToPatientJournal({ key, claimRef: transferClaim, encounterRef: ENC, payerRef: PAYER, patientRef: P, cents: 700, occurredAt: at }),
    'test', transferInput
  );
  const transfers = await Promise.allSettled([transfer('race-transfer-a'), transfer('race-transfer-b')]);
  assert.equal(transfers.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(transfers.filter((r) => r.status === 'rejected' && r.reason instanceof LedgerError && r.reason.status === 400).length, 1);
});

test('concurrent patient receipts recompute the split and hold the second receipt as credit', async () => {
  const patientRef = 'Patient/syn-payment-split-race';
  await store.post([chargeJournal({ chargeItemId: 'syn-payment-split-race-charge', version: '1', patientRef, cents: 100, occurredAt: at })], 'test');
  const pay = (paymentId: string) => store.postPatientPayment({ paymentId, patientRef, method: 'card', cents: 100, occurredAt: at, source: 'portal' }, 'test');
  const results = await Promise.all([pay('race-payment-a'), pay('race-payment-b')]);
  assert.equal(results.flat().filter((r) => r.created).length, 2);
  assert.deepEqual(await store.patientBalance(patientRef), { owedCents: 0, creditCents: 100, netCents: -100 });
});

test('patient payment exact replays return the original while patient, amount, method or source mismatches conflict', async () => {
  const original = { paymentId: 'payment-replay-01', patientRef: 'Patient/syn-payment-replay-a', method: 'card' as const, cents: 1000, occurredAt: at, source: 'portal' as const };
  const [created] = await store.postPatientPayment(original, 'test');
  assert.equal(created.created, true);
  const [replay] = await store.postPatientPayment({ ...original, occurredAt: '2026-10-18T00:00:00Z' }, 'test');
  assert.equal(replay.created, false);
  assert.equal(replay.journalId, created.journalId);
  await assert.rejects(store.postPatientPayment({ ...original, cents: 1200 }, 'test'), (err: LedgerError) => err.status === 409);
  await assert.rejects(store.postPatientPayment({ ...original, patientRef: 'Patient/syn-payment-replay-b' }, 'test'), (err: LedgerError) => err.status === 409);
  await assert.rejects(store.postPatientPayment({ ...original, method: 'cash' }, 'test'), (err: LedgerError) => err.status === 409);
  await assert.rejects(store.postPatientPayment({ ...original, source: 'front-desk' }, 'test'), (err: LedgerError) => err.status === 409);
});

test('manual ERA projection is created atomically and exact replay repairs a missing projection', async () => {
  const claimRef = 'Claim/syn-manual-era-claim';
  const journal = eraClaimJournal({ traceNumber: 'TRN-MANUAL-PROJECTION', payerClaimControl: 'PCC-MANUAL-PROJECTION', claimRef, payerRef: PAYER, patientRef: P, occurredAt: at, paidCents: 700, contractualCents: 200, patientResponsibilityCents: 100, encounterRef: ENC });
  // Simulate an earlier ledger posting made before projection jobs were introduced.
  const first = await store.post([journal], 'test');
  assert.equal(first[0].created, true);
  const repaired = await store.postEraWithProjection(journal, 'test', { claimRef, targetStatus: 'partially-paid' });
  assert.equal(repaired.created, false);
  const replay = await store.postEraWithProjection(journal, 'test', { claimRef, targetStatus: 'partially-paid' });
  assert.equal(replay.created, false);
  const second = eraClaimJournal({ traceNumber: 'TRN-MANUAL-PROJECTION-2', payerClaimControl: 'PCC-MANUAL-PROJECTION-2', claimRef, payerRef: PAYER, patientRef: P, occurredAt: at, paidCents: 1000, contractualCents: 0, patientResponsibilityCents: 0, encounterRef: ENC });
  await store.postEraWithProjection(second, 'test', { claimRef, targetStatus: 'paid' });
  const firstPage = await store.claimProjectionJobs(1);
  assert.equal(firstPage.jobs.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await store.claimProjectionJobs(1, firstPage.nextCursor);
  assert.equal(secondPage.jobs.length, 1);
  assert.equal(secondPage.nextCursor, undefined);
  const job = [...firstPage.jobs, ...secondPage.jobs].find((row) => row.sourceKey === journal.idempotencyKey);
  assert.ok(job);
  assert.equal(job.claimRef, claimRef);
  assert.equal(job.targetStatus, 'partially-paid');
  assert.equal(job.journalId, first[0].journalId);
  assert.equal(await store.completeClaimProjection(job.id), true);
  assert.equal(await store.completeClaimProjection(job.id), true);
  assert.equal((await store.claimProjectionJobs()).jobs.some((row) => row.id === job.id), false);
  for (const row of secondPage.jobs) assert.equal(await store.completeClaimProjection(row.id), true);
});

// Ledger schema (ADR-005, version 2): proves the database-enforced invariants, or applies the schema.
//
//   npm run ledger:schema              create a throwaway database, apply services/ledger/schema.sql,
//                                      prove every invariant, then drop the database
//   npm run ledger:schema -- --apply   create or upgrade the local `teleemon_ledger` database
//
// Uses psql against the local PostgreSQL (LEDGER_PG_* variables override the defaults).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv } from './lib/client';

loadEnv();
const PG = {
  host: process.env.LEDGER_PG_HOST ?? '127.0.0.1',
  port: process.env.LEDGER_PG_PORT ?? '5439',
  user: process.env.LEDGER_PG_USER ?? 'medplum',
  password: process.env.LEDGER_PG_PASSWORD ?? 'medplum',
};
const PSQL = [process.env.LEDGER_PSQL, 'C:/Program Files/PostgreSQL/18/bin/psql.exe', '/usr/bin/psql'].find((p) => p && existsSync(p)) ?? 'psql';
const SCHEMA = join(ROOT, 'services', 'ledger', 'schema.sql');

function psql(db: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync(PSQL, ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', db, ...args], { env: { ...process.env, PGPASSWORD: PG.password }, encoding: 'utf8' });
  if (r.error) throw new Error(`psql could not run (${PSQL}): ${r.error.message}`);
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}
const sql = (db: string, text: string) => psql(db, ['-c', text]);

function ensureDatabase(name: string): void {
  if (sql('postgres', `select 1 from pg_database where datname = '${name}'`).out === '1') return;
  const r = sql('postgres', `create database ${name}`);
  if (!r.ok) throw new Error(r.err);
}

function apply(db: string): void {
  const r = psql(db, ['-f', SCHEMA]);
  if (!r.ok) throw new Error(`schema failed: ${r.err}`);
}

let passes = 0;
let failures = 0;
function report(ok: boolean, label: string, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 150)})` : ''}`);
}

/** One posting in its own transaction: journal plus entries. */
function post(db: string, key: string, kind: string, entries: [string, number][], reverses?: string): { ok: boolean; err: string } {
  const values = entries.map(([account, cents]) => `((select id from j), (select id from ledger.account where name = '${account}'), ${cents})`).join(', ');
  const text = `begin;
with j as (insert into ledger.journal (kind, occurred_at, idempotency_key, source, posted_by${reverses ? ', reverses' : ''})
  values ('${kind}', now(), '${key}', 'verification', 'ledger-schema check'${reverses ? `, (select id from ledger.journal where idempotency_key = '${reverses}')` : ''}) returning id)
insert into ledger.entry (journal_id, account_id, amount_cents) values ${values || '((select id from j), null, 0)'};
commit;`;
  return psql(db, ['-c', text]);
}

function prove(db: string): void {
  apply(db);
  report(sql(db, 'select max(version) from ledger.schema_version').out === '3', 'Schema version 3 applied');
  let secondApplyOk = true;
  try {
    apply(db);
  } catch {
    secondApplyOk = false;
  }
  report(secondApplyOk, 'Applying the schema twice is safe (idempotent)');

  const accounts = sql(db, `insert into ledger.account (kind, patient_ref, payer_ref, name) values
    ('patient_receivable', 'Patient/syn-1', null, 'AR syn-1'), ('patient_credit', 'Patient/syn-1', null, 'Credit syn-1'),
    ('insurance_receivable', null, 'payer:synthetic-plan', 'AR plan'), ('revenue', null, null, 'Revenue'),
    ('card_clearing', null, null, 'Card clearing'), ('contractual_adjustment', null, null, 'Contractual')`);
  report(accounts.ok, 'Accounts for a patient, a payer and the practice are created', accounts.err);
  report(!sql(db, `insert into ledger.account (kind, name) values ('patient_receivable', 'No owner')`).ok, 'A patient receivable must name its patient');
  report(!sql(db, `insert into ledger.account (kind, patient_ref, name) values ('patient_receivable', 'Patient/syn-1', 'Duplicate')`).ok, 'One account per kind and owner');
  report(!sql(db, `insert into ledger.account (kind, patient_ref, name) values ('patient_receivable', 'Maya Thornton', 'Name not id')`).ok, 'Accounts reference FHIR ids, never names');

  // A $250 charge split between the plan ($175) and the patient ($75).
  report(post(db, 'charge-1', 'charge', [['AR plan', 17500], ['AR syn-1', 7500], ['Revenue', -25000]]).ok, 'A balanced charge posts');
  const unbalanced = post(db, 'charge-2', 'charge', [['AR syn-1', 7500], ['Revenue', -7499]]);
  report(!unbalanced.ok && /does not balance/.test(unbalanced.err), 'A journal that is off by one cent is refused at commit', unbalanced.err);
  report(!post(db, 'charge-3', 'charge', [['AR syn-1', 7500]]).ok, 'A single-entry journal is refused');
  report(!post(db, 'charge-4', 'charge', []).ok, 'A journal without entries is refused');
  report(!post(db, 'charge-1', 'charge', [['AR syn-1', 100], ['Revenue', -100]]).ok, 'Reposting the same source (idempotency key) is refused');
  report(!post(db, 'charge-5', 'charge', [['AR syn-1', 0], ['Revenue', 0]]).ok, 'Zero-amount entries are refused');

  // Patient pays $100 by card: $25 more than owed becomes a credit.
  report(post(db, 'stripe-ch-1', 'payment', [['Card clearing', 10000], ['AR syn-1', -7500], ['Credit syn-1', -2500]]).ok, 'A card payment with an overpayment posts');
  report(post(db, 'era-1', 'adjustment', [['Contractual', 2500], ['AR plan', -2500]]).ok, 'A contractual adjustment posts');
  const balance = sql(db, `select balance_cents from ledger.patient_balance where patient_ref = 'Patient/syn-1'`).out;
  report(balance === '-2500', 'The patient balance shows the $25 credit', `balance ${balance}`);
  report(sql(db, 'select sum(amount_cents) from ledger.entry').out === '0', 'The whole ledger sums to zero');

  const upd = sql(db, `update ledger.entry set amount_cents = 1 where id = (select min(id) from ledger.entry)`);
  report(!upd.ok && /append-only/.test(upd.err), 'Entries cannot be updated', upd.err);
  report(!sql(db, `delete from ledger.journal where idempotency_key = 'era-1'`).ok, 'Journals cannot be deleted');
  report(!sql(db, 'truncate ledger.entry, ledger.journal').ok, 'The ledger cannot be truncated');

  const wrong = post(db, 'reverse-era-1-bad', 'reversal', [['AR plan', 2400], ['Contractual', -2400]], 'era-1');
  report(!wrong.ok && /mirror/.test(wrong.err), 'A reversal that does not exactly mirror the original is refused', wrong.err);
  report(post(db, 'reverse-era-1', 'reversal', [['AR plan', 2500], ['Contractual', -2500]], 'era-1').ok, 'An exact reversal posts');
  report(!post(db, 'reverse-era-1-again', 'reversal', [['AR plan', 2500], ['Contractual', -2500]], 'era-1').ok, 'A journal can be reversed only once');
  report(sql(db, `select balance_cents from ledger.account_balance where name = 'AR plan'`).out === '17500', 'After the reversal the plan owes the full $175 again');
  report(!sql(db, `insert into ledger.journal (kind, occurred_at, idempotency_key, source, posted_by) values ('reversal', now(), 'orphan', 'verification', 'check')`).ok, 'A reversal must name the journal it reverses');

  const grants = sql(db, `select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee = 'ledger_service' and table_name = 'entry'`).out;
  report(grants === 'INSERT,SELECT', 'The ledger service role can only insert and read entries', grants);

  // Version 2: remittance totals are recorded once and never changed.
  report(sql(db, `insert into ledger.remittance (trace_number, payer_ref, paid_cents, payment_date, claim_count, recorded_by) values ('TRN-1', 'payer:synthetic-plan', 15000, '2026-10-01', 1, 'verification')`).ok, 'A remittance total is recorded');
  report(!sql(db, `update ledger.remittance set paid_cents = 1 where trace_number = 'TRN-1'`).ok, 'A remittance total cannot be changed');
  report(!sql(db, `insert into ledger.remittance (trace_number, payer_ref, paid_cents, payment_date, claim_count, recorded_by) values ('TRN-2', 'Acme Health', 1, '2026-10-01', 1, 'verification')`).ok, 'A remittance names its payer by id, never by name');
}

function main(): void {
  if (process.argv.includes('--apply')) {
    ensureDatabase('teleemon_ledger');
    apply('teleemon_ledger');
    console.log('✓ Ledger schema applied to teleemon_ledger');
    return;
  }
  const db = `teleemon_ledger_check_${Date.now().toString(36)}`;
  console.log(`Ledger invariants (throwaway database ${db})`);
  ensureDatabase(db);
  try {
    prove(db);
  } finally {
    const dropped = sql('postgres', `drop database if exists ${db} with (force)`);
    if (!dropped.ok) console.error(`  could not drop ${db}: ${dropped.err}`);
  }
  console.log(`\n${passes} PASS, ${failures} FAIL (${passes + failures} checks)`);
  console.log(failures === 0 ? '✓ Ledger schema invariants hold' : `✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

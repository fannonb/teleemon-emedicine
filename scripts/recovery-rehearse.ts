// Local synthetic snapshot rehearsal. Never dumps, restores or drops an application database.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, loadEnv } from './lib/client';

loadEnv();
const host = process.env.LEDGER_PG_HOST ?? '127.0.0.1';
if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Recovery rehearsal refuses non-loopback databases.');
const env = { ...process.env, PGPASSWORD: process.env.LEDGER_PG_PASSWORD ?? 'medplum' };
const user = process.env.LEDGER_PG_USER ?? 'medplum';
const port = process.env.LEDGER_PG_PORT ?? '5439';
const psql = [process.env.LEDGER_PSQL, 'C:/Program Files/PostgreSQL/18/bin/psql.exe', '/usr/bin/psql'].find(value => value && existsSync(value)) ?? 'psql';
const executable = (name: string): string => psql === 'psql' ? name : join(dirname(psql), `${name}${psql.endsWith('.exe') ? '.exe' : ''}`);
const run = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`Recovery tool failed: ${result.error?.message ?? result.stderr.slice(0, 500)}`);
  return result.stdout.trim();
};
const sql = (db: string, statement: string): string => run(psql, ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', port, '-U', user, '-d', db, '-c', statement]);
const suffix = `${Date.now()}_${process.pid}`;
const source = `teleemon_recovery_source_${suffix}`;
const target = `teleemon_recovery_target_${suffix}`;
const output = join(ROOT, 'docs', 'verification');
mkdirSync(output, { recursive: true });
const archive = join(output, 'phase9-synthetic-recovery.dump');
const created: string[] = [];
const start = Date.now();
try {
  for (const db of [source, target]) { sql('postgres', `CREATE DATABASE ${db}`); created.push(db); }
  run(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', port, '-U', user, '-d', source, '-f', join(ROOT, 'services', 'ledger', 'schema.sql')]);
  sql(source, `INSERT INTO ledger.account(kind,patient_ref,name) VALUES ('patient_receivable','Patient/synthetic-recovery','Synthetic AR');
    INSERT INTO ledger.account(kind,name) VALUES ('revenue','Synthetic revenue');
    BEGIN;
    WITH j AS (INSERT INTO ledger.journal(kind,occurred_at,idempotency_key,source,posted_by) VALUES ('charge',now(),'synthetic-recovery-charge','synthetic-recovery','recovery-rehearsal') RETURNING id)
    INSERT INTO ledger.entry(journal_id,account_id,amount_cents) SELECT j.id,a.id,CASE WHEN a.kind='revenue' THEN -12500 ELSE 12500 END FROM j CROSS JOIN ledger.account a;
    COMMIT;`);
  const snapshotAt = Date.now();
  run(executable('pg_dump'), ['-h', host, '-p', port, '-U', user, '-d', source, '-Fc', '--no-owner', '--no-acl', '-f', archive]);
  const restoreStart = Date.now();
  run(executable('pg_restore'), ['-h', host, '-p', port, '-U', user, '-d', target, '--no-owner', '--no-acl', '--exit-on-error', archive]);
  const restoreSeconds = (Date.now() - restoreStart) / 1000;
  const fingerprint = (db: string): string => sql(db, `SELECT json_build_object('accounts',(SELECT count(*) FROM ledger.account),'journals',(SELECT count(*) FROM ledger.journal),'entries',(SELECT count(*) FROM ledger.entry),'sum',(SELECT sum(amount_cents) FROM ledger.entry),'entryHash',(SELECT md5(string_agg(row_to_json(e)::text,'' ORDER BY id)) FROM ledger.entry e),'journalHash',(SELECT md5(string_agg(row_to_json(j)::text,'' ORDER BY id)) FROM ledger.journal j),'schema',(SELECT max(version) FROM ledger.schema_version));`);
  const sourceFingerprint = fingerprint(source);
  const targetFingerprint = fingerprint(target);
  if (sourceFingerprint !== targetFingerprint) throw new Error('Restored counts or ledger hashes do not match the source snapshot.');
  const report = { recordedAt: new Date().toISOString(), scope: 'Local synthetic ledger snapshot only', matched: true, counts: JSON.parse(targetFingerprint), fixtureSnapshotAgeSeconds: (Date.now() - snapshotAt) / 1000, restoreSeconds, totalSeconds: (Date.now() - start) / 1000, objectives: { rpoSeconds: 900, rtoSeconds: 14400 }, productionObjectivesValidated: false, note: 'This validates tooling and fixture integrity, not scheduled backups, PITR/WAL recovery, Medplum, audio, attachments, production volume or a disaster failover.' };
  writeFileSync(join(output, 'phase9-recovery.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const db of created.reverse()) {
    if (!/^teleemon_recovery_(source|target)_\d+_\d+$/.test(db)) throw new Error('Unsafe cleanup target.');
    sql('postgres', `DROP DATABASE ${db} WITH (FORCE)`);
  }
}

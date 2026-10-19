// Applies the ledger schema during a Render pre-deploy step.
//
// Render gives the service one connection string; the ledger schema is idempotent and safe to run
// on every deploy. Run as: node render/ledger-migrate.mjs
//
// It is a no-op when LEDGER_DATABASE_URL is not configured, so the service still starts and reports
// a clear database error instead of failing the whole deploy.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.LEDGER_DATABASE_URL;
if (!url) {
  console.warn('[ledger-migrate] LEDGER_DATABASE_URL is not set; skipping schema application');
  process.exit(0);
}

const schema = readFileSync(new URL('../services/ledger/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query(schema);
  // The service connects as the database owner and then `set role ledger_service`, which PostgreSQL
  // only permits for members of that role.
  const { rows } = await client.query('select current_user');
  for (const role of ['ledger_service', 'ledger_reader']) {
    const owner = String(rows[0]?.current_user ?? '');
    if (!/^[A-Za-z0-9_]+$/.test(owner)) continue;
    await client.query(`grant ${role} to ${owner}`).catch((err) => {
      console.warn(`[ledger-migrate] could not grant ${role} to ${owner}: ${err.message}`);
    });
  }
  console.log('[ledger-migrate] ledger schema applied');
} catch (err) {
  console.error(`[ledger-migrate] failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  console.error('[ledger-migrate] the database user needs CREATE SCHEMA/CREATE ROLE, or apply services/ledger/schema.sql by hand once');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

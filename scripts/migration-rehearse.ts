import { readFileSync, statSync } from 'node:fs';
import { importSyntheticMigration } from './lib/migration-import';
import { baseUrl, connect, loadEnv } from './lib/client';
import { validateMigration, type MigrationBundle } from '../packages/core/src/migration';

loadEnv();
const filename = process.argv[2];
if (!filename || !process.argv.includes('--synthetic-local')) throw new Error('Usage: npm run migration:rehearse -- <normalized.json> --synthetic-local');
const url = new URL(baseUrl());
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Migration rehearsal refuses non-loopback servers.');
if (statSync(filename).size > 10 * 1024 * 1024) throw new Error('Split staging files at 10 MB.');
const data: unknown = JSON.parse(readFileSync(filename, 'utf8'));
const validation = validateMigration(data);
if (!validation.valid) { console.log(JSON.stringify(validation)); process.exitCode = 1; }
else console.log(JSON.stringify(await importSyntheticMigration(await connect(), data as MigrationBundle)));

import { MedplumClient } from '@medplum/core';
import { baseUrl, loadEnv } from './lib/client';
import { runRetention } from '../services/scribe/src/retention';

loadEnv();
const id = process.env.TELEEMON_SCRIBE_RETENTION_CLIENT_ID;
const secret = process.env.TELEEMON_SCRIBE_RETENTION_CLIENT_SECRET;
if (!id || !secret) throw new Error('Configure the dedicated scribe retention client with npm run setup -- --scribe-only.');
const medplum = new MedplumClient({ baseUrl: baseUrl() });
await medplum.startClientLogin(id, secret);
const report = await runRetention(medplum, process.argv.includes('--apply'));
console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', ...report }));
if (report.failures) process.exitCode = 1;

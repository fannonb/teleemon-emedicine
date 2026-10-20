import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_ENDPOINTS = [
  { name: 'Staff', url: 'https://teleemon-staff-demo.onrender.com/medplum/healthcheck' },
  { name: 'Patient', url: 'https://teleemon-patient-demo.onrender.com/medplum/healthcheck' },
];

export async function checkEndpoint(endpoint, {
  fetchImpl = fetch, attempts = 3, pause = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let reason = 'No response';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(endpoint.url, {
        redirect: 'error', signal: AbortSignal.timeout(90000),
        headers: { 'User-Agent': 'Teleemon-Demo-Health-Monitor', 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) reason = `HTTP ${response.status}`;
      else {
        const health = await response.json();
        if (health.ok === true && health.postgres === true && health.redis === true) {
          return { ...endpoint, healthy: true, attempt, reason: 'API, PostgreSQL and Redis healthy' };
        }
        reason = 'API or database health is not confirmed';
      }
    } catch {
      reason = 'Connection, redirect, timeout or invalid health response';
    }
    if (attempt < attempts) await pause(15000);
  }
  return { ...endpoint, healthy: false, attempt: attempts, reason };
}

export async function monitorDemo(options) {
  return Promise.all(DEMO_ENDPOINTS.map((endpoint) => checkEndpoint(endpoint, options)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const results = await monitorDemo();
  const healthy = results.every((result) => result.healthy);
  for (const result of results) console.log(`${result.name}: ${result.healthy ? 'HEALTHY' : 'FAILED'} — ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `healthy=${healthy}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Demo health — ${new Date().toISOString()}\n\n| Site | Result | Details |\n| --- | --- | --- |\n` +
      results.map((r) => `| [${r.name}](${r.url}) | ${r.healthy ? 'Healthy' : 'Failed'} | ${r.reason} |`).join('\n') + '\n');
  }
  if (!healthy) process.exitCode = 1;
}

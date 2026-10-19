// Bundles each Bot in bots/src into dist/<name>.js for Medplum's `vmcontext` runtime.
// @medplum/core is provided by the Medplum server, so it stays external.
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildBots() {
  const entries = readdirSync(join(here, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('_'));
  await esbuild.build({
    entryPoints: entries.map((f) => join(here, 'src', f)),
    outdir: join(here, 'dist'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    external: ['@medplum/core'],
    footer: { js: 'Object.assign(exports, module.exports);' },
    logLevel: 'warning',
  });
  return entries.map((f) => f.replace(/\.ts$/, ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = await buildBots();
  console.log(`Built ${names.length} bots: ${names.join(', ')}`);
}

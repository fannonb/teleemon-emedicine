import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MedplumClient } from '@medplum/core';
import { MAX_CHUNK_BYTES, SCRIBE_SYSTEM } from '@teleemon/core';
import { OpenAiAdapter } from './openai';
import { ScribeError, ScribeService } from './service';

const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envFile)) for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) process.env[key] ??= value;
const service = new ScribeService(new OpenAiAdapter());
async function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new ScribeError('Request too large', 413); parts.push(chunk); }
  return Buffer.concat(parts);
}
function send(res: ServerResponse, value: unknown, status = 200): void { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
export const server = createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    const allowed = (process.env.SCRIBE_ALLOWED_ORIGINS ?? 'http://localhost:3100').split(',');
    if (origin && !allowed.includes(origin)) throw new ScribeError('Origin not allowed', 403);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/api\/scribe/, '');
    if (path === '/health' && req.method === 'GET') return send(res, { available: true, processingConfigured: !!process.env.OPENAI_API_KEY, syntheticOnly: process.env.SCRIBE_ALLOW_PHI !== 'true', mode: 'after-visit' });
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]; if (!token) throw new ScribeError('Sign in to use the scribe', 401);
    const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/', cacheTime: 0 }); medplum.setAccessToken(token);
    await medplum.getProfileAsync();
    const encounter = path.match(/^\/encounters\/([a-zA-Z0-9-]+)\/sessions$/);
    if (encounter) {
      await service.authorize(medplum, encounter[1]);
      if (req.method === 'GET') return send(res, await medplum.searchResources('DocumentReference', { encounter: `Encounter/${encounter[1]}`, type: `${SCRIBE_SYSTEM}|session`, _sort: '-date', _count: '100' }, { cache: 'no-cache' }));
      if (req.method === 'POST') return send(res, await service.exclusive(encounter[1], () => body(req, 12000).then((b) => service.create(medplum, encounter[1], JSON.parse(b.toString())))));
    }
    const session = path.match(/^\/sessions\/([a-zA-Z0-9-]+)(?:\/(chunks\/\d+|state|process|refresh|apply|audio|withdraw))?$/);
    if (!session) throw new ScribeError('Not found', 404);
    const [, id, action] = session;
    if (req.method === 'POST' && action === 'withdraw') { await service.withdraw(medplum, id); return send(res, { withdrawn: true }); }
    if (req.method === 'GET' && !action) return send(res, (await service.load(medplum, id)).doc);
    if (req.method === 'GET' && action === 'audio') {
      const { doc, session: s } = await service.load(medplum, id); if (s.audioDeletedAt || s.state === 'cancelled') throw new ScribeError('Audio unavailable', 410);
      const { AUDIO_RATE, readWav } = await import('@teleemon/core');
      // Stream PCM payload under one correct WAV header, without buffering a whole visit.
      const samples = s.chunks.reduce((n, c) => n + c.samples, 0); const { wavBytes } = await import('@teleemon/core');
      const header = wavBytes(new Int16Array(0)); const view = new DataView(header.buffer); view.setUint32(4, 36 + samples * 2, true); view.setUint32(40, samples * 2, true);
      await service.audit(medplum, doc, 'audio-playback');
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': 44 + samples * 2, 'Cache-Control': 'no-store' }); res.write(header);
      for (const chunk of s.chunks) { const blob = await medplum.download(medplum.fhirUrl('Binary', chunk.binaryId)); const bytes = new Uint8Array(await blob.arrayBuffer()); readWav(bytes); if (!res.write(bytes.slice(44))) await new Promise<void>((resolve) => res.once('drain', resolve)); }
      res.end(); return;
    }
    if (!['POST', 'PUT'].includes(req.method ?? '')) throw new ScribeError('Method not allowed', 405);
    return await service.exclusive(id, async () => {
      if (action?.startsWith('chunks/') && req.method === 'PUT') return send(res, await service.upload(medplum, id, Number(action.split('/')[1]), await body(req, MAX_CHUNK_BYTES)));
      const input = JSON.parse((await body(req, 16000)).toString() || '{}');
      if (action === 'state' && ['recording', 'paused', 'stopped', 'cancelled'].includes(input.state)) return send(res, await service.state(medplum, id, input.state, input.expectedChunks));
      if (action === 'process') return send(res, await service.process(medplum, id));
      if (action === 'refresh') return send(res, await service.refreshBase(medplum, id));
      if (action === 'apply') return send(res, await service.apply(medplum, id, input));
      throw new ScribeError('Not found', 404);
    });
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    send(res, { error: error instanceof ScribeError ? error.message : 'Scribe request failed. Check access, saved state and service configuration.' }, error instanceof ScribeError ? error.status : 500);
  }
});
server.requestTimeout = 20 * 60000;
// Render supplies PORT; SCRIBE_PORT stays for local development.
server.listen(Number(process.env.PORT ?? process.env.SCRIBE_PORT ?? 3111), process.env.SCRIBE_HOST ?? '127.0.0.1', () => console.log('[scribe] after-visit service ready; no audio or clinical text is logged'));

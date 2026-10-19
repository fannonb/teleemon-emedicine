// Telehealth meeting provisioning (Google Meet). Proves the sandbox/link contract, the deterministic
// Google event id, the RS256 service-account assertion, the selection plan and the idempotent pass,
// without any Google credentials or network access.

import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { MedplumClient } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { EXT, appointmentMeetUrl, meetProvisionPlan, validMeetUrl } from '@teleemon/core';
import { SandboxMeetAdapter, googleEventId, meetCode, provisionMeetLinks, sandboxMeetUrl, signServiceAccountJwt } from '../services/worker/src/meet';

const NOW = new Date('2026-10-18T00:00:00Z');

const appt = (over: Partial<Appointment> & { id: string }): Appointment => ({
  resourceType: 'Appointment',
  status: 'booked',
  participant: [],
  start: '2026-10-20T17:00:00.000Z',
  end: '2026-10-20T17:30:00.000Z',
  extension: [{ url: EXT.modality, valueCode: 'video' }],
  ...over,
});

test('the sandbox meeting link is a valid, deterministic Google Meet URL', () => {
  const first = sandboxMeetUrl('Appointment/123');
  assert.equal(first, sandboxMeetUrl('Appointment/123'));
  assert.equal(validMeetUrl(first), true);
  assert.match(first, /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.notEqual(meetCode('a'), meetCode('b'));
});

test('the sandbox adapter returns the same link for the same key', async () => {
  const adapter = new SandboxMeetAdapter();
  const details = { summary: 'Visit', start: NOW.toISOString(), end: NOW.toISOString(), timeZone: 'UTC' };
  const first = await adapter.ensureMeeting('Appointment/1', details);
  const second = await adapter.ensureMeeting('Appointment/1', details);
  assert.equal(first.url, second.url);
});

test('the Google event id is deterministic and base32hex-legal', () => {
  const id = googleEventId('Appointment/abc');
  assert.equal(id, googleEventId('Appointment/abc'));
  assert.match(id, /^[0-9a-v]{5,1024}$/);
  assert.notEqual(id, googleEventId('Appointment/def'));
});

test('the service-account assertion is a signed RS256 JWT with the right claims', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const jwt = signServiceAccountJwt({
    clientEmail: 'svc@project.iam.gserviceaccount.com',
    privateKey,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    subject: 'frontdesk@practice.test',
    now: NOW,
  });
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  const verify = createVerify('RSA-SHA256');
  verify.update(`${header}.${claims}`);
  verify.end();
  assert.equal(verify.verify(publicKey, Buffer.from(signature, 'base64url')), true);

  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(decoded.iss, 'svc@project.iam.gserviceaccount.com');
  assert.equal(decoded.sub, 'frontdesk@practice.test');
  assert.equal(decoded.scope, 'https://www.googleapis.com/auth/calendar.events');
  assert.equal(decoded.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(decoded.exp, Math.floor(NOW.getTime() / 1000) + 3600);
});

test('the plan selects confirmed video visits with no link inside the horizon', () => {
  const plan = meetProvisionPlan(
    [
      appt({ id: 'video' }),
      appt({ id: 'office', extension: [{ url: EXT.modality, valueCode: 'office' }] }),
      appt({ id: 'linked', extension: [{ url: EXT.modality, valueCode: 'video' }, { url: EXT.telehealthUrl, valueUrl: 'https://meet.google.com/abc-defg-hij' }] }),
      appt({ id: 'past', start: '2026-10-01T17:00:00.000Z', end: '2026-10-01T17:30:00.000Z' }),
      appt({ id: 'cancelled', status: 'cancelled' }),
      appt({ id: 'far', start: '2027-06-01T17:00:00.000Z', end: '2027-06-01T17:30:00.000Z' }),
    ],
    NOW,
    60
  );
  assert.deepEqual(plan.map((a) => a.id), ['video']);
});

/** Minimal in-memory Medplum client: enough for the provisioning search, read and versioned update. */
function fakeMedplum(rows: Appointment[]): { client: MedplumClient; store: Map<string, Appointment> } {
  const store = new Map(rows.map((r) => [r.id as string, structuredClone(r)]));
  let version = 0;
  const client = {
    async *searchResourcePages(): AsyncGenerator<Appointment[]> {
      yield [...store.values()].map((r) => structuredClone(r));
    },
    async readResource(_type: string, id: string): Promise<Appointment> {
      return structuredClone(store.get(id) as Appointment);
    },
    async updateResource(resource: Appointment): Promise<Appointment> {
      version += 1;
      const next = { ...structuredClone(resource), meta: { ...(resource.meta ?? {}), versionId: String(version) } };
      store.set(resource.id as string, next);
      return next;
    },
  };
  return { client: client as unknown as MedplumClient, store };
}

test('provisioning adds exactly one link, ignores office visits, and is idempotent', async () => {
  const { client, store } = fakeMedplum([appt({ id: 'v1' }), appt({ id: 'o1', extension: [{ url: EXT.modality, valueCode: 'office' }] })]);
  const adapter = new SandboxMeetAdapter();

  const first = await provisionMeetLinks(client, adapter, NOW, 60);
  assert.equal(first.created, 1);
  assert.equal(first.failed, 0);

  const stored = store.get('v1') as Appointment;
  assert.equal(appointmentMeetUrl(stored), sandboxMeetUrl('v1'));
  assert.equal(stored.extension?.some((e) => e.url === EXT.meetProvisionedAt), true);
  assert.equal(stored.extension?.some((e) => e.url === EXT.meetSpace), false); // no ref in sandbox mode
  assert.equal(store.get('o1')?.extension?.some((e) => e.url === EXT.telehealthUrl), false);

  const second = await provisionMeetLinks(client, adapter, NOW, 60);
  assert.equal(second.created, 0);
  assert.equal(appointmentMeetUrl(store.get('v1') as Appointment), sandboxMeetUrl('v1'));
});

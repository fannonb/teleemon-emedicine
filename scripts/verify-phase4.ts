// Real local Medplum gate; synthetic PCM and an injected AI adapter, never OpenAI calls.
import assert from 'node:assert/strict';
import { createReference } from '@medplum/core';
import { AUDIO_RATE, CODE_SYSTEMS, EXT, SEED_IDENTIFIER_SYSTEM, emptyNote, findTemplate, wavBytes } from '@teleemon/core';
import type { DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import { buildComposition } from '../apps/staff/src/fhir/visits';
import { ScribeService, sessionData } from '../services/scribe/src/service';
import { connect, connectAsPassword } from './lib/client';

async function main(): Promise<void> {
  const admin = await connect();
  const password = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
  const provider = await connectAsPassword('provider@teleemon.test', password);
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', password);
  const biller = await connectAsPassword('biller@teleemon.test', password);
  const profile = await provider.getProfileAsync(); assert(profile?.resourceType === 'Practitioner');
  const patient = await admin.createResource<Patient>({ resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: `verify-scribe-${Date.now()}` }], name: [{ family: 'Scribe Verification', given: ['Synthetic'] }] });
  const encounter = await provider.createResource<Encounter>({ resourceType: 'Encounter', status: 'in-progress', class: { code: 'VR', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' }, subject: createReference(patient), participant: [{ individual: createReference(profile) }], period: { start: new Date().toISOString() }, extension: [{ url: EXT.patientLocationState, valueCode: 'WA' }, { url: EXT.modality, valueCode: 'video' }] });
  const standing = await admin.createResource({ resourceType: 'Consent', status: 'active', scope: { text: 'Privacy' }, policyRule: { text: 'Recording and AI documentation permission' }, category: [{ coding: [{ system: CODE_SYSTEMS.consentType, code: 'recording' }] }], patient: createReference(patient) });
  const note = await provider.createResource(buildComposition({ encounter, patient, amendments: [] }, emptyNote(findTemplate('med-mgmt')!, 'video'), profile));
  let doc: DocumentReference | undefined;
  let checks = 0; const pass = (label: string): void => { checks++; console.log(`PASS ${label}`); };
  const service = new ScribeService({ transcribe: async () => ({ text: 'We agreed to follow up in two weeks.', requestId: 'synthetic' }), draft: async () => ({ result: { proposals: [{ field: 'sections.followUp', value: 'Follow up in two weeks.', evidence: ['block-0'], caution: '' }], warnings: ['Risk was not assessed in this synthetic fixture.'], diagnosisSuggestions: [] }, inputTokens: 20, outputTokens: 10, requestId: 'synthetic' }) }, { OPENAI_API_KEY: 'injected-adapter-no-network' });
  try {
    await assert.rejects(service.create(provider, encounter.id!, { consent: false })); pass('Per-session consent is required');
    doc = await service.create(provider, encounter.id!, { consent: true, meetingUrl: 'https://meet.google.com/abc-defg-hij' }); pass('Provider creates encounter-scoped recording and consent');
    await assert.rejects(service.process(provider, doc.id!)); pass('Processing while recording is refused');
    doc = await service.upload(provider, doc.id!, 0, wavBytes(new Int16Array(AUDIO_RATE))); pass('Audio persists through Medplum Binary storage');
    const binary = sessionData(doc).chunks[0].binaryId;
    await assert.rejects(frontdesk.readResource('DocumentReference', doc.id!, { cache: 'no-cache' })); pass('Front desk cannot read session/transcript');
    const frontdeskAudio = await frontdesk.downloadResponse(frontdesk.fhirUrl('Binary', binary)); assert([403, 404].includes(frontdeskAudio.status), `Expected denial, received ${frontdeskAudio.status}`); pass('Binary securityContext blocks front-desk audio access');
    const billerAudio = await biller.downloadResponse(biller.fhirUrl('Binary', binary)); assert([403, 404].includes(billerAudio.status), `Expected denial, received ${billerAudio.status}`); pass('Binary securityContext blocks billing audio access');
    const privateRecord = await provider.createResource<DocumentReference>({ resourceType: 'DocumentReference', status: 'current', category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'private-psychotherapy' }] }], author: [createReference(profile)], subject: createReference(patient), context: { encounter: [createReference(encounter)] }, extension: [{ url: EXT.privatePsychotherapy, valueString: 'Synthetic author-only note; never passed to AI.' }], content: [{ attachment: { contentType: 'text/plain', title: 'Private notes' } }] });
    try {
      assert.equal((await provider.readResource('DocumentReference', privateRecord.id!, { cache: 'no-cache' })).id, privateRecord.id); pass('Author can read the separately stored private note');
      await assert.rejects(frontdesk.readResource('DocumentReference', privateRecord.id!, { cache: 'no-cache' })); await assert.rejects(biller.readResource('DocumentReference', privateRecord.id!, { cache: 'no-cache' })); pass('Private notes are refused to front desk and billing');
      const foreignPrivate = await admin.createResource<DocumentReference>({ ...privateRecord, id: undefined, author: [{ reference: 'Practitioner/other-author' }] });
      try { await assert.rejects(provider.readResource('DocumentReference', foreignPrivate.id!, { cache: 'no-cache' })); pass('Another author’s private note is refused to the provider'); }
      finally { await admin.deleteResource('DocumentReference', foreignPrivate.id!); }
    } finally { await admin.deleteResource('DocumentReference', privateRecord.id!); }
    const restored = sessionData((await service.load(provider, doc.id!)).doc); assert.equal(restored.chunks.length, 1); pass('Session survives a fresh service read');
    await service.state(provider, doc.id!, 'stopped', 1);
    doc = await service.process(provider, doc.id!); assert.equal(sessionData(doc).state, 'ready'); pass('After-stop pipeline persists transcript and field proposals');
    const saved = await service.apply(provider, doc.id!, { fields: ['sections.followUp'], replace: false, noteId: note.id!, version: note.meta!.versionId! });
    assert.equal(saved.status, 'preliminary'); pass('Atomic reviewed apply preserves unsigned note lifecycle');
    const provenance = await provider.searchResources('Provenance', { target: `Composition/${note.id}` }); assert(provenance.length); pass('Application records source provenance');
    await service.state(provider, doc.id!, 'cancelled'); await assert.rejects(service.process(provider, doc.id!)); pass('Consent withdrawal blocks subsequent processing');
    console.log(`${checks} PASS, 0 FAIL · synthetic local gate; no vendor calls`);
  } finally {
    // Test records remain synthetic; remove only disposable unsigned content.
    const current = doc && await admin.readResource('DocumentReference', doc.id!, { cache: 'no-cache' }).catch(() => undefined);
    if (current) { const s = sessionData(current); for (const chunk of s.chunks) await admin.deleteResource('Binary', chunk.binaryId); await admin.deleteResource('Consent', s.consentId); await admin.deleteResource('DocumentReference', current.id!); }
    for (const p of await admin.searchResources('Provenance', { target: `Composition/${note.id}` })) await admin.deleteResource('Provenance', p.id!);
    await admin.deleteResource('Composition', note.id!); await admin.deleteResource('Consent', standing.id!); await admin.deleteResource('Encounter', encounter.id!); await admin.deleteResource('Patient', patient.id!);
  }
}
main().catch((error: unknown) => { console.error('FAIL Phase 4 synthetic local gate:', error instanceof Error ? error.message : 'Unknown error'); process.exitCode = 1; });

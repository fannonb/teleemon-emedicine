import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, Condition, Flag, MedicationStatement, Observation, Patient, QuestionnaireResponse, Task } from '@medplum/fhirtypes';
import { DERIVED_IDENTIFIER_SYSTEM, ICD10CM_SYSTEM, MEASURES, guardianContact, hasConfirmedGuardian, questionnaireUrl } from '@teleemon/core';
import { handler as score } from '../bots/src/measure-scoring';
import { handler as diagnosis } from '../bots/src/diagnosis-validation';
import { handler as monitor } from '../bots/src/medication-monitoring';
import { handler as validateMeasure } from '../bots/src/measure-validation';

const patient: Patient = { resourceType: 'Patient', id: 'patient', generalPractitioner: [{ reference: 'Practitioner/provider' }] };
const qr: QuestionnaireResponse = {
  resourceType: 'QuestionnaireResponse', id: 'response', questionnaire: questionnaireUrl('phq9'), status: 'completed',
  subject: { reference: 'Patient/patient' }, authored: '2026-10-16T10:00:00Z',
  item: MEASURES.phq9.items.map((i, n) => ({ linkId: i.linkId, answer: [{ valueInteger: n === 8 ? 1 : 0 }] })),
};
const event = <T>(input: T): BotEvent<T> => ({ input, bot: { reference: 'Bot/test' }, contentType: 'application/fhir+json', secrets: {} });
const client = (methods: object): MedplumClient => methods as MedplumClient;

test('positive safety result commits score, flag and task as a single conditional transaction', async () => {
  let bundle: Bundle | undefined;
  await score(client({
    searchOne: async () => undefined, searchResources: async () => [], readReference: async () => patient,
    executeBatch: async (b: Bundle) => { bundle = b; return b; },
  }), event(qr));
  assert.equal(bundle?.type, 'transaction');
  assert.deepEqual(bundle?.entry?.map((e) => e.resource?.resourceType), ['Observation', 'Flag', 'Task']);
  assert.ok(bundle?.entry?.every((e) => e.request?.ifNoneExist?.includes('identifier=')));
  const flag = bundle?.entry?.[1].resource as Flag;
  assert.equal(flag.extension?.[0].valueReference?.reference, bundle?.entry?.[0].fullUrl);
  assert.equal((bundle?.entry?.[2].resource as Task).priority, 'stat');
});

test('retry repairs a missing safety task when the old score and flag already exist', async () => {
  let bundle: Bundle | undefined;
  const observation: Observation = { resourceType: 'Observation', id: 'old-score', status: 'final', code: {} };
  const reviewed: Flag = { resourceType: 'Flag', id: 'old-flag', status: 'inactive', subject: { reference: 'Patient/patient' }, code: {}, extension: [{ url: 'detail', valueReference: { reference: 'Observation/old-score' } }] };
  await score(client({
    searchOne: async (type: string) => type === 'Observation' ? observation : undefined,
    searchResources: async () => [reviewed], readReference: async () => patient,
    executeBatch: async (b: Bundle) => { bundle = b; return b; },
  }), event(qr));
  assert.deepEqual(bundle?.entry?.map((e) => e.resource?.resourceType), ['Task']);
  assert.equal((bundle?.entry?.[0].resource as Task).focus?.reference, 'QuestionnaireResponse/response');
});

test('failed scoring transaction can be retried without an early score-only exit', async () => {
  let calls = 0;
  const m = client({ searchOne: async () => undefined, searchResources: async () => [], readReference: async () => patient,
    executeBatch: async (b: Bundle) => { calls++; if (calls === 1) throw new Error('transient write failure'); return b; },
  });
  await assert.rejects(score(m, event(qr)), /transient write failure/);
  await score(m, event(qr));
  assert.equal(calls, 2);
});

test('redelivering a fully processed questionnaire does not reopen reviewed alerts', async () => {
  await score(client({
    searchOne: async (type: string) => type === 'Observation' ? { resourceType: 'Observation', id: 'score' } : { resourceType: 'Task', status: 'completed' },
    searchResources: async () => [{ extension: [{ valueReference: { reference: 'Observation/score' } }], status: 'inactive' }],
    readReference: async () => patient,
    executeBatch: async () => assert.fail('No new resources should be written'),
  }), event(qr));
});

test('guardian snapshot requires identity, relationship, phone and confirmed authority', () => {
  const details = { given: 'Test', family: 'Guardian', relationship: 'Mother', phone: '425-555-0194', authority: true };
  assert.equal(hasConfirmedGuardian(patient), false);
  assert.equal(hasConfirmedGuardian({ ...patient, contact: [guardianContact(details)] }), true);
  assert.equal(hasConfirmedGuardian({ ...patient, contact: [guardianContact({ ...details, authority: false })] }), false);
  assert.equal(hasConfirmedGuardian({ ...patient, contact: [guardianContact({ ...details, phone: '123' })] }), false);
});

test('diagnosis server validation rejects invalid and duplicate codes while allowing its own update', async () => {
  const condition: Condition = { resourceType: 'Condition', id: 'self', subject: { reference: 'Patient/patient' }, code: { coding: [{ system: ICD10CM_SYSTEM, code: 'F41.1' }] } };
  await assert.rejects(diagnosis(client({}), event({ ...condition, code: { text: 'invalid' } })), /billable diagnosis/);
  await assert.rejects(diagnosis(client({ searchResources: async () => [{ ...condition, id: 'other' }] }), event(condition)), /already on/);
  assert.equal(await diagnosis(client({ searchResources: async () => [condition] }), event(condition)), condition);
});

test('completed measures require every answer and reject values outside the instrument', async () => {
  const m = client({});
  assert.equal(await validateMeasure(m, event(qr)), qr);
  await assert.rejects(validateMeasure(m, event({ ...qr, item: qr.item?.slice(0, 8) })), /Answer every item/);
  await assert.rejects(validateMeasure(m, event({ ...qr, item: qr.item?.map((i) => ({ ...i, answer: [{ valueInteger: 99 }] })) })), /Answer every item/);
});

test('medication redelivery uses one stable conditional task identifier and patient provider', async () => {
  const keys: string[] = [];
  const med: MedicationStatement = { resourceType: 'MedicationStatement', id: 'medication', status: 'active', subject: { reference: 'Patient/patient' }, medicationCodeableConcept: { text: 'Lithium carbonate' } };
  const m = client({ readReference: async () => patient, createResourceIfNoneExist: async (task: Task, key: string) => {
    keys.push(key); assert.equal(task.identifier?.[0].system, DERIVED_IDENTIFIER_SYSTEM); assert.equal(task.owner?.reference, 'Practitioner/provider'); return task;
  } });
  await monitor(m, event(med)); await monitor(m, event(med));
  assert.equal(keys[0], keys[1]);
  await monitor(client({}), event({ ...med, status: 'stopped' }));
});

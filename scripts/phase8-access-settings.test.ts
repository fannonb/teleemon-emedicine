import assert from 'node:assert/strict';
import test from 'node:test';
import type { MedplumClient } from '@medplum/core';
import type { Basic } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, DEFAULT_BILLING, EXT, readSettingsSnapshot, writeSettings } from '@teleemon/core';
import { canSee, getPage } from '../apps/staff/src/navigation';
import { rolesFromSession } from '../apps/staff/src/session/roleResolution';
import { ACCESS_POLICIES, POLICY_NAMES } from './config/platform';

test('the front desk can run eligibility checks (P32), and the policy matches the page it can see', () => {
  assert.equal(canSee(getPage('P32'), ['frontdesk']), true);
  const frontdesk = ACCESS_POLICIES.find((p) => p.name === POLICY_NAMES.frontdesk);
  assert.ok(frontdesk, 'the front desk policy exists');
  const rule = (type: string) => frontdesk.resource?.find((r) => r.resourceType === type);
  assert.ok(rule('CoverageEligibilityRequest')?.interaction?.includes('create'), 'front desk can create a 270 request');
  assert.ok(rule('CoverageEligibilityResponse')?.interaction?.includes('read'), 'front desk can read the 271 response');
  assert.equal(rule('CoverageEligibilityResponse')?.interaction?.includes('create'), false, 'front desk never writes the response');
});

test('staff navigation uses effective exact-name policies, including billers with no membership display', () => {
  const biller = rolesFromSession({ membership: { resourceType: 'ProjectMembership', profile: { reference: 'Practitioner/biller' } }, accessPolicy: { basedOn: [{ display: 'Teleemon Biller' }] } });
  assert.deepEqual(biller, ['biller']);
  assert.equal(canSee(getPage('P30'), biller), true);
  assert.equal(canSee(getPage('P25'), biller), false);
  assert.deepEqual(rolesFromSession({ accessPolicy: { basedOn: [{ display: 'Teleemon Provider' }, { display: 'Teleemon Front desk' }] } }), ['provider', 'frontdesk']);
  assert.deepEqual(rolesFromSession({ membership: { resourceType: 'ProjectMembership', admin: true } }), ['admin']);
});

test('missing or unknown policies never grant a Practitioner provider access', () => {
  assert.deepEqual(rolesFromSession(undefined), []);
  assert.deepEqual(rolesFromSession({ membership: { resourceType: 'ProjectMembership', profile: { reference: 'Practitioner/unknown' } } }), []);
  assert.deepEqual(rolesFromSession({ accessPolicy: { basedOn: [{ display: 'Not a Teleemon Biller' }] } }), []);
});

test('two billing editors cannot overwrite the same settings version', async () => {
  let saved: Basic = { resourceType: 'Basic', id: 'billing', code: { text: 'billing' }, meta: { versionId: '1' }, identifier: [{ system: CODE_SYSTEMS.settings, value: 'billing' }], extension: [{ url: EXT.settingsJson, valueString: JSON.stringify(DEFAULT_BILLING) }] };
  const client = {
    searchOne: async () => structuredClone(saved),
    updateResource: async (resource: Basic, options: { headers: { 'If-Match': string } }) => {
      if (options.headers['If-Match'] !== `W/"${saved.meta?.versionId}"`) throw new Error('412 Precondition Failed');
      saved = { ...resource, meta: { versionId: '2' } };
      return saved;
    },
  } as unknown as MedplumClient;
  const first = await readSettingsSnapshot(client, 'billing');
  const second = await readSettingsSnapshot(client, 'billing');
  const firstValue = { ...first.value, policy: { ...first.value.policy, smallBalanceWriteOffCents: 123 } };
  await writeSettings(client, 'billing', firstValue, first.resource);
  await assert.rejects(writeSettings(client, 'billing', second.value, second.resource), /412/);
  assert.equal(JSON.parse(saved.extension![0].valueString!).policy.smallBalanceWriteOffCents, 123);
});

test('simultaneous first saves use conditional create and report different existing settings', async () => {
  const client = { createResourceIfNoneExist: async () => ({ resourceType: 'Basic', code: {}, extension: [{ url: EXT.settingsJson, valueString: '{}' }] }) } as unknown as MedplumClient;
  await assert.rejects(writeSettings(client, 'billing', DEFAULT_BILLING, null), /Another person saved/);
});

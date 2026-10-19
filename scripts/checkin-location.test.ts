// Location-confirmation freshness and the provider's on-camera re-confirmation. No server needed;
// `npm run verify:phase7` covers the same rules against local Medplum.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Appointment, Encounter } from '@medplum/fhirtypes';
import {
  PORTAL_RULES,
  checkInProblem,
  joinProblem,
  locationConfirmationFresh,
  locationConfirmedExtension,
  providerLocationConfirmation,
  providerLocationConfirmedExtension,
} from '@teleemon/core';

const visit = (over: Partial<Appointment> = {}): Appointment => ({
  resourceType: 'Appointment',
  id: 'a',
  status: 'arrived',
  start: '2026-10-19T16:00:00.000Z',
  end: '2026-10-19T16:30:00.000Z',
  participant: [{ actor: { reference: 'Patient/p' }, status: 'accepted' }],
  ...over,
});

const checkedInAt = (iso: string, state = 'WA'): Appointment =>
  visit({ extension: [locationConfirmedExtension('Patient/p', state, new Date(iso))] });

test('a recent confirmation holds and releases the join link', () => {
  const appt = checkedInAt('2026-10-19T09:00:00Z');
  const now = new Date('2026-10-19T12:00:00Z'); // three hours later
  assert.equal(locationConfirmationFresh(appt, now), true);
  assert.equal(checkInProblem(appt, now), 'You are already checked in.');
  assert.equal(joinProblem(appt, now), undefined);
});

test('a stale confirmation must be renewed before the patient can join', () => {
  const appt = checkedInAt('2026-10-19T09:00:00Z');
  const later = new Date('2026-10-19T18:00:00Z'); // nine hours later
  assert.equal(locationConfirmationFresh(appt, later), false);
  assert.equal(checkInProblem(appt, later), undefined, 'check-in is offered again to renew the location');
  assert.match(joinProblem(appt, later) ?? '', /Confirm your location again/);
});

test('freshness is exactly the configured window', () => {
  const appt = checkedInAt('2026-10-19T00:00:00Z');
  const inside = new Date(Date.parse('2026-10-19T00:00:00Z') + PORTAL_RULES.locationFreshHours * 3600000);
  assert.equal(locationConfirmationFresh(appt, inside), true);
  assert.equal(locationConfirmationFresh(appt, new Date(inside.getTime() + 1000)), false);
});

test('a booked visit without a confirmation checks in and joins normally', () => {
  const booked = visit({ status: 'booked' });
  assert.equal(checkInProblem(booked), undefined);
  assert.match(joinProblem(booked) ?? '', /Check in/);
});

test("the provider's on-camera re-confirmation is recorded on the encounter", () => {
  const at = new Date('2026-10-19T16:05:00Z');
  const enc: Encounter = {
    resourceType: 'Encounter',
    id: 'e',
    status: 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR' },
    extension: [providerLocationConfirmedExtension('Practitioner/prov', 'WA', at)],
  };
  const confirmed = providerLocationConfirmation(enc);
  assert.equal(confirmed?.by, 'Practitioner/prov');
  assert.equal(confirmed?.state, 'WA');
  assert.equal(confirmed?.at, at.toISOString());
  assert.equal(providerLocationConfirmation({ resourceType: 'Encounter', status: 'in-progress', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR' } }), undefined);
});

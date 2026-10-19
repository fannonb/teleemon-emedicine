// Phase 2 gate: scheduling, licensure and reminders, proven against the server with no UI.
// Uses an explicit clock for reminder runs so results don't depend on the time of day.
// Cleans up everything it creates.

import type { MedplumClient } from '@medplum/core';
import { createReference, getExtensionValue, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Appointment, Communication, Patient, Practitioner, Resource, Schedule, Slot } from '@medplum/fhirtypes';
import {
  CODE_SYSTEMS,
  EXT,
  GENERATED_IDENTIFIER_SYSTEM,
  PRACTICE_TIME_ZONE,
  SEED_IDENTIFIER_SYSTEM,
  dueOffsets,
  inQuietHours,
  patientTimeZone,
  renderReminder,
  locationConfirmedExtension,
  toQualification,
  zonedDate,
  zonedTime,
} from '@teleemon/core';
import { handleInbound } from '../services/worker/src/inbound';
import { connectWorker, runOnce } from '../services/worker/src/index';
import { searchPatients } from '../apps/staff/src/fhir/patientSearch';
import { connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
let failures = 0;
/** Every resource this run creates carries this tag, so cleanup works even after a crash. */
const TAG = { system: GENERATED_IDENTIFIER_SYSTEM, value: 'verify-phase2' };

function report(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.slice(0, 110)})` : ''}`);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}

function nextWeekday(fromYmd: string, plus: number): string {
  let d = new Date(Date.parse(`${fromYmd}T12:00:00Z`) + plus * 86400000);
  if (d.getUTCDay() === 0) d = new Date(d.getTime() + 86400000);
  return d.toISOString().slice(0, 10);
}

function at(ymd: string, hh: number, mm = 0): string {
  return zonedTime(ymd, hh, mm, PRACTICE_TIME_ZONE).toISOString();
}

function appt(patient: Patient, practitioner: Practitioner, start: string, minutes: number, state: string, opts: { overbook?: string; status?: Appointment['status'] } = {}): Appointment {
  return {
    resourceType: 'Appointment',
    identifier: [TAG],
    status: opts.status ?? 'booked',
    start,
    end: new Date(Date.parse(start) + minutes * 60000).toISOString(),
    minutesDuration: minutes,
    appointmentType: { coding: [{ system: CODE_SYSTEMS.visitType, code: 'med-mgmt' }], text: 'Medication management' },
    extension: [
      { url: EXT.modality, valueCode: 'video' },
      { url: EXT.patientLocationState, valueCode: state },
      ...(opts.overbook ? [{ url: EXT.overbookReason, valueString: opts.overbook }] : []),
    ],
    participant: [
      { actor: createReference(patient), status: 'accepted' },
      { actor: createReference(practitioner), status: 'accepted' },
    ],
  };
}

async function book(m: MedplumClient, a: Appointment): Promise<{ ok: boolean; value?: Appointment; error?: string }> {
  const r = await attempt(() => m.createResource(a));
  if (r.value?.id) testAppointments.add(`Appointment/${r.value.id}`);
  return r;
}

/** Reminders for an appointment, found by their idempotency keys (Communication has no "about" search). */
async function remindersFor(m: MedplumClient, a?: Appointment): Promise<Resource[]> {
  if (!a?.id) return [];
  const keys = [72, 24, 2].flatMap((h) => ['sms', 'email'].map((c) => `${GENERATED_IDENTIFIER_SYSTEM}|reminder-${a.id}-${h}h-${c}`));
  return m.searchResources('Communication', { identifier: keys.join(',') }, { cache: 'no-cache' });
}

/** Delivery in this script only touches reminders for its own (tagged) test appointments. */
const testAppointments = new Set<string>();
const ownMessages = (c: Communication): boolean => testAppointments.has(c.about?.[0]?.reference ?? '');

async function cleanup(admin: MedplumClient): Promise<number> {
  let removed = 0;
  const tag = `${TAG.system}|${TAG.value}`;
  for (const a of await admin.searchResources('Appointment', { identifier: tag, _count: '200' }, { cache: 'no-cache' })) {
    for (const c of await remindersFor(admin, a)) {
      await admin.deleteResource('Communication', c.id as string);
      removed++;
    }
    await admin.deleteResource('Appointment', a.id as string);
    removed++;
  }
  for (const type of ['Slot', 'Practitioner'] as const) {
    for (const r of await admin.searchResources(type, { identifier: tag, _count: '50' }, { cache: 'no-cache' })) {
      await admin.deleteResource(type, r.id as string);
      removed++;
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const admin = await connect();
  await cleanup(admin); // leftovers from an interrupted earlier run
  try {
    await checks(admin);
  } finally {
    console.log(`\n(cleaned up ${await cleanup(admin)} test resources)`);
  }
  console.log(failures === 0 ? '\n✓ Phase 2 server-side checks passed' : `\n✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function checks(admin: MedplumClient): Promise<void> {
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const worker = await connectWorker();
  const seed = async <T extends Resource>(type: T['resourceType'], key: string): Promise<T> =>
    (await admin.searchOne(type as 'Patient', { identifier: `${SEED_IDENTIFIER_SYSTEM}|${key}` })) as unknown as T;
  const provider = await seed<Practitioner>('Practitioner', 'prac-provider');
  const schedule = await seed<Schedule>('Schedule', 'sched-provider');
  const daniel = await seed<Patient>('Patient', 'pt-02'); // CA, no opt-outs
  const grace = await seed<Patient>('Patient', 'pt-07'); // opted out of SMS
  const sofia = await seed<Patient>('Patient', 'pt-05'); // CO
  const maya = await seed<Patient>('Patient', 'pt-01');

  const day = nextWeekday(zonedDate(new Date()), 5); // a quiet weekday ahead
  console.log(`\nBooking rules (pre-commit Bot), test day ${day}`);

  const first = await book(frontdesk, appt(daniel, provider, at(day, 17), 30, 'CA'));
  report(first.ok, 'Front desk books a California patient in a free slot', first.error);
  const tx = await book(frontdesk, appt(daniel, provider, at(day, 19), 30, 'TX'));
  report(!tx.ok && /not licensed in TX/i.test(tx.error ?? ''), 'Booking a patient located in Texas is refused', tx.error);
  const noState = await book(frontdesk, { ...appt(daniel, provider, at(day, 19, 30), 30, 'CA'), extension: [{ url: EXT.modality, valueCode: 'video' }] });
  report(!noState.ok && /location/i.test(noState.error ?? ''), 'Booking without the patient location is refused', noState.error);

  const overlap = await book(frontdesk, appt(daniel, provider, at(day, 17, 15), 30, 'CA'));
  report(!overlap.ok && /overlaps/i.test(overlap.error ?? ''), 'A double booking is refused', overlap.error);
  const overbook = await book(frontdesk, appt(daniel, provider, at(day, 17, 15), 30, 'CA', { overbook: 'Urgent same-day visit approved' }));
  report(overbook.ok, 'The same booking succeeds as an overbook with a reason', overbook.error);

  const block = await attempt(() =>
    admin.createResource<Slot>({ resourceType: 'Slot', identifier: [TAG], schedule: createReference(schedule), status: 'busy-unavailable', start: at(day, 18), end: at(day, 18, 30), comment: 'Verification block' })
  );
  const blocked = await book(frontdesk, appt(sofia, provider, at(day, 18), 30, 'CO'));
  report(!blocked.ok && /blocked/i.test(blocked.error ?? ''), 'Booking over blocked time is refused', blocked.error);

  // Expired licence: a temporary provider licensed in WA, with a CO licence that expired yesterday.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const temp = await admin.createResource<Practitioner>({
    resourceType: 'Practitioner',
    identifier: [TAG],
    name: [{ given: ['Verify'], family: 'Expired' }],
    qualification: [
      toQualification({ kind: 'state-license', state: 'WA', number: 'TEST-WA', start: '2024-01-01', end: '2030-01-01' }),
      toQualification({ kind: 'state-license', state: 'CO', number: 'TEST-CO', start: '2024-01-01', end: yesterday }),
    ],
  });
  const expired = await book(frontdesk, appt(sofia, temp, at(day, 20), 30, 'CO'));
  report(!expired.ok && /expired/i.test(expired.error ?? ''), 'An expired CO licence blocks CO bookings', expired.error);
  const stillWa = await book(frontdesk, appt(maya, temp, at(day, 20), 30, 'WA'));
  report(stillWa.ok, '...while WA bookings for the same provider still work', stillWa.error);

  if (first.value) {
    const confirmer = frontdesk.getProfile();
    if (!confirmer) throw new Error('Front desk test account has no profile for the location-confirmation audit.');
    const confirmerRef = getReferenceString(confirmer);
    if (!confirmerRef) throw new Error('Front desk test account has no FHIR reference for the location-confirmation audit.');
    const checkinAs = (state: string) => frontdesk.updateResource<Appointment>({
      ...(first.value as Appointment),
      status: 'arrived',
      extension: [
        ...(first.value?.extension ?? []).filter((e) => e.url !== EXT.patientLocationState && e.url !== EXT.locationConfirmed),
        { url: EXT.patientLocationState, valueCode: state },
        locationConfirmedExtension(confirmerRef, state, new Date()),
      ],
    });
    const unlicensed = await attempt(() => checkinAs('TX'));
    report(!unlicensed.ok && /not licensed in TX/i.test(unlicensed.error ?? ''), 'Check-in is refused when the provider is not licensed in the patient\'s current state', unlicensed.error);
    const checkin = await attempt(() =>
      checkinAs('CA')
    );
    report(checkin.ok && checkin.value?.extension?.some((e) => e.url === EXT.locationConfirmed) === true, 'Staff check-in records the licensed current location with confirmer metadata', checkin.error);
  }
  const history = first.value ? await admin.get(admin.fhirUrl('Appointment', first.value.id as string, '_history'), { cache: 'no-cache' }) : undefined;
  report(((history as { entry?: unknown[] })?.entry?.length ?? 0) >= 2, 'Appointment changes are kept in history', `${(history as { entry?: unknown[] })?.entry?.length ?? 0} versions`);

  console.log('\nTime zones');
  const riStart = at(day, 10);
  const riText = renderReminder('{when} ({timezone})', { firstName: '', start: riStart, timeZone: patientTimeZone('RI'), practicePhone: '' });
  report(/1:00\s?PM/.test(riText) && /E[SD]T/.test(riText), 'A Rhode Island patient sees Eastern time (10:00 AM Pacific → 1:00 PM ET)', riText);

  console.log('\nReminders (scheduler Bot + worker)');
  const morning = new Date(at(day, 9));
  const remindAppt = await book(frontdesk, appt(daniel, provider, new Date(morning.getTime() + 20 * 3600000).toISOString(), 30, 'CA', { overbook: 'verification' }));
  const graceAppt = await book(frontdesk, appt(grace, provider, new Date(morning.getTime() + 21 * 3600000).toISOString(), 30, 'CA', { overbook: 'verification' }));
  report(dueOffsets(remindAppt.value?.start as string, morning).join() === '24', 'A visit 20 hours away is due its 24-hour reminder only');
  const pass1 = await runOnce(worker, morning, ownMessages);
  const reminders = (a?: Appointment): Promise<Resource[]> => remindersFor(worker, a);
  const danielMsgs = await reminders(remindAppt.value);
  const channels = danielMsgs.map((c) => getExtensionValue(c, EXT.channel)).sort().join(',');
  report(channels === 'email,sms', 'The scheduler queues one text and one email', `${channels} · ${pass1}`);
  report(danielMsgs.every((c) => (c as { status?: string }).status === 'completed'), 'Daytime delivery sends both (log transport)');
  report(danielMsgs.every((c) => !/medicat|psychiatr|therap/i.test(JSON.stringify((c as { payload?: unknown }).payload))), 'Reminder text contains no clinical detail');
  await runOnce(worker, morning, ownMessages);
  report((await reminders(remindAppt.value)).length === 2, 'Running again creates no duplicates (idempotent)');
  const graceMsgs = await reminders(graceAppt.value);
  report(graceMsgs.length === 1 && getExtensionValue(graceMsgs[0], EXT.channel) === 'email', 'A patient who opted out of texts gets email only');

  const night = new Date(at(day, 22, 30));
  const nightAppt = await book(frontdesk, appt(sofia, provider, new Date(night.getTime() + 20 * 3600000).toISOString(), 30, 'CO', { overbook: 'verification' }));
  report(inQuietHours(night, patientTimeZone('CO')) && !inQuietHours(new Date(at(day, 12)), patientTimeZone('CO')), 'Quiet hours: 11:30 PM Mountain is quiet, noon is not');
  await runOnce(worker, night, ownMessages);
  const deferred = await reminders(nightAppt.value);
  report(deferred.length > 0 && deferred.every((c) => (c as { status?: string }).status === 'preparation'), 'At night reminders stay queued (quiet hours)');
  await runOnce(worker, new Date(night.getTime() + 10 * 3600000), ownMessages);
  report((await reminders(nightAppt.value)).every((c) => (c as { status?: string }).status === 'completed'), '...and go out after quiet hours end');

  console.log('\nInbound replies');
  const phone = daniel.telecom?.find((t) => t.system === 'phone')?.value as string;
  await handleInbound(worker, phone, 'STOP');
  const afterStop = await admin.readResource('Patient', daniel.id as string, { cache: 'no-cache' });
  report((afterStop.extension ?? []).some((e) => e.url === EXT.contactOptOut && e.valueCode === 'sms'), 'Replying STOP opts the patient out of texts');
  const postStop = await book(frontdesk, appt(daniel, provider, new Date(morning.getTime() + 22 * 3600000).toISOString(), 30, 'CA', { overbook: 'verification' }));
  await runOnce(worker, morning, ownMessages);
  const postStopMsgs = await reminders(postStop.value);
  report(!postStopMsgs.some((c) => getExtensionValue(c, EXT.channel) === 'sms'), '...and no further texts are queued for them', `${postStopMsgs.length} email only`);
  await handleInbound(worker, phone, 'START');
  const afterStart = await admin.readResource('Patient', daniel.id as string, { cache: 'no-cache' });
  report(!(afterStart.extension ?? []).some((e) => e.url === EXT.contactOptOut && e.valueCode === 'sms'), 'Replying START opts back in');
  const help = await handleInbound(worker, phone, 'help');
  report(/988/.test(help.reply ?? '') && /STOP/.test(help.reply ?? ''), 'HELP replies with the practice phone, STOP instructions and 988');

  console.log('\nPatient search by phone');
  for (const q of ['425-555-0101', '4255550101', '(425) 555-0101']) {
    const found = await searchPatients(frontdesk, q, 5);
    report(found.some((p) => p.id === maya.id), `Find patient by phone typed as "${q}"`);
  }

  console.log('\nLeast privilege');
  const workerClinical = await attempt(() => worker.search('Condition', { _count: '1' }));
  report(!workerClinical.ok, 'The worker cannot read clinical data (Condition)');
  const fdLicence = await attempt(() => frontdesk.updateResource<Practitioner>({ ...provider, qualification: [] }));
  report(!fdLicence.ok, 'Front desk cannot change provider licences');

}

main().catch((err: unknown) => {
  console.error(`✗ ${normalizeErrorString(err)}`);
  process.exit(1);
});

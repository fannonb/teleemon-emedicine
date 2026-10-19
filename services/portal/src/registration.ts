// Registration is independent of scheduling. Email verification uses the same single-use
// activation flow as invitations; possible duplicates are resolved by staff, never auto-linked.
import type { MedplumClient } from '@medplum/core';
import { normalizeErrorString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT, addBusinessDays, teamCoding } from '@teleemon/core';
import { bookableStates } from './availability';
import type { PublicBookingRequest } from './booking';
import { validPerson } from './booking';
import { badRequest, HttpError } from './http';
import { createInvitation, invitationEmail } from './invitations';
import { sendEmail } from './mail';

export const REGISTRATION_RESPONSE = { status: 'check-email' } as const;

export async function publicRegister(service: MedplumClient, body: PublicBookingRequest, now = new Date()): Promise<typeof REGISTRATION_RESPONSE> {
  if (body.website) return REGISTRATION_RESPONSE;
  const person = validPerson(body, now);
  if (typeof body.state !== 'string' || !(await bookableStates(service)).includes(body.state)) throw badRequest('Choose a state where Teleemon currently offers care.', 'unlicensed-state');
  let patient: Patient;
  try {
    patient = await service.createResource<Patient>({
      resourceType: 'Patient', active: true,
      name: [{ use: 'official', given: [person.given], family: person.family }],
      birthDate: person.birthDate,
      telecom: [{ system: 'email', value: person.email }, { system: 'phone', value: person.phone, use: 'mobile' }],
      address: [{ use: 'home', state: body.state }],
      extension: [{ url: EXT.referralSource, valueString: 'Portal registration' }, ...(body.smsConsent === true ? [] : [{ url: EXT.contactOptOut, valueCode: 'sms' }])],
    });
  } catch (error) {
    if (!/possible duplicate/i.test(normalizeErrorString(error))) throw new HttpError(503, 'We could not start registration. Please try again or call the practice.');
    await service.createResource<Task>({
      resourceType: 'Task', status: 'requested', intent: 'order', priority: 'routine',
      code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'booking-review' }], text: 'Portal registration review' },
      description: 'Verify the identity of a portal registration request before sending an invitation. Do not change an existing chart email without verification.',
      performerType: teamCoding('frontdesk'), authoredOn: now.toISOString(),
      restriction: { period: { end: addBusinessDays(now, 1).toISOString() } },
      input: Object.entries(person).map(([key, value]) => ({ type: { text: key }, valueString: value })),
    });
    await sendEmail(person.email, 'Your Teleemon registration request', 'Thank you for your request. Our team will contact you within one business day if verification is needed. If you already have a portal account, sign in with your existing password. No appointment has been booked.');
    return REGISTRATION_RESPONSE;
  }
  const { token } = await createInvitation(service, patient, { now });
  const email = invitationEmail(patient, token);
  await sendEmail(person.email, email.subject, `${email.text}\n\nAfter signing in, complete your intake forms and book your first visit. Registration does not book an appointment.`);
  return REGISTRATION_RESPONSE;
}

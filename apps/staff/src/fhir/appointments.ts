import type { MedplumClient } from '@medplum/core';
import { getExtensionValue } from '@medplum/core';
import type { Appointment, Patient, Resource } from '@medplum/fhirtypes';
import type { Modality } from '@teleemon/core';
import { EXT, LICENSED_STATES } from '@teleemon/core';

export interface ScheduleRow {
  readonly appointment: Appointment;
  readonly patient: Patient | undefined;
  readonly modality: Modality | undefined;
  readonly locationState: string | undefined;
  readonly licensed: boolean;
  readonly visitType: string;
}

/** Appointments in [start, end) with their patients, in time order. */
export async function loadSchedule(medplum: MedplumClient, start: string, end: string): Promise<ScheduleRow[]> {
  const bundle = await medplum.search(
    'Appointment',
    new URLSearchParams([
      ['date', `ge${start}`],
      ['date', `lt${end}`],
      ['_sort', 'date'],
      ['_count', '200'],
      ['_include', 'Appointment:patient'],
    ]),
    { cache: 'no-cache' }
  );
  const patients = new Map<string, Patient>();
  const appointments: Appointment[] = [];
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource as Resource | undefined;
    if (r?.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
    if (r?.resourceType === 'Appointment') appointments.push(r);
  }
  return appointments.map((appointment) => {
    const patientRef = appointment.participant.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
    const locationState = getExtensionValue(appointment, EXT.patientLocationState) as string | undefined;
    return {
      appointment,
      patient: patientRef ? patients.get(patientRef) : undefined,
      modality: getExtensionValue(appointment, EXT.modality) as Modality | undefined,
      locationState,
      licensed: !locationState || (LICENSED_STATES as readonly string[]).includes(locationState),
      visitType: appointment.appointmentType?.text ?? appointment.serviceType?.[0]?.text ?? 'Visit',
    };
  });
}

export const STATUS_DISPLAY: Record<Appointment['status'], { label: string; color: string }> = {
  proposed: { label: 'Requested', color: 'gray' },
  pending: { label: 'Requested', color: 'gray' },
  booked: { label: 'Booked', color: 'gray' },
  arrived: { label: 'Checked in', color: 'blue' },
  'checked-in': { label: 'Checked in', color: 'blue' },
  fulfilled: { label: 'Completed', color: 'green' },
  cancelled: { label: 'Cancelled', color: 'gray' },
  noshow: { label: 'No-show', color: 'red' },
  'entered-in-error': { label: 'Error', color: 'gray' },
  waitlist: { label: 'Waitlist', color: 'gray' },
};

export function isOpen(status: Appointment['status']): boolean {
  return ['proposed', 'pending', 'booked', 'arrived', 'checked-in'].includes(status);
}

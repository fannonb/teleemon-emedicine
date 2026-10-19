// Licence engine (P39, SYSTEM-DESIGN.md §6). One answer to "may this provider see a patient
// located in this state on this date?", used by the booking drawer, the appointment pre-commit
// Bot and, from Phase 5, prescribing. Credentials live on Practitioner.qualification.

import type { Practitioner, PractitionerQualification } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT } from './fhir';

export type CredentialKind = 'state-license' | 'dea-registration';

export interface Credential {
  readonly kind: CredentialKind;
  readonly state: string;
  readonly number: string;
  readonly start?: string;
  readonly end?: string;
  readonly issuer?: string;
  readonly prescriptiveAuthority?: boolean;
  readonly schedules?: string[];
  /** Index in Practitioner.qualification, for editing. */
  readonly index: number;
}

export type CredentialStatus = 'active' | 'expiring' | 'expired' | 'not-yet-valid';

export function readCredentials(practitioner: Practitioner | undefined): Credential[] {
  return (practitioner?.qualification ?? []).flatMap((q, index) => {
    const coding = q.code.coding?.find((c) => c.system === CODE_SYSTEMS.qualificationType);
    if (coding?.code !== 'state-license' && coding?.code !== 'dea-registration') return [];
    const id = q.identifier?.[0];
    const state = (id?.system?.split('/').pop() ?? '').toUpperCase();
    return [
      {
        kind: coding.code as CredentialKind,
        state,
        number: id?.value ?? '',
        start: q.period?.start,
        end: q.period?.end,
        issuer: q.issuer?.display,
        prescriptiveAuthority: q.extension?.find((e) => e.url === EXT.prescriptiveAuthority)?.valueBoolean,
        schedules: q.extension?.filter((e) => e.url === EXT.deaSchedule).map((e) => e.valueCode as string),
        index,
      },
    ];
  });
}

export function toQualification(c: Omit<Credential, 'index'>): PractitionerQualification {
  const label = c.kind === 'state-license' ? `${c.state} licence` : `${c.state} DEA registration`;
  return {
    identifier: [{ system: `${CODE_SYSTEMS.qualificationType}/${c.state.toLowerCase()}`, value: c.number.trim() }],
    code: { coding: [{ system: CODE_SYSTEMS.qualificationType, code: c.kind }], text: label },
    period: c.start || c.end ? { start: c.start || undefined, end: c.end || undefined } : undefined,
    issuer: c.issuer ? { display: c.issuer } : undefined,
    extension: [
      ...(c.kind === 'state-license' && c.prescriptiveAuthority !== undefined ? [{ url: EXT.prescriptiveAuthority, valueBoolean: c.prescriptiveAuthority }] : []),
      ...(c.kind === 'dea-registration' ? (c.schedules ?? []).map((s) => ({ url: EXT.deaSchedule, valueCode: s })) : []),
    ],
  };
}

/** Status on a date (YYYY-MM-DD). "Expiring" means within 90 days. */
export function credentialStatus(c: Pick<Credential, 'start' | 'end'>, on: string = today()): CredentialStatus {
  if (c.start && on < c.start.slice(0, 10)) return 'not-yet-valid';
  if (c.end && on > c.end.slice(0, 10)) return 'expired';
  if (c.end && daysBetween(on, c.end.slice(0, 10)) <= 90) return 'expiring';
  return 'active';
}

export interface LicensureResult {
  readonly ok: boolean;
  /** Plain-English reason, shown to staff when not ok. */
  readonly reason?: string;
  readonly credential?: Credential;
}

/**
 * May the provider see a patient physically located in `state` on `date`?
 * With `controlled`, also requires an active DEA registration in that state (Phase 5).
 */
export function checkLicensure(practitioner: Practitioner | undefined, state: string | undefined, date: string, opts: { controlled?: boolean } = {}): LicensureResult {
  if (!state) {
    return { ok: false, reason: "The patient's location for this visit is required (licensure depends on where the patient is)." };
  }
  const creds = readCredentials(practitioner);
  const name = practitioner?.name?.[0] ? [practitioner.name[0].given?.[0], practitioner.name[0].family].filter(Boolean).join(' ') : 'The provider';
  const licences = creds.filter((c) => c.kind === 'state-license' && c.state === state);
  if (licences.length === 0) {
    return { ok: false, reason: `${name} is not licensed in ${state}. The patient must be located in a licensed state (${licensedStates(practitioner).join(', ') || 'none on file'}) for this visit.` };
  }
  const valid = licences.find((c) => ['active', 'expiring'].includes(credentialStatus(c, date)));
  if (!valid) {
    const latest = [...licences].sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))[0];
    const status = credentialStatus(latest, date);
    return {
      ok: false,
      credential: latest,
      reason:
        status === 'not-yet-valid'
          ? `${name}'s ${state} licence starts ${latest.start?.slice(0, 10)}; this visit is before then.`
          : `${name}'s ${state} licence expired ${latest.end?.slice(0, 10)}. Renew it in Settings → Provider & licensure before booking ${state} visits.`,
    };
  }
  if (opts.controlled) {
    const dea = creds.find((c) => c.kind === 'dea-registration' && c.state === state && ['active', 'expiring'].includes(credentialStatus(c, date)));
    if (!dea) return { ok: false, credential: valid, reason: `${name} has no active DEA registration in ${state}; controlled substances cannot be prescribed there.` };
  }
  return { ok: true, credential: valid };
}

/** States with a licence valid today. */
export function licensedStates(practitioner: Practitioner | undefined, on: string = today()): string[] {
  return [...new Set(readCredentials(practitioner).filter((c) => c.kind === 'state-license' && ['active', 'expiring'].includes(credentialStatus(c, on))).map((c) => c.state))].sort();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

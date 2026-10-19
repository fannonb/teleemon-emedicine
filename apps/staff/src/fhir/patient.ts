import { formatHumanName, getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { HumanName, Patient } from '@medplum/fhirtypes';
import { EXT, MRN_SYSTEM, SECURITY, ageInYears, isMinor } from '@teleemon/core';

export function patientName(p: Patient | undefined): string {
  return p ? formatHumanName(p.name?.[0] as HumanName) || 'Unnamed patient' : '';
}

export function patientMrn(p: Patient | undefined): string | undefined {
  return p?.identifier?.find((i) => i.system === MRN_SYSTEM)?.value;
}

export function patientAge(p: Patient | undefined): string {
  return p?.birthDate ? `${ageInYears(p.birthDate)}` : '—';
}

export function patientPronouns(p: Patient | undefined): string | undefined {
  return p ? (getExtensionValue(p, EXT.pronouns) as string | undefined) : undefined;
}

export function patientState(p: Patient | undefined): string | undefined {
  return p?.address?.[0]?.state;
}

export function isRestricted(p: Patient | undefined): boolean {
  return !!p?.meta?.security?.some((s) => s.system === SECURITY.confidentialitySystem && s.code === SECURITY.restricted);
}

export function isSelfPay(p: Patient | undefined): boolean {
  return !!p && getExtensionValue(p, EXT.selfPay) === true;
}

export function patientIsMinor(p: Patient | undefined): boolean {
  return isMinor(p?.birthDate);
}

export function optedOut(p: Patient | undefined): string[] {
  return (p?.extension ?? []).filter((e) => e.url === EXT.contactOptOut && e.valueCode).map((e) => e.valueCode as string);
}

export function telecom(p: Patient | undefined, system: 'phone' | 'email'): string | undefined {
  return p?.telecom?.find((t) => t.system === system)?.value;
}

/** True when the server refused the request because of the user's role (HTTP 403). */
export function isForbidden(err: unknown): boolean {
  const e = err as { outcome?: { issue?: { code?: string }[] } } | undefined;
  return e?.outcome?.issue?.some((i) => i.code === 'forbidden') === true || /forbidden/i.test(normalizeErrorString(err));
}

export function errorMessage(err: unknown): string {
  return normalizeErrorString(err);
}

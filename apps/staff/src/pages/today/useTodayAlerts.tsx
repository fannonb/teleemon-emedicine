import { formatHumanName } from '@medplum/core';
import type { Flag, HumanName, Patient, Resource } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconAlertOctagon, IconCertificate, IconClipboardX, IconMapPinExclamation, IconShieldOff } from '@tabler/icons-react';
import { CODE_SYSTEMS, LICENSE_QUALIFICATION_SYSTEM, ONBOARDING_REVIEW } from '@teleemon/core';
import type { ReactNode } from 'react';
import type { ScheduleRow } from '../../fhir/appointments';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { loadIntegrationHealth } from '../../operations/integrations';

export interface AlertItem {
  readonly key: string;
  readonly severity: 'red' | 'orange';
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly link?: string;
}

const EXPIRY_WINDOW_DAYS = 90;

/** Active positive safety screens, newest first. Roles that can't read Flags simply see none. */
async function loadSafetyAlerts(medplum: ReturnType<typeof useMedplum>): Promise<AlertItem[]> {
  const bundle = await medplum
    .search('Flag', { status: 'active', _include: 'Flag:subject', _sort: '-date', _count: '20' }, { cache: 'no-cache' })
    .catch(() => undefined);
  const patients = new Map<string, Patient>();
  const flags: Flag[] = [];
  for (const e of bundle?.entry ?? []) {
    const r = e.resource as Resource | undefined;
    if (r?.resourceType === 'Patient') patients.set(`Patient/${r.id}`, r);
    if (r?.resourceType === 'Flag' && r.code.coding?.some((c) => c.system === CODE_SYSTEMS.flagCode)) flags.push(r);
  }
  return flags.map((f) => {
    const p = patients.get(f.subject.reference as string);
    return {
      key: `flag-${f.id}`,
      severity: 'red' as const,
      icon: <IconAlertOctagon size={16} />,
      title: `${f.code.text ?? 'Safety flag'}: ${p ? formatHumanName(p.name?.[0] as HumanName) : 'patient'}`,
      detail: `Since ${formatDate(f.period?.start?.slice(0, 10))}. Review today and complete a safety assessment.`,
      link: p ? `/patients/${p.id}/measures` : undefined,
    };
  });
}

/** Licences and DEA registrations expiring within 90 days, or already expired. */
async function loadCredentialAlerts(medplum: ReturnType<typeof useMedplum>): Promise<AlertItem[]> {
  const practitioners = await medplum.searchResources('Practitioner', { _count: '50', active: 'true' }).catch(() => []);
  const now = Date.now();
  const alerts: AlertItem[] = [];
  for (const p of practitioners) {
    for (const q of p.qualification ?? []) {
      if (!q.code.coding?.some((c) => c.system === LICENSE_QUALIFICATION_SYSTEM)) continue;
      const end = q.period?.end;
      if (!end) continue;
      const days = Math.ceil((new Date(end).getTime() - now) / 86400000);
      if (days > EXPIRY_WINDOW_DAYS) continue;
      const label = q.code.text ?? 'Licence';
      alerts.push({
        key: `${p.id}-${label}-${end}`,
        severity: days <= 30 ? 'red' : 'orange',
        icon: <IconCertificate size={16} />,
        title: days < 0 ? `${label} expired` : `${label} expires in ${days} days`,
        detail: `${formatHumanName(p.name?.[0] as HumanName)} · ${days < 0 ? 'expired' : 'expires'} ${formatDate(end.slice(0, 10))}. ${
          days < 0 ? 'Booking and prescribing in this state are blocked.' : 'Renew before it lapses to avoid blocked bookings.'
        }`,
        link: '/settings/provider',
      });
    }
  }
  return alerts;
}

/**
 * New-patient visits today whose forms were not submitted in the portal (no onboarding review yet).
 * A warning, not a block: forms can be completed at check-in (PATIENT-ONBOARDING-PLAN.md, decision 5).
 */
async function loadIntakeAlerts(medplum: ReturnType<typeof useMedplum>, schedule: ScheduleRow[]): Promise<AlertItem[]> {
  const rows = schedule.filter((r) => r.patient && ['booked', 'arrived', 'checked-in'].includes(r.appointment.status) &&
    r.appointment.appointmentType?.coding?.some((c) => c.system === CODE_SYSTEMS.visitType && c.code === 'new-eval'));
  if (!rows.length) return [];
  const reviews = await medplum.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|${ONBOARDING_REVIEW}`, patient: rows.map((r) => `Patient/${r.patient?.id}`).join(','), _count: '100' }, { cache: 'no-cache' }).catch(() => undefined);
  if (!reviews) return [];
  const missing = rows.filter((r) => !reviews.some((t) => t.for?.reference === `Patient/${r.patient?.id}`));
  if (!missing.length) return [];
  return [{
    key: 'intake-missing',
    severity: 'orange',
    icon: <IconClipboardX size={16} />,
    title: `${missing.length} new patient${missing.length > 1 ? 's' : ''} today without submitted forms`,
    detail: `${missing.map((r) => formatHumanName(r.patient?.name?.[0] as HumanName)).join(', ')}. Ask them to finish the portal forms before the visit, or complete them at check-in.`,
    link: `/patients/${missing[0].patient?.id}/demographics`,
  }];
}

export interface TodayAlerts {
  readonly items: AlertItem[];
  readonly loading: boolean;
}

/** Everything that needs attention today, most serious first. Shared by the stat strip and the Alerts card. */
export function useTodayAlerts(schedule: ScheduleRow[] | undefined, mfaEnforced: boolean, isAdmin: boolean): TodayAlerts {
  const medplum = useMedplum();
  const credentials = useLoader(() => loadCredentialAlerts(medplum), [medplum], 300000);
  const safety = useLoader(() => loadSafetyAlerts(medplum), [medplum], 60000);
  const scheduleKey = schedule?.map((r) => `${r.appointment.id}:${r.appointment.status}`).join() ?? '';
  const intake = useLoader(() => loadIntakeAlerts(medplum, schedule ?? []), [medplum, scheduleKey], 120000);
  const integrations = useLoader(async (): Promise<AlertItem[]> => {
    if (!isAdmin) return [];
    const signals = await loadIntegrationHealth(medplum);
    return signals.filter(signal => signal.state === 'unavailable' || (signal.key === 'worker' && !!signal.lastSignalAt && signal.state === 'unknown')).map(signal => ({
      key: `integration-${signal.key}`, severity: 'red', icon: <IconAlertOctagon size={16} />,
      title: signal.state === 'unavailable' ? `${signal.label} reported a failure` : 'Background worker heartbeat is stale',
      detail: 'Review the last observed signal and service configuration in Integrations.', link: '/settings/integrations',
    }));
  }, [medplum, isAdmin], 60000);

  const items: AlertItem[] = [...(safety.data ?? [])];
  if (isAdmin && !mfaEnforced) {
    items.push({
      key: 'mfa',
      severity: 'red',
      icon: <IconShieldOff size={16} />,
      title: 'Two-factor sign-in is not enforced',
      detail: 'Run `npm run setup -- --mfa` so no user can reach patient data without MFA.',
      link: '/settings/security',
    });
  }
  const unlicensed = schedule?.filter((r) => !r.licensed && !['cancelled', 'entered-in-error', 'noshow'].includes(r.appointment.status)) ?? [];
  if (unlicensed.length > 0) {
    items.push({
      key: 'unlicensed',
      severity: 'red',
      icon: <IconMapPinExclamation size={16} />,
      title: `${unlicensed.length} visit${unlicensed.length > 1 ? 's' : ''} with a patient in an unlicensed state`,
      detail: `Located in ${[...new Set(unlicensed.map((r) => r.locationState))].join(', ')}. Reschedule, or confirm the patient's location at check-in.`,
      link: '/calendar',
    });
  }
  items.push(...(intake.data ?? []));
  items.push(...(credentials.data ?? []));
  items.push(...(integrations.data ?? []));
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
  return { items, loading: (credentials.loading && !credentials.data) || (safety.loading && !safety.data) };
}

import { Anchor, Avatar, Badge, Breadcrumbs, Button, Center, Group, Loader, Modal, ScrollArea, Select, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { createReference, getReferenceString } from '@medplum/core';
import type { AllergyIntolerance, Appointment, AuditEvent, Coverage, Flag, Patient } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertOctagon, IconLock, IconUserX } from '@tabler/icons-react';
import { CODE_SYSTEMS } from '@teleemon/core';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { PatientFlags } from '../../components/PatientBadges';
import { EmptyState, ErrorState } from '../../components/states';
import { isForbidden, isRestricted, isSelfPay, patientAge, patientMrn, patientName, patientPronouns, telecom } from '../../fhir/patient';
import { rememberPatient } from '../../fhir/patientSearch';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';
import { canSee, getPage } from '../../navigation';
import { useRoles } from '../../session/roles';
import { ChartContext } from './ChartContext';
import classes from './Chart.module.css';

export const CHART_TABS: { path: string; label: string; id: string }[] = [
  { path: '', label: 'Overview', id: 'P09' },
  { path: 'demographics', label: 'Demographics', id: 'P10' },
  { path: 'insurance', label: 'Insurance', id: 'P11' },
  { path: 'consents', label: 'Consents', id: 'P12' },
  { path: 'problems', label: 'Problems', id: 'P13' },
  { path: 'medications', label: 'Meds & allergies', id: 'P14' },
  { path: 'measures', label: 'Measures', id: 'P15' },
  { path: 'labs', label: 'Labs', id: 'P16' },
  { path: 'documents', label: 'Documents', id: 'P17' },
  { path: 'encounters', label: 'Encounters', id: 'P18' },
  { path: 'account', label: 'Account', id: 'P19' },
  { path: 'communications', label: 'Messages', id: 'P20' },
];

interface HeaderFacts {
  readonly allergies?: AllergyIntolerance[];
  readonly coverage?: Coverage;
  readonly next?: Appointment;
  readonly safetyFlags?: Flag[];
}

export function ChartLayout(): JSX.Element {
  const { patientId } = useParams();
  // A chart owns patient-specific permissions, loaders, forms and modal state.
  // Remount the whole subtree before rendering a different patient's record.
  return <PatientChart key={patientId} />;
}

function PatientChart(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const { roles } = useRoles();
  const tabs = CHART_TABS.filter((t) => canSee(getPage(t.id), roles));
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const patient = useLoader(() => medplum.readResource('Patient', patientId as string, { cache: 'no-cache' }), [patientId, version, medplum]);

  const facts = useLoader<HeaderFacts>(async () => {
    const ref = `Patient/${patientId}`;
    // Each fact is optional: a role that can't read allergies still gets the rest of the header.
    const [allergies, coverage, next, flags] = await Promise.all([
      medplum.searchResources('AllergyIntolerance', { patient: ref, 'clinical-status': 'active', _count: '20' }).catch(() => undefined),
      medplum.searchOne('Coverage', { beneficiary: ref, status: 'active' }).catch(() => undefined),
      medplum
        .searchOne('Appointment', new URLSearchParams([['patient', ref], ['date', `ge${new Date().toISOString()}`], ['status', 'booked,arrived,checked-in'], ['_sort', 'date']]))
        .catch(() => undefined),
      medplum.searchResources('Flag', { subject: ref, status: 'active' }).catch(() => undefined),
    ]);
    const safetyFlags = flags?.filter((f) => f.code.coding?.some((c) => c.system === CODE_SYSTEMS.flagCode));
    return { allergies, coverage, next, safetyFlags };
  }, [patientId, version, medplum]);

  useEffect(() => {
    if (patient.data?.id) rememberPatient(patient.data.id);
  }, [patient.data?.id]);

  const ctx = useMemo(() => (patient.data ? { patient: patient.data, refresh } : undefined), [patient.data, refresh]);

  if (patient.loading && !patient.data) {
    return (
      <Center h="60vh">
        <Loader color="brand" />
      </Center>
    );
  }
  if (patient.error) {
    return (
      <div style={{ padding: 'var(--mantine-spacing-xl)' }}>
        {isForbidden(patient.error) ? (
          <EmptyState icon={<IconLock size={22} />} title="You don't have access to this chart" />
        ) : /not found/i.test(patient.error.message) ? (
          <EmptyState icon={<IconUserX size={22} />} title="Patient not found">
            The record may have been merged or the link is out of date.
          </EmptyState>
        ) : (
          <ErrorState error={patient.error} onRetry={patient.reload} />
        )}
      </div>
    );
  }
  if (!patient.data || !ctx) return <></>;

  return (
    <ChartAccessAudit patient={patient.data}>
    <RestrictedGate patient={patient.data}>
      <ChartContext.Provider value={ctx}>
        <div className={classes.sticky}>
          <ChartHeader patient={patient.data} facts={facts.data} />
          <ScrollArea type="auto" scrollbarSize={6} offsetScrollbars="x">
            <nav className={classes.tabs} aria-label="Chart sections">
              {tabs.map((t) => (
                <NavLink key={t.id} to={t.path ? `/patients/${patientId}/${t.path}` : `/patients/${patientId}`} end className={({ isActive }) => `${classes.tab} ${isActive ? classes.tabActive : ''}`}>
                  {t.label}
                </NavLink>
              ))}
            </nav>
          </ScrollArea>
        </div>
        <div className={classes.body}>
          <Outlet />
        </div>
      </ChartContext.Provider>
    </RestrictedGate>
    </ChartAccessAudit>
  );
}

/** Fail closed on each chart section view. This instruments the app, not direct REST reads. */
function ChartAccessAudit({ patient, children }: { readonly patient: Patient; readonly children: ReactNode }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const { pathname } = useLocation();
  const [recordedPath, setRecordedPath] = useState<string>();
  const [error, setError] = useState<Error>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    const who = profile ? createReference(profile) : undefined;
    void medplum.createResource<AuditEvent>({
      resourceType: 'AuditEvent',
      type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest' },
      subtype: [{ system: 'https://fhir.teleemon.com/audit', code: 'chart-view' }],
      action: 'R', recorded: new Date().toISOString(), outcome: '0',
      agent: [{ who, requestor: true }], source: { observer: who ?? { display: 'Teleemon staff app' } },
      entity: [{ what: { reference: `Patient/${patient.id}` }, detail: [{ type: 'section', valueString: pathname.split('/')[3] || 'overview' }] }],
    }).then(() => { if (active) setRecordedPath(pathname); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err : new Error(String(err))); });
    return () => { active = false; };
  }, [medplum, patient.id, pathname, profile, retry]);
  if (error) return <div style={{ padding: 'var(--mantine-spacing-xl)' }}><ErrorState error={error} onRetry={() => setRetry(value => value + 1)} /></div>;
  if (recordedPath !== pathname) return <Center h="40vh"><Loader aria-label="Recording chart access" /></Center>;
  return <>{children}</>;
}

function ChartHeader({ patient, facts }: { readonly patient: Patient; readonly facts?: HeaderFacts }): JSX.Element {
  const preferred = patient.name?.find((n) => n.use === 'nickname')?.given?.[0];
  const pronouns = patientPronouns(patient);
  const name = patientName(patient);
  const initials = `${patient.name?.[0]?.given?.[0]?.[0] ?? ''}${patient.name?.[0]?.family?.[0] ?? ''}`;
  const realAllergies = facts?.allergies?.filter((a) => !a.code?.coding?.some((c) => c.code === '716186003'));
  const nka = facts?.allergies && facts.allergies.length > 0 && realAllergies?.length === 0;

  return (
    <header className={classes.header}>
      <Breadcrumbs separator="/" mb={8} fz="xs" separatorMargin={6}>
        <Anchor component={Link} to="/patients" size="xs" c="dimmed">
          Patients
        </Anchor>
        <Text size="xs" c="dimmed">
          {name}
        </Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Group gap="md" wrap="nowrap" align="flex-start">
          <Avatar size={48} radius="xl" color="navy" variant="filled">
            {initials}
          </Avatar>
          <div>
            <Group gap={8} align="baseline" wrap="wrap">
              <Text fz={20} fw={700} lh={1.2}>
                {name}
              </Text>
              {preferred && <Text c="dimmed">“{preferred}”</Text>}
              {pronouns && (
                <Text size="sm" c="dimmed">
                  ({pronouns})
                </Text>
              )}
            </Group>
            <Text size="sm" c="dimmed" className="tm-num" mt={2}>
              {patientAge(patient)} y · DOB {formatDate(patient.birthDate)} · {patientMrn(patient) ?? 'No chart number'} · {telecom(patient, 'phone') ?? 'no phone'}
            </Text>
            <Group gap={6} mt={8}>
              {facts?.safetyFlags?.map((f) => (
                <Tooltip key={f.id} label={`Active since ${formatDate(f.period?.start?.slice(0, 10))}. Review in Measures and complete a safety assessment.`}>
                  <Badge color="red" variant="filled" leftSection={<IconAlertOctagon size={12} />}>
                    {f.code.text ?? 'Safety flag'}
                  </Badge>
                </Tooltip>
              ))}
              <PatientFlags patient={patient} />
            </Group>
          </div>
        </Group>
        <Group gap="xl" wrap="wrap" className={classes.facts}>
          <Fact label="Allergies">
            {facts?.allergies === undefined ? (
              <Text size="sm" c="dimmed">—</Text>
            ) : realAllergies && realAllergies.length > 0 ? (
              <Text size="sm" fw={600} c="red.7">
                {realAllergies.map((a) => a.code?.text ?? a.code?.coding?.[0]?.display).join(', ')}
              </Text>
            ) : nka ? (
              <Text size="sm">No known allergies</Text>
            ) : (
              <Text size="sm" c="orange.7" fw={600}>
                Not yet recorded
              </Text>
            )}
          </Fact>
          <Fact label="Insurance">
            <Text size="sm">{facts?.coverage?.payor?.[0]?.display ?? (isSelfPay(patient) ? 'Self-pay' : '—')}</Text>
          </Fact>
          <Fact label="Next visit">
            <Text size="sm" className="tm-num">
              {facts?.next?.start ? `${formatDate(facts.next.start.slice(0, 10))} · ${formatTime(facts.next.start)}` : 'None booked'}
            </Text>
          </Fact>
        </Group>
      </Group>
    </header>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div>
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" lts="0.04em">
        {label}
      </Text>
      {children}
    </div>
  );
}

const REASONS = ['Scheduled or same-day visit', 'Returning a call or message', 'Billing or insurance task', 'Clinical emergency', 'Other (explain)'];

/** P07: restricted charts require a reason to open. The reason is written to the audit log. */
function RestrictedGate({ patient, children }: { readonly patient: Patient; readonly children: ReactNode }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const restricted = isRestricted(patient);
  const [granted, setGranted] = useState(!restricted);
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  if (granted) return <>{children}</>;

  const needsDetail = reason === 'Other (explain)' || reason === 'Clinical emergency';
  const submit = async (): Promise<void> => {
    if (!reason || (needsDetail && detail.trim().length < 5)) {
      setError('Choose a reason, and add a short explanation for emergencies and "Other".');
      return;
    }
    setSaving(true);
    try {
      const who = profile ? createReference(profile) : undefined;
      await medplum.createResource<AuditEvent>({
        resourceType: 'AuditEvent',
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'RESTful Operation' },
        subtype: [{ system: 'http://hl7.org/fhir/restful-interaction', code: 'read', display: 'read' }],
        action: 'R',
        recorded: new Date().toISOString(),
        outcome: '0',
        outcomeDesc: `Restricted chart opened. Reason: ${reason}${detail.trim() ? ` — ${detail.trim()}` : ''}`,
        purposeOfEvent: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'BTG', display: 'break the glass' }] }],
        agent: [{ who, requestor: true }],
        source: { observer: who ?? { display: 'Teleemon staff app' } },
        entity: [{ what: { reference: getReferenceString(patient) } }],
      });
      setGranted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened onClose={() => navigate('/patients')} title="Restricted chart" centered closeOnClickOutside={false}>
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap">
          <IconLock size={18} color="var(--mantine-color-orange-6)" />
          <Text size="sm">
            <b>{patientName(patient)}</b>'s chart is restricted. Your reason for opening it is recorded in the audit log and reviewed by the practice administrator.
          </Text>
        </Group>
        <Select label="Reason" data={REASONS} value={reason} onChange={setReason} required />
        {needsDetail && <Textarea label="Explanation" value={detail} onChange={(e) => setDetail(e.currentTarget.value)} autosize minRows={2} required />}
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={() => navigate('/patients')}>
            Go back
          </Button>
          <Button color="orange" loading={saving} onClick={submit}>
            Open chart
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

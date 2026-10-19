import { Alert, Anchor, Badge, Button, Card, Center, Checkbox, Grid, Group, List, Loader, Modal, SegmentedControl, Select, Stack, Text, Textarea, ThemeIcon, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, formatHumanName, getExtensionValue, normalizeErrorString } from '@medplum/core';
import type { AuditEvent, Composition, DocumentReference, HumanName, Organization } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertTriangle, IconArrowLeft, IconCircleCheck, IconCircleDashed, IconDownload, IconFileText, IconPencilPlus, IconPrinter, IconRosetteDiscountCheck, IconSend } from '@tabler/icons-react';
import type { NoteData, RenderedSection, SectionKey } from '@teleemon/core';
import { CODE_SYSTEMS, EXT, SECTION_LABELS, isLateEntry, signProblems } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ErrorState } from '../../components/states';
import { uploadDocument } from '../../fhir/documents';
import { loadMeds, medName } from '../../fhir/clinical';
import { patientMrn, patientName } from '../../fhir/patient';
import type { VisitContext } from '../../fhir/visits';
import { buildAmendment, finishVisit, loadVisit, noteData, signVisit, visitModality, visitState } from '../../fhir/visits';
import type { ExportInput, ExportKind } from '../../export/noteDocument';

// The Word library is large: load the export module only when someone exports.
const exporter = (): Promise<typeof import('../../export/noteDocument')> => import('../../export/noteDocument');
const EXPORT_LABELS: Record<ExportKind, string> = { full: 'Full clinical note', summary: 'Session summary', avs: 'After-visit summary (patient copy)' };
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';
import classes from './Encounter.module.css';

function sectionText(div: string | undefined): string {
  return (div ?? '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** The sections exactly as stored on the Composition: what was (or will be) signed. */
export function storedSections(c: Composition): RenderedSection[] {
  return (c.section ?? []).map((s) => ({ key: (s.code?.coding?.[0]?.code ?? 'plan') as SectionKey, title: s.title ?? '', text: sectionText(s.text?.div) }));
}

// P23 Review, sign and amend · P24 Summary export and after-visit summary.
export function NotePage(): JSX.Element {
  const { encounterId } = useParams();
  const medplum = useMedplum();
  const visit = useLoader(() => loadVisit(medplum, encounterId as string), [encounterId]);
  if (visit.error) return <div style={{ padding: 24 }}><ErrorState error={visit.error} onRetry={visit.reload} /></div>;
  if (!visit.data) return <Center h="60vh"><Loader color="brand" /></Center>;
  if (!visit.data.note) return <Navigate to={`/encounters/${encounterId}`} replace />;
  return visit.data.note.status === 'final' ? <SignedNote ctx={visit.data} onChanged={visit.reload} /> : <ReviewAndSign ctx={visit.data} onSigned={visit.reload} />;
}

function Paper({ ctx, composition, stamp }: { readonly ctx: VisitContext; readonly composition: Composition; readonly stamp?: JSX.Element }): JSX.Element {
  return (
    <div className={classes.paper}>
      <Group justify="space-between" align="flex-start" mb="xs">
        <div>
          <Title order={2}>{composition.title}</Title>
          <Text size="sm" c="dimmed">
            {patientName(ctx.patient)} · DOB {formatDate(ctx.patient.birthDate)} · {patientMrn(ctx.patient)} · located in {visitState(ctx.encounter)} · {visitModality(ctx.encounter)}
          </Text>
        </div>
        {stamp}
      </Group>
      {storedSections(composition).map((s) => (
        <div key={`${s.key}-${s.title}`}>
          <div className={classes.paperHeading}>{s.title}</div>
          <div className={classes.paperText}>{s.text}</div>
        </div>
      ))}
      {ctx.amendments.map((a) => (
        <div key={a.id} className={classes.amendment}>
          <Text size="sm" fw={650}>
            {a.title}
          </Text>
          <Text size="xs" c="dimmed">
            Reason: {getExtensionValue(a, EXT.amendmentReason) as string} · signed {formatDate(a.date?.slice(0, 10))} {formatTime(a.date)}
          </Text>
          <div className={classes.paperText}>{storedSections(a).map((s) => s.text).join('\n')}</div>
        </div>
      ))}
    </div>
  );
}

function ReviewAndSign({ ctx, onSigned }: { readonly ctx: VisitContext; readonly onSigned: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const [attested, setAttested] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string>();
  const data = noteData(ctx.note) as NoteData;
  const problems = signProblems(data);
  const late = isLateEntry(ctx.encounter.period?.start, new Date().toISOString());
  const isProvider = !!profile && ctx.encounter.participant?.some((p) => p.individual?.reference === `Practitioner/${profile.id}`);
  const measures = data.measuresSnapshot;

  const sign = async (): Promise<void> => {
    if (!profile) return;
    setSigning(true);
    setError(undefined);
    try {
      await signVisit(medplum, ctx, data, profile, measures);
      notifications.show({ color: 'brand', title: 'Note signed', message: 'The note is locked. Changes are made by addendum.' });
      onSigned();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSigning(false);
    }
  };

  const groups = new Map<string, string[]>();
  for (const p of problems) {
    const key = p.section ? (p.section === 'billing' ? 'Billing' : p.section === 'meds' ? 'Medications' : SECTION_LABELS[p.section as SectionKey]) : 'Note';
    groups.set(key, [...(groups.get(key) ?? []), p.message]);
  }

  return (
    <div className={classes.body}>
      <Group justify="space-between" mb="md">
        <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} component={Link} to={`/encounters/${ctx.encounter.id}`}>
          Back to editing
        </Button>
        <Badge color="orange" variant="light" size="lg">
          Draft · not signed
        </Badge>
      </Group>
      <Grid gutter="lg" align="flex-start">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper ctx={ctx} composition={ctx.note as Composition} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Card className={classes.stickySide}>
            <Title order={2} mb="sm">
              Before signing
            </Title>
            {problems.length === 0 ? (
              <Group gap="xs" mb="md">
                <ThemeIcon color="green" variant="light" radius="xl">
                  <IconCircleCheck size={16} />
                </ThemeIcon>
                <Text size="sm">Diagnoses, codes, time, risk assessment and medications are complete.</Text>
              </Group>
            ) : (
              <Stack gap="sm" mb="md">
                {[...groups.entries()].map(([section, msgs]) => (
                  <div key={section}>
                    <Text size="xs" fw={650} c="dimmed" tt="uppercase">
                      {section}
                    </Text>
                    <List size="sm" spacing={2} icon={<IconCircleDashed size={14} color="var(--mantine-color-orange-6)" />}>
                      {msgs.map((m) => (
                        <List.Item key={m}>{m}</List.Item>
                      ))}
                    </List>
                  </div>
                ))}
                <Button variant="light" onClick={() => navigate(`/encounters/${ctx.encounter.id}`)}>
                  Fix in the editor
                </Button>
              </Stack>
            )}
            {late && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} mb="md">
                This visit started more than 72 hours ago. The note will be marked as a late entry.
              </Alert>
            )}
            {!isProvider && (
              <Alert color="gray" variant="light" mb="md">
                Only the visit's provider can sign this note.
              </Alert>
            )}
            {error && (
              <Alert color="red" mb="md" title="Not signed">
                {error}
              </Alert>
            )}
            <Checkbox
              label="I personally performed this service and have reviewed and edited this documentation, including any AI-assisted content."
              checked={attested}
              onChange={(e) => setAttested(e.currentTarget.checked)}
              disabled={!isProvider || problems.length > 0}
              mb="md"
            />
            <Button fullWidth size="md" leftSection={<IconRosetteDiscountCheck size={18} />} disabled={!attested || problems.length > 0 || !isProvider} loading={signing} onClick={sign}>
              Sign note
            </Button>
            <Text size="xs" c="dimmed" mt="sm">
              Signing locks the note, ends the visit and marks the appointment completed. The server checks the same rules.
            </Text>
          </Card>
        </Grid.Col>
      </Grid>
    </div>
  );
}

function SignedNote({ ctx, onChanged }: { readonly ctx: VisitContext; readonly onChanged: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [kind, setKind] = useState<ExportKind>('summary');
  const [amending, setAmending] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completionError, setCompletionError] = useState<string>();
  const note = ctx.note as Composition;
  const data = noteData(note) as NoteData;
  const signedBy = note.attester?.[0];
  const late = getExtensionValue(note, EXT.lateEntry) === true;
  const completionPending = ctx.encounter.status !== 'finished' || !!ctx.appointment && ['arrived', 'checked-in', 'booked'].includes(ctx.appointment.status);
  const complete = async (): Promise<void> => {
    setCompleting(true);
    setCompletionError(undefined);
    try {
      await finishVisit(medplum, ctx);
      onChanged();
    } catch (err) {
      setCompletionError(normalizeErrorString(err));
    } finally {
      setCompleting(false);
    }
  };

  const extras = useLoader(async () => {
    const [org, meds, released] = await Promise.all([
      medplum.searchOne('Organization', {}).catch(() => undefined),
      loadMeds(medplum, ctx.patient).catch(() => []),
      medplum
        .searchResources('DocumentReference', { encounter: `Encounter/${ctx.encounter.id}`, category: `${CODE_SYSTEMS.documentCategory}|after-visit-summary` }, { cache: 'no-cache' })
        .catch(() => [] as DocumentReference[]),
    ]);
    return { org: org as Organization | undefined, meds, released };
  }, [ctx.encounter.id]);

  const input = (): ExportInput => {
    const org = extras.data?.org;
    const addr = org?.address?.[0];
    const prov = ctx.practitioner?.name?.[0];
    const start = ctx.encounter.period?.start ?? note.date;
    return {
      practice: { name: org?.name ?? 'Teleemon Behavioral Health & Wellness', address: addr ? [addr.line?.join(', '), addr.city, addr.state, addr.postalCode].filter(Boolean).join(', ') : undefined, phone: org?.telecom?.find((t) => t.system === 'phone')?.value, fax: org?.telecom?.find((t) => t.system === 'fax')?.value },
      patient: { name: patientName(ctx.patient), firstName: ctx.patient.name?.find((n) => n.use === 'nickname')?.given?.[0] ?? ctx.patient.name?.[0]?.given?.[0] ?? '', dob: formatDate(ctx.patient.birthDate), mrn: patientMrn(ctx.patient) },
      visit: { date: formatDate(start.slice(0, 10)), time: formatTime(start), type: ctx.encounter.type?.[0]?.text ?? 'Visit', modality: (visitModality(ctx.encounter) ?? 'video').replace(/^./, (c) => c.toUpperCase()), state: visitState(ctx.encounter) ?? '—' },
      provider: { name: prov ? [prov.given?.[0], prov.family].filter(Boolean).join(' ') : signedBy?.party?.display ?? 'Provider', credentials: prov?.suffix?.join(', ') },
      note: data,
      sections: storedSections(note),
      medications: data.medicationsSnapshot ?? (extras.data?.meds ?? []).map((m) => `${medName(m)}${m.dosage?.[0]?.text ? ` · ${m.dosage[0].text}` : ''}`),
      signed: signedBy ? { at: `${formatDate(signedBy.time?.slice(0, 10))} ${formatTime(signedBy.time)}`, by: prov ? formatHumanName(prov as HumanName) : 'the provider', late } : undefined,
      amendments: ctx.amendments.map((a) => ({ title: a.title ?? 'Addendum', text: storedSections(a).map((s) => s.text).join('\n'), reason: (getExtensionValue(a, EXT.amendmentReason) as string) ?? '', at: `${formatDate(a.date?.slice(0, 10))} ${formatTime(a.date)}` })),
    };
  };

  const logExport = async (what: string): Promise<void> => {
    if (!profile) return;
    // Every export is recorded (P24: who, what, when).
    await medplum
      .createResource<AuditEvent>({
        resourceType: 'AuditEvent',
        type: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110106', display: 'Export' },
        action: 'R',
        recorded: new Date().toISOString(),
        outcome: '0',
        outcomeDesc: what,
        agent: [{ who: createReference(profile), requestor: true }],
        source: { observer: createReference(profile) },
        entity: [{ what: createReference(note) }, { what: createReference(ctx.patient) }],
      })
      .catch(() => undefined);
  };

  const downloadWord = async (): Promise<void> => {
    const exportInput = input();
    const { docxBlob, exportFileName } = await exporter();
    const blob = await docxBlob(exportInput, kind);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(exportInput, kind);
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    await logExport(`Exported ${EXPORT_LABELS[kind]} as Word`);
  };

  const print = async (): Promise<void> => {
    const w = window.open('', '_blank', 'noopener=no');
    if (!w) {
      notifications.show({ color: 'orange', message: 'Allow pop-ups for this site to print or save as PDF.' });
      return;
    }
    const { printHtml } = await exporter();
    w.document.write(printHtml(input(), kind));
    w.document.close();
    w.focus();
    w.print();
    await logExport(`Printed ${EXPORT_LABELS[kind]} (PDF)`);
  };

  const releaseAvs = async (): Promise<void> => {
    try {
      const exportInput = input();
      const { docxBlob, exportFileName } = await exporter();
      const blob = await docxBlob(exportInput, 'avs');
      const file = new File([blob], exportFileName(exportInput, 'avs'), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      await uploadDocument(medplum, { patient: ctx.patient, file, category: 'after-visit-summary', title: `After-visit summary · ${exportInput.visit.date}`, encounter: ctx.encounter });
      await logExport('Released after-visit summary to the patient');
      notifications.show({ color: 'brand', message: 'After-visit summary released. The patient can now read it in the portal.' });
      extras.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not released', message: normalizeErrorString(err) });
    }
  };

  const stamp = (
    <Stack gap={4} align="flex-end">
      <Badge color="green" size="lg" leftSection={<IconRosetteDiscountCheck size={14} />}>
        Signed
      </Badge>
      <Text size="xs" c="dimmed" ta="right">
        {signedBy?.party?.display ?? 'Provider'} · {formatDate(signedBy?.time?.slice(0, 10))} {formatTime(signedBy?.time)}
      </Text>
      {late && (
        <Badge color="orange" variant="light" size="sm">
          Late entry
        </Badge>
      )}
      {ctx.amendments.length > 0 && (
        <Badge color="blue" variant="light" size="sm">
          {ctx.amendments.length} addend{ctx.amendments.length > 1 ? 'a' : 'um'}
        </Badge>
      )}
    </Stack>
  );

  const released = extras.data?.released ?? [];
  return (
    <div className={classes.body}>
      {completionPending && (
        <Alert color="orange" title="The note is signed; visit completion is pending" icon={<IconAlertTriangle size={16} />} mb="md">
          <Text size="sm">Complete the encounter and update its calendar status. The signed note stays unchanged.</Text>
          {completionError && <Text size="sm" c="red" role="alert" mt="xs">{completionError}</Text>}
          <Button size="xs" mt="sm" onClick={complete} loading={completing}>Complete visit</Button>
        </Alert>
      )}
      <Group justify="space-between" mb="md">
        <Anchor component={Link} to={`/patients/${ctx.patient.id}/encounters`} size="sm">
          ← {patientName(ctx.patient)} · encounters
        </Anchor>
      </Group>
      <Grid gutter="lg" align="flex-start">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper ctx={ctx} composition={note} stamp={stamp} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Stack gap="lg" className={classes.stickySide}>
            <Card>
              <Title order={2} mb="sm">
                Export
              </Title>
              <SegmentedControl
                fullWidth
                size="xs"
                value={kind}
                onChange={(v) => setKind(v as ExportKind)}
                data={[
                  { value: 'summary', label: 'Session summary' },
                  { value: 'full', label: 'Full note' },
                  { value: 'avs', label: 'Patient copy' },
                ]}
                mb="sm"
              />
              <Text size="xs" c="dimmed" mb="sm">
                {kind === 'avs'
                  ? 'Plain language: plan, next visit and crisis resources only.'
                  : kind === 'summary'
                    ? 'Practice letterhead, visit details, medications, MSE, measures, risk, assessment, plan and attestation.'
                    : 'Every documented section, addenda and the attestation.'}{' '}
                Private psychotherapy notes are never included.
              </Text>
              <Group grow>
                <Button leftSection={<IconDownload size={16} />} onClick={downloadWord} loading={extras.loading && !extras.data}>
                  Word
                </Button>
                <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={print}>
                  Print / PDF
                </Button>
              </Group>
              <Text size="xs" c="dimmed" mt="xs">
                Each export is recorded in the audit log.
              </Text>
            </Card>
            <Card>
              <Title order={2} mb="xs">
                After-visit summary
              </Title>
              {released.length ? (
                <Group gap="xs">
                  <ThemeIcon color="green" variant="light" radius="xl" size="sm">
                    <IconCircleCheck size={13} />
                  </ThemeIcon>
                  <Text size="sm">Released {formatDate(released[0].date?.slice(0, 10))} · in Documents</Text>
                </Group>
              ) : (
                <Text size="sm" c="dimmed" mb="sm">
                  Not released yet.
                </Text>
              )}
              <Button mt="sm" variant={released.length ? 'default' : 'filled'} leftSection={<IconSend size={16} />} onClick={releaseAvs} fullWidth>
                {released.length ? 'Release an updated copy' : 'Release to patient'}
              </Button>
            </Card>
            <Card>
              <Title order={2} mb="xs">
                Amend
              </Title>
              <Text size="sm" c="dimmed" mb="sm">
                The signed note can't change. Add an addendum (new information) or a correction (fixing an error); both are signed, dated and shown with the original.
              </Text>
              <Button variant="light" leftSection={<IconPencilPlus size={16} />} onClick={() => setAmending(true)} fullWidth>
                Add addendum or correction
              </Button>
            </Card>
            <Text size="xs" c="dimmed">
              <IconFileText size={12} /> Signing creates the charge for billing review (Charge review).
            </Text>
          </Stack>
        </Grid.Col>
      </Grid>
      {amending && <AmendModal ctx={ctx} onClose={() => setAmending(false)} onSaved={() => { setAmending(false); onChanged(); }} />}
    </div>
  );
}

function AmendModal({ ctx, onClose, onSaved }: { readonly ctx: VisitContext; readonly onClose: () => void; readonly onSaved: () => void }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [kind, setKind] = useState<'appends' | 'replaces'>('appends');
  const [text, setText] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (): Promise<void> => {
    if (!profile || !reason || !text.trim()) return;
    setSaving(true);
    try {
      await medplum.createResource(buildAmendment(ctx, profile, kind, text.trim(), reason));
      notifications.show({ color: 'brand', message: `${kind === 'appends' ? 'Addendum' : 'Correction'} signed and added to the note.` });
      onSaved();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="Amend signed note" size="lg" centered>
      <Stack>
        {error && <Alert color="red">{error}</Alert>}
        <SegmentedControl value={kind} onChange={(v) => setKind(v as typeof kind)} data={[{ value: 'appends', label: 'Addendum (new information)' }, { value: 'replaces', label: 'Correction (fix an error)' }]} />
        <Select
          label="Reason"
          required
          data={kind === 'appends' ? ['Additional information received after the visit', 'Lab or outside record review', 'Clarification requested', 'Other'] : ['Documentation error', 'Wrong patient information', 'Coding error', 'Other']}
          value={reason}
          onChange={setReason}
        />
        <Textarea label={kind === 'appends' ? 'Addendum' : 'Correction'} autosize minRows={4} value={text} onChange={(e) => setText(e.currentTarget.value)} required />
        <Text size="xs" c="dimmed">
          Signed by you now, with today's date. The original note stays visible and unchanged.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} disabled={!reason || !text.trim()} onClick={save}>
            Sign {kind === 'appends' ? 'addendum' : 'correction'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

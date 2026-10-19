import { Alert, Anchor, Badge, Button, Center, Grid, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Composition, Condition, DocumentReference, Encounter } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertTriangle, IconCircleCheck, IconClockHour4, IconDeviceFloppy, IconFileCheck, IconFlask, IconMapPin, IconPrescription } from '@tabler/icons-react';
import type { NoteData, SectionKey } from '@teleemon/core';
import { EXT, ICD10CM_SYSTEM, checkLicensure, findDiagnosis, locationConfirmation, locationConfirmationFresh, providerLocationConfirmation, providerLocationConfirmedExtension, readSettings, signProblems, zonedDate } from '@teleemon/core';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useBlocker, useNavigate, useParams } from 'react-router';
import { ErrorState } from '../../components/states';
import { consentStatus, loadConditions } from '../../fhir/clinical';
import { patientAge, patientName, patientPronouns } from '../../fhir/patient';
import type { VisitContext } from '../../fhir/visits';
import { buildComposition, loadVisit, measuresSummary, newNote, noteData, templateForVisit, visitModality, visitState } from '../../fhir/visits';
import { useLoader } from '../../hooks/useLoader';
import { formatTime } from '../../utils/format';
import { DraftSaver } from '../../utils/DraftSaver';
import { BillingPanel } from './BillingPanel';
import classes from './Encounter.module.css';
import { NoteSections } from './NoteSections';
import { SidePanel } from './SidePanel';
import { ScribePanel } from './ScribePanel';
import { PrivateNotesPanel } from './PrivateNotesPanel';
import { PrescribeModal } from '../../prescribing/PrescribeModal';

const AUTOSAVE_MS = 10000;

// P21 Encounter workspace (note editor).
export function EncounterWorkspacePage(): JSX.Element {
  const { encounterId } = useParams();
  const medplum = useMedplum();
  const visit = useLoader(() => loadVisit(medplum, encounterId as string), [encounterId]);
  if (visit.error) return <div style={{ padding: 24 }}><ErrorState error={visit.error} onRetry={visit.reload} /></div>;
  if (!visit.data) return <Center h="60vh"><Loader color="brand" /></Center>;
  if (visit.data.note?.status === 'final') return <Navigate to={`/encounters/${encounterId}/note`} replace />;
  return <Workspace key={visit.data.encounter.id} ctx={visit.data} />;
}

function Workspace({ ctx }: { readonly ctx: VisitContext }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const template = templateForVisit(ctx.encounter);
  const [note, setNote] = useState<NoteData>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | undefined>(ctx.note?.meta?.lastUpdated);
  const [saveError, setSaveError] = useState<string>();
  const [copied, setCopied] = useState<Set<SectionKey>>(new Set());
  const [scribeBusy, setScribeBusy] = useState(false);
  const [scribeApplying, setScribeApplying] = useState(false);
  const [privateDirty, setPrivateDirty] = useState(false);
  const [prescribing, setPrescribing] = useState(false);
  const [scribeTranscript, setScribeTranscript] = useState<DocumentReference>();
  const [providerConfirm, setProviderConfirm] = useState(() => providerLocationConfirmation(ctx.encounter));
  const [confirmingLocation, setConfirmingLocation] = useState(false);
  const persistRef = useRef<(value: NoteData, previous: Composition | undefined) => Promise<Composition>>(undefined);
  const saverRef = useRef<DraftSaver<NoteData, Composition>>(undefined);
  if (!saverRef.current) saverRef.current = new DraftSaver((value, previous) => persistRef.current!(value, previous), ctx.note);
  const saver = saverRef.current;

  // Initial content: the existing draft, or a fresh note from the template.
  useEffect(() => {
    const existing = noteData(ctx.note);
    let active = true;
    const initialize = (value: NoteData): void => {
      if (active) { saver.initialize(value); setNote(value); }
    };
    if (existing) initialize(existing);
    else newNote(medplum, ctx.encounter).then(initialize).catch((err: unknown) => { if (active) setSaveError(normalizeErrorString(err)); });
    return () => { active = false; };
  }, [ctx, medplum, saver]);

  const settings = useLoader(() => readSettings(medplum, 'templates'), [medplum]);
  const problems = useLoader(() => loadConditions(medplum, ctx.patient), [ctx.patient.id]);
  const measures = useLoader(() => measuresSummary(medplum, ctx.patient), [ctx.patient.id]);
  const consents = useLoader(() => medplum.searchResources('Consent', { patient: `Patient/${ctx.patient.id}`, _count: '100' }), [ctx.patient.id]);
  const previous = useLoader(async () => {
    const notes = await medplum.searchResources('Composition', { subject: `Patient/${ctx.patient.id}`, status: 'final', _sort: '-date', _count: '10' });
    return notes.find((n) => !n.relatesTo?.length && n.encounter?.reference !== `Encounter/${ctx.encounter.id}`);
  }, [ctx.patient.id]);

  const change = (next: NoteData): void => {
    saver.change(next);
    setNote(next);
    setDirty(true);
  };

  persistRef.current = async (value, previous) => {
    if (!profile) throw new Error('Sign in before saving this draft.');
    const resource = buildComposition({ ...ctx, note: previous }, value, profile, { measures: measures.data });
    return previous?.id ? medplum.updateResource(resource, { headers: { 'If-Match': `W/"${previous.meta?.versionId}"` } }) : medplum.createResource(resource);
  };
  const save = useCallback(async (): Promise<Composition | undefined> => {
    setSaving(true);
    try {
      const saved = await saver.flush();
      setDirty(saver.dirty);
      setSavedAt(saved?.meta?.lastUpdated);
      setSaveError(undefined);
      return saved;
    } catch (err) {
      setSaveError(normalizeErrorString(err));
      return undefined;
    } finally {
      setSaving(false);
    }
  }, [saver]);

  // Block links, browser history and programmatic navigation until the latest revision saves.
  const blocker = useBlocker(() => saver.dirty || saving || scribeBusy || privateDirty);
  const navigationSave = useRef(false);
  useEffect(() => {
    if (blocker.state !== 'blocked' || navigationSave.current) return;
    if (scribeBusy || privateDirty) {
      notifications.show({ color: 'orange', message: privateDirty ? 'Save the separate private notes before leaving this encounter.' : 'Finish the recording or scribe operation before leaving this encounter.' });
      blocker.reset(); return;
    }
    navigationSave.current = true;
    setLeaving(true);
    void save().then((saved) => {
      if (saved && !saver.dirty) blocker.proceed();
      else blocker.reset();
    }).finally(() => { navigationSave.current = false; setLeaving(false); });
  }, [blocker, save, saver, scribeBusy, privateDirty]);

  // Autosave every 10 seconds while there are changes; warn before leaving with unsaved edits.
  const autosave = useInterval(() => {
    if (dirty) save().catch(() => undefined);
  }, AUTOSAVE_MS);
  useEffect(() => {
    autosave.start();
    return autosave.stop;
  }, [autosave]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent): void => {
      if (saver.dirty || saving || scribeBusy || privateDirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saver, saving, scribeBusy, privateDirty]);

  const addDiagnosis = async (code: string): Promise<Condition | undefined> => {
    const dx = findDiagnosis(code);
    try {
      const c = await medplum.createResource<Condition>({
        resourceType: 'Condition',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
        code: { coding: [{ system: ICD10CM_SYSTEM, code, display: dx?.display }], text: dx?.display },
        subject: createReference(ctx.patient),
        encounter: createReference(ctx.encounter),
        recordedDate: new Date().toISOString(),
        recorder: profile ? createReference(profile) : undefined,
      });
      problems.reload();
      return c;
    } catch (err) {
      notifications.show({ color: 'red', title: 'Diagnosis not added', message: normalizeErrorString(err) });
      return undefined;
    }
  };

  const confirmLocation = async (): Promise<void> => {
    const state = visitState(ctx.encounter);
    if (!profile || !state) return;
    setConfirmingLocation(true);
    try {
      const updated = await medplum.updateResource<Encounter>({
        ...ctx.encounter,
        extension: [
          ...(ctx.encounter.extension ?? []).filter((e) => e.url !== EXT.providerLocationConfirmed),
          providerLocationConfirmedExtension(createReference(profile).reference, state, new Date()),
        ],
      });
      setProviderConfirm(providerLocationConfirmation(updated));
      notifications.show({ color: 'brand', message: `Confirmed the patient is in ${state}.` });
    } catch (err) {
      notifications.show({ color: 'red', title: 'Could not record the confirmation', message: normalizeErrorString(err) });
    } finally {
      setConfirmingLocation(false);
    }
  };

  const goReview = async (): Promise<void> => {
    const saved = await save();
    if (saved) navigate(`/encounters/${ctx.encounter.id}/note`);
  };

  if (!note) return <Center h="60vh"><Loader color="brand" /></Center>;

  const state = visitState(ctx.encounter);
  const licence = ctx.practitioner ? checkLicensure(ctx.practitioner, state, zonedDate(new Date())) : undefined;
  // The patient confirms at check-in; the provider confirms on camera when that is missing or has gone
  // stale (the confirmation only holds for a few hours, since the patient may have moved).
  const patientConfirmation = ctx.appointment ? locationConfirmation(ctx.appointment) : undefined;
  const patientFresh = !!ctx.appointment && locationConfirmationFresh(ctx.appointment, new Date());
  const providerConfirmed = !!providerConfirm?.at;
  const needsLocationCheck = licence?.ok === true && !providerConfirmed && !patientFresh;
  const consentRows = consentStatus(consents.data ?? [], false).filter((c) => ['treatment', 'telehealth', 'recording'].includes(c.code));
  const missingConsents = consentRows.filter((c) => !c.current);
  const open = signProblems(note);
  const highlight = new Set<string>(open.map((p) => p.section).filter(Boolean) as string[]);

  return (
    <div>
      <div className={classes.contextBar}>
        <div className={classes.contextInner}>
          <Group gap="md" wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
            <div>
              <Anchor component={Link} to={`/patients/${ctx.patient.id}`} fw={700} c="inherit">
                {patientName(ctx.patient)}
              </Anchor>
              <Text size="xs" c="dimmed">
                {patientAge(ctx.patient)} y{patientPronouns(ctx.patient) ? ` · ${patientPronouns(ctx.patient)}` : ''} · {template.label} · {visitModality(ctx.encounter) ?? 'video'}
              </Text>
            </div>
            <Tooltip label={licence?.ok ? 'Patient location confirmed; provider licensed there' : licence?.reason}>
              <Badge size="lg" variant="light" color={licence?.ok ? 'green' : 'red'} leftSection={<IconMapPin size={13} />}>
                {state ?? 'Location?'} · {licence?.ok ? 'licensed' : 'not licensed'}
              </Badge>
            </Tooltip>
            {providerConfirmed ? (
              <Tooltip label={`The provider confirmed the patient's location at ${formatTime(providerConfirm?.at)}`}>
                <Badge size="lg" variant="light" color="teal" leftSection={<IconCircleCheck size={13} />}>
                  Location confirmed
                </Badge>
              </Tooltip>
            ) : patientFresh ? (
              <Tooltip label={`The patient confirmed ${patientConfirmation?.state} at ${formatTime(patientConfirmation?.at)}`}>
                <Badge size="lg" variant="light" color="blue" leftSection={<IconMapPin size={13} />}>
                  Patient confirmed
                </Badge>
              </Tooltip>
            ) : null}
            <Tooltip label={missingConsents.length ? `Missing: ${missingConsents.map((c) => c.label).join(', ')}` : 'Treatment, telehealth and recording consents on file'}>
              <Badge size="lg" variant="light" color={missingConsents.length ? 'orange' : 'green'} leftSection={missingConsents.length ? <IconAlertTriangle size={13} /> : <IconCircleCheck size={13} />}>
                Consents {missingConsents.length ? `· ${missingConsents.length} missing` : 'on file'}
              </Badge>
            </Tooltip>
            <Badge size="lg" variant="light" color="gray" leftSection={<IconClockHour4 size={13} />}>
              Started {formatTime(ctx.encounter.period?.start)}
            </Badge>
          </Group>
          <Group gap="xs" wrap="wrap">
            <Text size="xs" c={saveError ? 'red' : 'dimmed'} className="tm-num" aria-live="polite">
              {saveError ? 'Not saved' : leaving ? 'Saving before leaving…' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : savedAt ? `Saved ${formatTime(savedAt)}` : 'Not saved yet'}
            </Text>
            <Button size="xs" variant="default" leftSection={<IconDeviceFloppy size={14} />} onClick={() => save()} disabled={!dirty} loading={saving}>
              Save draft
            </Button>
            <Button size="xs" leftSection={<IconFileCheck size={14} />} onClick={goReview} disabled={scribeBusy || privateDirty}>
              Review & sign {open.length ? <Badge ml={6} size="xs" color="orange" variant="filled">{open.length}</Badge> : null}
            </Button>
          </Group>
        </div>
      </div>

      <div className={classes.body}>
        {needsLocationCheck && (
          <Alert color="orange" mb="md" icon={<IconAlertTriangle size={16} />} title="Confirm the patient's location on camera">
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Text size="sm" style={{ flex: 1, minWidth: 240 }}>
                {patientConfirmation?.at
                  ? `The patient confirmed ${state ?? 'their location'} at ${formatTime(patientConfirmation.at)}, which was a while ago. Ask them on camera to confirm they are still in ${state ?? 'that state'}.`
                  : `This visit has no patient location confirmation. Ask the patient on camera to confirm they are in ${state ?? 'the recorded state'}.`}
              </Text>
              <Button size="xs" loading={confirmingLocation} disabled={!state} onClick={() => void confirmLocation()}>
                I confirmed {state ?? 'the location'}
              </Button>
            </Group>
          </Alert>
        )}
        {saveError && (
          <Alert color="red" mb="md" icon={<IconAlertTriangle size={16} />} title="The draft could not be saved">
            {saveError}
          </Alert>
        )}
        <Grid gutter="lg" align="flex-start">
          <Grid.Col span={{ base: 12, lg: 7 }} order={{ base: 2, lg: 1 }}>
            <fieldset disabled={scribeApplying} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <NoteSections
              template={template}
              note={note}
              onChange={change}
              phrases={settings.data?.phrases ?? []}
              problemList={problems.data ?? []}
              onAddDiagnosis={addDiagnosis}
              previous={noteData(previous.data)}
              copied={copied}
              onCopied={(key, on) => setCopied((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; })}
              measuresText={measures.data}
              highlight={highlight}
            />
            <PrivateNotesPanel patient={ctx.patient} encounter={ctx.encounter} onDirty={setPrivateDirty} />
            </fieldset>
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 5 }} order={{ base: 1, lg: 2 }}>
            <Stack gap="lg" className={classes.stickySide}>
              <ScribePanel ctx={ctx} note={note} save={save} onBusy={setScribeBusy} onApplying={setScribeApplying} onTranscript={setScribeTranscript} onApplied={(composition) => {
                const updated = noteData(composition);
                if (!updated) return;
                saver.adopt(updated, composition); setNote(updated); setDirty(false); setSavedAt(composition.meta?.lastUpdated);
              }} />
              <SidePanel patient={ctx.patient} previous={previous.data} transcript={scribeTranscript} />
              <fieldset disabled={scribeApplying} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <BillingPanel note={note} onChange={change} />
              </fieldset>
              <Group grow>
                <Button variant="default" leftSection={<IconPrescription size={16} />} onClick={() => setPrescribing(true)}>
                  Prescribe
                </Button>
                <Tooltip label="No electronic lab interface is connected: print the requisition and file results when they arrive">
                  <Button variant="default" leftSection={<IconFlask size={16} />} disabled>
                    Order lab
                  </Button>
                </Tooltip>
              </Group>
            </Stack>
          </Grid.Col>
        </Grid>
      </div>
      <PrescribeModal opened={prescribing} onClose={() => setPrescribing(false)} patient={ctx.patient} encounter={ctx.encounter} onDone={() => setPrescribing(false)} />
    </div>
  );
}

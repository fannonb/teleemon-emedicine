import { Alert, Anchor, Badge, Button, Card, Checkbox, Group, Modal, Progress, Select, Stack, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { useMedplum } from '@medplum/react';
import type { Composition, DocumentReference } from '@medplum/fhirtypes';
import { getExtensionValue } from '@medplum/core';
import { IconAlertTriangle, IconMicrophone, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconVideo } from '@tabler/icons-react';
import { EXT, MAX_PENDING_BYTES, fieldLabel, fieldValue, findDiagnosis, validMeetUrl } from '@teleemon/core';
import type { NoteData, ScribeProposal, ScribeSession } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { VisitContext } from '../../fhir/visits';
import { AudioCapture } from '../../scribe/capture';
import { scribeData, scribeRequest } from '../../scribe/api';
import classes from './ScribePanel.module.css';

interface Props { ctx: VisitContext; note: NoteData; save(): Promise<Composition | undefined>; onApplied(note: Composition): void; onBusy(value: boolean): void; onApplying(value: boolean): void; onTranscript(doc: DocumentReference | undefined): void }
const stamp = (seconds: number): string => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
export function ScribePanel({ ctx, note, save, onApplied, onBusy, onApplying, onTranscript }: Props): JSX.Element {
  const medplum = useMedplum();
  const [sessions, setSessions] = useState<DocumentReference[]>([]); const [doc, setDoc] = useState<DocumentReference>();
  const [error, setError] = useState<string>(); const [working, setWorking] = useState(false); const [consent, setConsent] = useState(false);
  const [meetingUrl, setMeetingUrl] = useState((ctx.appointment && getExtensionValue(ctx.appointment, EXT.telehealthUrl) as string) ?? '');
  const [instructions, setInstructions] = useState(''); const [mic, setMic] = useState(0); const [remote, setRemote] = useState(0);
  const [elapsed, setElapsed] = useState(0); const [capturing, setCapturing] = useState(false); const [paused, setPaused] = useState(false);
  const [review, setReview] = useState(false); const [selected, setSelected] = useState<string[]>([]); const [replace, setReplace] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [audioUrl, setAudioUrl] = useState<string>(); const [health, setHealth] = useState<{ processingConfigured: boolean; syntheticOnly: boolean }>();
  const [discard, setDiscard] = useState(false); const [pendingCount, setPendingCount] = useState(0);
  const recorder = useRef<AudioCapture | undefined>(undefined); const pending = useRef<Uint8Array[]>([]); const uploaded = useRef(0); const sessionId = useRef<string | undefined>(undefined); const draining = useRef<Promise<void> | undefined>(undefined); const alive = useRef(true); const localStop = useRef(false);
  const s = doc ? scribeData(doc) : undefined; const office = getExtensionValue(ctx.encounter, EXT.modality) === 'office';
  const update = (next: DocumentReference): void => { if (!alive.current) return; setDoc(next); onTranscript(next); setSessions((all) => [next, ...all.filter((item) => item.id !== next.id)]); };
  const execute = async (run: () => Promise<void>): Promise<void> => { setWorking(true); setError(undefined); try { await run(); } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : 'Scribe operation failed.'); } finally { if (alive.current) setWorking(false); } };
  useEffect(() => {
    alive.current = true;
    void scribeRequest<DocumentReference[]>(medplum, `/encounters/${ctx.encounter.id}/sessions`).then((all) => { if (alive.current) { setSessions(all); setDoc(all[0]); onTranscript(all[0]); } }).catch((err: Error) => { if (alive.current) setError(err.message); });
    void scribeRequest<{ processingConfigured: boolean; syntheticOnly: boolean }>(medplum, '/health').then(setHealth).catch(() => undefined);
    return () => { alive.current = false; recorder.current?.dispose(); };
  }, [medplum, ctx.encounter.id]);
  useEffect(() => { onBusy(capturing || working || pendingCount > 0); }, [capturing, working, pendingCount]);
  useEffect(() => { if (!capturing || paused) return; const timer = setInterval(() => setElapsed((n) => n + 1), 1000); return () => clearInterval(timer); }, [capturing, paused]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const drain = async (): Promise<void> => {
    if (draining.current) return draining.current;
    draining.current = (async () => {
      while (pending.current.length && sessionId.current) {
        const next = await scribeRequest<DocumentReference>(medplum, `/sessions/${sessionId.current}/chunks/${uploaded.current}`, pending.current[0], 'PUT');
        pending.current.shift(); uploaded.current++; setPendingCount(pending.current.length); update(next);
      }
    })().finally(() => { draining.current = undefined; });
    return draining.current;
  };
  const start = async (): Promise<void> => {
    if (!office && !validMeetUrl(meetingUrl)) { setError('Enter the Google Meet link for this appointment.'); return; }
    setWorking(true); setError(undefined); recorder.current = new AudioCapture(); pending.current = []; uploaded.current = 0; localStop.current = false;
    try {
      await recorder.current.prepare(!office, {
        chunk: (bytes) => {
          pending.current.push(bytes); setPendingCount(pending.current.length);
          if (pending.current.reduce((n, b) => n + b.length, 0) > MAX_PENDING_BYTES) { recorder.current?.pause(); setPaused(true); setError('Upload buffer is full. Recording paused. Retry saved audio before resuming.'); }
          void drain().catch((err: Error) => { recorder.current?.pause(); setPaused(true); setError(`${err.message} Recording paused; audio remains in this tab. Retry upload.`); });
        },
        levels: (a, b) => { setMic(a); setRemote(b); },
        interrupted: (reason) => { setPaused(true); setError(reason); if (sessionId.current) void scribeRequest(medplum, `/sessions/${sessionId.current}/state`, { state: 'paused' }).catch(() => undefined); },
      });
      const next = await scribeRequest<DocumentReference>(medplum, `/encounters/${ctx.encounter.id}/sessions`, { consent, instructions, meetingUrl: office ? undefined : meetingUrl });
      sessionId.current = next.id; update(next); await recorder.current.start(); setElapsed(0); setCapturing(true); setPaused(false);
    } catch (err) { recorder.current.dispose(); setError(err instanceof Error ? err.message : 'Unable to start recording.'); }
    finally { setWorking(false); }
  };
  const process = async (id: string): Promise<void> => { if (!(await save())) throw new Error('Save the encounter draft before generating.'); const next = await scribeRequest<DocumentReference>(medplum, `/sessions/${id}/process`, {}); update(next); setSelected([]); setEdits({}); setReview(true); };
  const stop = (): void => { void execute(async () => {
    await recorder.current?.stop(); setCapturing(false); localStop.current = true; await drain();
    const id = sessionId.current ?? doc?.id; if (!id) return;
    const next = await scribeRequest<DocumentReference>(medplum, `/sessions/${id}/state`, { state: 'stopped', expectedChunks: uploaded.current }); update(next); await process(id);
  }); };
  const pause = (): void => { void execute(async () => { if (!sessionId.current) return;
    if (!paused) { recorder.current?.pause(); setPaused(true); await drain(); update(await scribeRequest(medplum, `/sessions/${sessionId.current}/state`, { state: 'paused' })); }
    else { await drain(); update(await scribeRequest(medplum, `/sessions/${sessionId.current}/state`, { state: 'recording' })); await recorder.current?.resume(); setPaused(false); }
  }); };
  const apply = (): void => { onApplying(true); void execute(async () => { try {
    const saved = await save(); if (!saved?.id || !doc) throw new Error('Save the current draft first.');
    const refreshed = await scribeRequest<DocumentReference>(medplum, `/sessions/${doc.id}/refresh`, {}); update(refreshed);
    const result = await scribeRequest<Composition>(medplum, `/sessions/${doc.id}/apply`, { fields: selected, replace, noteId: saved.id, version: saved.meta?.versionId, edits: Object.fromEntries(Object.entries(edits).filter(([field]) => selected.includes(field))) });
    onApplied(result); setSelected([]); setReplace(false); update(await scribeRequest(medplum, `/sessions/${doc.id}`));
  } finally { onApplying(false); } }); };
  const play = (): void => { void execute(async () => { const response = await fetch(`/api/scribe/sessions/${doc?.id}/audio`, { headers: { Authorization: `Bearer ${medplum.getAccessToken()}` } }); if (!response.ok) throw new Error('Unable to load recording.'); setAudioUrl(URL.createObjectURL(await response.blob())); }); };
  const recovered = !capturing && s && ['recording', 'paused'].includes(s.state);
  return <>
    <Card>
      <Stack gap="md">
        <div className={classes.header}><div><Group gap="xs"><IconMicrophone size={18} /><Text fw={650}>AI scribe</Text></Group><Text size="sm" c="dimmed" mt={4}>Record this visit. Review the draft afterward.</Text></div><Badge color={capturing ? 'red' : s?.state === 'ready' ? 'brand' : 'gray'}>{capturing ? paused ? 'Paused' : 'Recording' : working ? 'Working…' : s?.state ?? 'Ready to record'}</Badge></div>
        {health?.syntheticOnly && <Text size="xs" c="dimmed">Synthetic patients only · after-visit processing</Text>}
        {health && !health.processingConfigured && <Alert color="orange" title="OpenAI setup needed">Audio can be saved. Generation becomes available when the server API key is configured.</Alert>}
        {error && <Alert color="orange" icon={<IconAlertTriangle size={16} />} title="Scribe needs attention" role="alert">{error}</Alert>}
        {s?.error && !error && <Alert color="orange">{s.error}</Alert>}
        {!capturing && !working && <>
          {!office && <TextInput label="Google Meet link" placeholder="https://meet.google.com/abc-defg-hij" value={meetingUrl} onChange={(e) => setMeetingUrl(e.currentTarget.value)} rightSection={<IconVideo size={16} />} />}
          {!office && validMeetUrl(meetingUrl) && <Anchor href={meetingUrl} target="_blank" rel="noreferrer noopener" size="sm">Open Google Meet</Anchor>}
          <Textarea label="Note instructions" description="Style and emphasis for the selected encounter template. The transcript stays faithful to the conversation." placeholder="e.g. Keep the interval history concise; use bullets for the plan." value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} maxLength={4000} autosize minRows={2} maxRows={5} />
          <Checkbox label="The patient agreed verbally to recording and AI-assisted documentation for this session." checked={consent} onChange={(e) => setConsent(e.currentTarget.checked)} />
          <Text size="xs" c="dimmed">{office ? 'Uses your microphone.' : 'Choose the Meet browser tab and enable Share tab audio. Keep this encounter tab open; headphones are supported.'} Nothing is transcribed during recording.</Text>
        </>}
        {capturing && <><Text className={classes.clock} aria-live="off">{stamp(elapsed)}</Text><div className={classes.meter}><Text size="xs" mb={5}>Your microphone</Text><Progress value={mic} aria-label="Microphone audio level" />{!office && <><Text size="xs" mt="sm" mb={5}>Google Meet audio</Text><Progress value={remote} aria-label="Google Meet audio level" /></>}</div><Text size="xs" c="dimmed" aria-live="polite">{pendingCount ? `${pendingCount} audio chunks waiting to upload` : 'Captured audio uploaded'} · transcript available after stopping</Text></>}
        <div className={classes.controls}>
          {!capturing && !recovered && <Button leftSection={<IconMicrophone size={16} />} disabled={!consent || !AudioCapture.supported() || pendingCount > 0} loading={working} onClick={() => void start()}>Start recording</Button>}
          {capturing && <><Button variant="default" disabled={working} onClick={pause} leftSection={paused ? <IconPlayerPlay size={15} /> : <IconPlayerPause size={15} />}>{paused ? 'Resume' : 'Pause'}</Button><Button onClick={stop} loading={working} leftSection={<IconPlayerStop size={15} />}>Stop and generate draft</Button></>}
          {pendingCount > 0 && <Button variant="default" disabled={working} onClick={() => void execute(async () => { await drain(); if (localStop.current) { update(await scribeRequest(medplum, `/sessions/${sessionId.current}/state`, { state: 'stopped', expectedChunks: uploaded.current })); await process(sessionId.current!); } })}>Retry upload</Button>}
          {recovered && <Button variant="default" loading={working} onClick={() => void execute(async () => { update(await scribeRequest(medplum, `/sessions/${doc!.id}/state`, { state: 'stopped', expectedChunks: s.chunks.length })); await process(doc!.id!); })}>Finish saved recording</Button>}
          {s && ['stopped', 'failed', 'transcribing', 'drafting'].includes(s.state) && !capturing && <Button variant="default" loading={working} onClick={() => void execute(() => process(doc!.id!))}>Generate / retry draft</Button>}
          {s?.result && <Button variant="light" onClick={() => setReview(true)}>Review findings{ s.applied.length ? ` · ${s.applied.length} applied` : ''}</Button>}
          {s && s.state !== 'cancelled' && <Button variant="subtle" color="gray" onClick={() => setDiscard(true)}>Withdraw recording consent</Button>}
        </div>
        {recovered && <Text size="xs" c="orange">This recording was interrupted. Only acknowledged audio is available; review it for gaps before using the findings.</Text>}
        {sessions.length > 1 && !capturing && <Select label="Earlier recordings" value={doc?.id} data={sessions.map((d) => ({ value: d.id!, label: `${new Date(d.date!).toLocaleString()} · ${scribeData(d).state}` }))} onChange={(id) => { const next = sessions.find((d) => d.id === id); setDoc(next); onTranscript(next); setAudioUrl(undefined); setEdits({}); setSelected([]); }} disabled={working} />}
        {s?.chunks.length ? <Button variant="subtle" size="xs" onClick={play} disabled={working || capturing || s.state === 'cancelled' || !!s.audioDeletedAt}>Load recorded audio</Button> : null}
        {s && s.usage.transcriptionRequests.length > 0 && <Text size="xs" c="dimmed">Transcribed audio: {(s.usage.audioSeconds / 60).toFixed(1)} min · Draft tokens: {s.usage.inputTokens.toLocaleString()} in / {s.usage.outputTokens.toLocaleString()} out</Text>}
        {audioUrl && <audio controls src={audioUrl} style={{ width: '100%' }} aria-label="Encounter recording" />}
      </Stack>
    </Card>
    <Modal opened={discard} onClose={() => setDiscard(false)} title="Withdraw recording consent?" centered><Stack><Text size="sm">Capture stops and this session cannot be processed or applied. Existing medical documentation remains unchanged. Audio deletion follows the retention and legal-hold policy.</Text><Button color="red" onClick={() => { setDiscard(false); void execute(async () => { await recorder.current?.stop(); setCapturing(false); pending.current = []; setPendingCount(0); await scribeRequest(medplum, `/sessions/${doc?.id}/withdraw`, {}); update(await scribeRequest(medplum, `/sessions/${doc?.id}`)); }); }}>Stop and withdraw consent</Button></Stack></Modal>
    <Modal opened={review} onClose={() => setReview(false)} title="Review scribe findings" size="xl"><Stack>
      <Text size="sm" c="dimmed">Select the fields you want to apply. Existing text is preserved unless you explicitly allow replacement. Diagnoses and clinical decisions remain yours.</Text>
      <Tabs defaultValue="findings"><Tabs.List><Tabs.Tab value="findings">Findings</Tabs.Tab><Tabs.Tab value="transcript">Transcript evidence</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="findings" pt="md">
          {s?.result?.warnings.map((warning, i) => <Alert color="orange" key={i} mb="xs">{warning}</Alert>)}
          {s?.result?.proposals.map((p: ScribeProposal) => <div className={classes.proposal} key={p.field}>
            <Checkbox label={fieldLabel(p.field)} checked={selected.includes(p.field)} onChange={(e) => setSelected((old) => e.currentTarget.checked ? [...old, p.field] : old.filter((f) => f !== p.field))} />
            {['risk.suicidalIdeation', 'risk.homicidalIdeation', 'risk.selfHarm'].includes(p.field)
              ? <Select mt="xs" label="Reviewed value" value={edits[p.field] ?? p.value} data={p.field === 'risk.suicidalIdeation' ? ['denied', 'passive', 'active-no-plan', 'active-plan'] : p.field === 'risk.homicidalIdeation' ? ['denied', 'present'] : ['none', 'recent']} onChange={(value) => { if (value) setEdits((old) => ({ ...old, [p.field]: value })); }} />
              : <Textarea mt="xs" label="Reviewed text" value={edits[p.field] ?? p.value} autosize minRows={2} maxRows={10} onChange={(e) => { const value = e.currentTarget.value; setEdits((old) => ({ ...old, [p.field]: value })); }} />}
            {fieldValue(note, p.field) && <Text size="xs" mt="xs" c="orange">Current field contains text: {fieldValue(note, p.field)}</Text>}
            {p.caution && <Text size="xs" c="orange" mt={5}>{p.caution}</Text>}
            <Group gap="xs" mt="xs">{p.evidence.map((id) => { const t = s.transcript.find((item) => item.id === id); return <Anchor key={id} size="xs" href={`#scribe-${id}`} onClick={() => { const element = document.getElementById(`scribe-${id}`); element?.scrollIntoView(); }}>Evidence {t ? `${stamp(t.start)}–${stamp(t.end)}` : id}</Anchor>; })}</Group>
            {p.evidence.map((id) => <Text key={id} size="xs" c="dimmed" mt={5}>{s.transcript.find((t) => t.id === id)?.text}</Text>)}
          </div>)}
          {!s?.result?.proposals.length && <Text size="sm">No supported field proposals were generated. Review the transcript and document manually.</Text>}
          {s?.result?.diagnosisSuggestions.map((d) => <Alert key={d.code} color="blue" mt="sm" title={`Consider ${d.code} · ${findDiagnosis(d.code)?.display ?? ''}`}>{d.reason} Add diagnoses manually after review.</Alert>)}
        </Tabs.Panel>
        <Tabs.Panel value="transcript" pt="md"><TranscriptContent session={s} /></Tabs.Panel>
      </Tabs>
      {error && <Alert color="orange">{error}</Alert>}
      <Checkbox label="Allow replacement of existing text in the selected fields after my review" checked={replace} onChange={(e) => setReplace(e.currentTarget.checked)} />
      <Group justify="space-between"><Button variant="default" onClick={() => { setSelected(s?.result?.proposals.filter((p) => !fieldValue(note, p.field).trim()).map((p) => p.field) ?? []); setReplace(false); }}>Select empty fields</Button><Button disabled={!selected.length} loading={working} onClick={apply}>Apply {selected.length || ''} reviewed fields</Button></Group>
    </Stack></Modal>
  </>;
}
export function TranscriptContent({ session }: { session?: ScribeSession }): JSX.Element {
  return <Stack gap="sm">{session?.transcript.length ? <><Text size="xs" c="dimmed">Finalized audio blocks · timing is approximate; speakers are unassigned in this release.</Text>{session.transcript.map((t) => <div className={classes.transcript} id={`scribe-${t.id}`} key={t.id}><Text size="xs" c="dimmed" mb={6}>{stamp(t.start)}–{stamp(t.end)} · Speaker unknown</Text><Text size="sm">{t.text || 'No speech detected in this block.'}</Text></div>)}</> : <Text size="sm" c="dimmed">The transcript appears after recording stops and processing completes.</Text>}</Stack>;
}

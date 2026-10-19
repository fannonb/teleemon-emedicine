import { Alert, Button, Card, Group, Stack, Text, Textarea } from '@mantine/core';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { createReference, getExtensionValue } from '@medplum/core';
import type { DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import { CODE_SYSTEMS, EXT } from '@teleemon/core';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

/** Separate resource and author-restricted AccessPolicy; never put this text in Composition. */
export function PrivateNotesPanel({ patient, encounter, onDirty }: { patient: Patient; encounter: Encounter; onDirty(value: boolean): void }): JSX.Element {
  const medplum = useMedplum(); const profile = useMedplumProfile();
  const [doc, setDoc] = useState<DocumentReference>(); const [text, setText] = useState(''); const [loaded, setLoaded] = useState(false); const [dirty, setDirty] = useState(false); const [working, setWorking] = useState(false); const [error, setError] = useState<string>();
  useEffect(() => { onDirty(dirty || working); }, [dirty, working, onDirty]);
  useEffect(() => { let active = true;
    void medplum.searchOne('DocumentReference', { encounter: `Encounter/${encounter.id}`, category: `${CODE_SYSTEMS.documentCategory}|private-psychotherapy`, author: `${profile?.resourceType}/${profile?.id}` }, { cache: 'no-cache' }).then((record) => { if (active) { setDoc(record); setText(record ? getExtensionValue(record, EXT.privatePsychotherapy) as string ?? '' : ''); setLoaded(true); } }).catch(() => { if (active) setError('Private notes could not be loaded. Check that the Phase 4 access policies are applied.'); });
    return () => { active = false; };
  }, [medplum, encounter.id, profile?.id]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  const save = async (): Promise<void> => { if (!profile) return; setWorking(true); setError(undefined); try {
    const value: DocumentReference = { ...doc, resourceType: 'DocumentReference', status: 'current', docStatus: 'preliminary', subject: createReference(patient), author: [createReference(profile)], context: { encounter: [createReference(encounter)] }, category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'private-psychotherapy' }] }], date: doc?.date ?? new Date().toISOString(), description: 'Private psychotherapy notes', extension: [{ url: EXT.privatePsychotherapy, valueString: text }], content: [{ attachment: { contentType: 'text/plain', title: 'Author-restricted psychotherapy notes' } }] };
    const saved = doc ? await medplum.updateResource(value, { headers: { 'If-Match': `W/"${doc.meta?.versionId}"` } }) : await medplum.createResource(value); setDoc(saved); setDirty(false);
  } catch { setError('Private notes were not saved. Reload if another editor changed them.'); } finally { setWorking(false); } };
  return <Card mt="lg" padding="md"><Stack gap="xs"><Group justify="space-between"><Text size="sm" fw={650}>Private psychotherapy notes</Text><Text size="xs" c="dimmed">Separate record · author access</Text></Group><Text size="xs" c="dimmed">Saved separately from the clinical note. Excluded from the scribe, clinical exports and patient release. Save before leaving this encounter.</Text>{error && <Alert color="orange">{error}</Alert>}<Textarea aria-label="Separate private psychotherapy notes" value={text} onChange={(e) => { setText(e.currentTarget.value); setDirty(true); }} disabled={!loaded || working} autosize minRows={2} /><Button variant="default" size="xs" onClick={() => void save()} disabled={!dirty || !loaded} loading={working}>Save private notes</Button>{dirty && <Text size="xs" c="orange">Private notes have unsaved changes.</Text>}</Stack></Card>;
}

import { Alert, Anchor, Badge, Button, Card, Group, List, Stack, Text, ThemeIcon } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconCircleCheck, IconCircleDashed, IconUserCheck } from '@tabler/icons-react';
import { CODE_SYSTEMS, ONBOARDING_REVIEW, isControlledStatement, onboardingProblems, onboardingStatus, registrationGaps } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useLoader } from '../../hooks/useLoader';

const LINKS: Record<string, string> = { insurance: 'insurance', card: 'insurance', 'emergency-contact': 'demographics', 'sex-at-birth': 'demographics', phone: 'demographics', email: 'demographics', 'home-state': 'demographics' };

/**
 * New patient onboarding (docs/PATIENT-ONBOARDING-PLAN.md, stages 9–10): what is still missing,
 * and "Mark verified" once the patient's submitted forms have been checked. The task-rules Bot
 * refuses verification while anything required is missing, whatever this card shows.
 */
export function OnboardingCard({ patient }: { readonly patient: Patient }): JSX.Element | null {
  const medplum = useMedplum();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const ref = `Patient/${patient.id}`;
  const data = useLoader(async () => {
    const [reviews, coverages, consents, meds] = await Promise.all([
      medplum.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|${ONBOARDING_REVIEW}`, patient: ref, _count: '10' }, { cache: 'no-cache' }),
      medplum.searchResources('Coverage', { beneficiary: ref, _count: '50' }, { cache: 'no-cache' }),
      medplum.searchResources('Consent', { patient: ref, _count: '200' }, { cache: 'no-cache' }),
      medplum.searchResources('MedicationStatement', { subject: ref, status: 'active', _count: '100' }, { cache: 'no-cache' }).catch(() => []),
    ]);
    return { reviews, missing: onboardingProblems({ patient, coverages, consents, onControlled: meds.some(isControlledStatement) }) };
  }, [patient.id, patient.meta?.versionId]);

  const gaps = registrationGaps(patient);
  if (!data.data) return gaps.length ? <GapsOnly gaps={gaps.map((g) => g.label)} /> : null;
  const { reviews, missing } = data.data;
  const status = onboardingStatus(reviews);
  const open = reviews.find((t) => !['completed', 'cancelled', 'rejected', 'entered-in-error'].includes(t.status));
  if (status !== 'to-verify') return gaps.length ? <GapsOnly gaps={gaps.map((g) => g.label)} verified={status === 'verified'} /> : null;

  const verify = async (task: Task): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await medplum.updateResource<Task>({ ...task, status: 'completed', lastModified: new Date().toISOString() }, { headers: { 'If-Match': `W/"${task.meta?.versionId}"` } });
      notifications.show({ color: 'brand', message: 'New patient verified.' });
      data.reload();
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap={6}><IconUserCheck size={18} /><Text fw={650} size="lg">New patient onboarding</Text></Group>
          <Badge color="orange">Forms to verify</Badge>
        </Group>
        <Text size="sm" c="dimmed">The patient submitted their new-patient forms in the portal. Check identity, insurance and card photos, then mark verified.</Text>
        {missing.length === 0 ? (
          <Group gap={6}><IconCircleCheck size={16} color="var(--mantine-color-green-7)" /><Text size="sm">Everything required is on file.</Text></Group>
        ) : (
          <List spacing={4} size="sm" icon={<ThemeIcon size={18} radius="xl" color="orange" variant="light"><IconCircleDashed size={12} /></ThemeIcon>}>
            {missing.map((m) => (
              <List.Item key={m.key}>
                {LINKS[m.key] ? <Anchor component={Link} to={`/patients/${patient.id}/${LINKS[m.key]}`} size="sm">{m.label}</Anchor> : m.key.startsWith('consent-') ? <Anchor component={Link} to={`/patients/${patient.id}/consents`} size="sm">{m.label}</Anchor> : m.label}
              </List.Item>
            ))}
          </List>
        )}
        {error && <Alert color="red" variant="light">{error}</Alert>}
        {open && <Button size="xs" leftSection={<IconUserCheck size={14} />} disabled={missing.length > 0} loading={saving} onClick={() => void verify(open)} style={{ alignSelf: 'flex-start' }}>Mark verified</Button>}
      </Stack>
    </Card>
  );
}

function GapsOnly({ gaps, verified }: { readonly gaps: string[]; readonly verified?: boolean }): JSX.Element {
  return (
    <Alert color="orange" variant="light" title="Registration incomplete">
      <Text size="sm">Missing: {gaps.join(', ')}. Add them in the form on this page{verified ? ' (the patient was verified before these became required)' : ''}.</Text>
    </Alert>
  );
}

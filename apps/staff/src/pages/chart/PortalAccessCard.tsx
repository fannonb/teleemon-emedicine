import { Alert, Badge, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { createReference, getReferenceString, normalizeErrorString } from '@medplum/core';
import type { Basic, Patient, RelatedPerson, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconDeviceMobile, IconSend } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT, MINOR_RULES_STATUS, patientInviteProblem, proxyLevel } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { Section } from '../../components/Section';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';

type Person = Patient | RelatedPerson;

const emailOf = (p: Person): string | undefined => p.telecom?.find((t) => t.system === 'email' && t.value)?.value;
const nameOf = (p: Person): string => [p.name?.[0]?.given?.[0], p.name?.[0]?.family].filter(Boolean).join(' ');
const ext = (b: Basic, url: string): string | undefined => b.extension?.find((e) => e.url === url)?.valueDateTime;

interface Status { readonly label: string; readonly color: string; readonly detail?: string }

/** From the newest invitation and request: staff cannot read sign-in memberships, so invitations are the record. */
function accessStatus(invitations: Basic[], tasks: Task[]): Status {
  const pending = tasks.find((t) => t.status === 'requested' || t.status === 'in-progress');
  if (pending) return { label: 'Sending invitation', color: 'blue' };
  const used = invitations.find((b) => ext(b, EXT.inviteUsed));
  if (used) return { label: 'Portal active', color: 'green', detail: `Set up ${formatDate(ext(used, EXT.inviteUsed)?.slice(0, 10))}` };
  const latest = invitations[0];
  const failed = tasks.find((t) => t.status === 'failed');
  if (failed && (!latest || (failed.lastModified ?? '') > (latest.meta?.lastUpdated ?? ''))) return { label: 'Invitation not sent', color: 'red', detail: failed.statusReason?.text };
  if (latest && Date.parse(ext(latest, EXT.inviteExpires) ?? '') > Date.now()) return { label: 'Invited', color: 'blue', detail: `Link expires ${formatDate(ext(latest, EXT.inviteExpires)?.slice(0, 10))}` };
  if (latest) return { label: 'Link expired', color: 'orange', detail: 'Send a new link' };
  return { label: 'Not invited', color: 'gray' };
}

// X09 / P10: who can use the portal for this patient, and invitations for the patient and proxies.
export function PortalAccessCard({ patient, related }: { readonly patient: Patient; readonly related: RelatedPerson[] }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [sending, setSending] = useState<string>();
  const people: Person[] = [patient, ...related.filter((r) => r.active !== false)];
  const data = useLoader(async () => {
    const refs = people.map((p) => getReferenceString(p)).join(',');
    const [invitations, tasks] = await Promise.all([
      medplum.searchResources('Basic', { code: `${CODE_SYSTEMS.portal}|invitation`, subject: refs, _sort: '-_lastUpdated', _count: '100' }, { cache: 'no-cache' }),
      medplum.searchResources('Task', { code: `${CODE_SYSTEMS.taskCode}|portal-invite`, focus: refs, _sort: '-_lastUpdated', _count: '100' }, { cache: 'no-cache' }),
    ]);
    return { invitations, tasks };
  }, [patient.id, related.map((r) => r.id).join()], 15000);
  const level = proxyLevel(patient);

  const invite = async (p: Person): Promise<void> => {
    setSending(getReferenceString(p));
    try {
      await medplum.createResource<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        code: { coding: [{ system: CODE_SYSTEMS.taskCode, code: 'portal-invite' }], text: 'Portal invitation' },
        description: `Portal invitation for ${nameOf(p)}`,
        for: createReference(patient),
        focus: createReference(p),
        requester: profile ? (createReference(profile) as Task['requester']) : undefined,
        authoredOn: new Date().toISOString(),
      });
      notifications.show({ color: 'brand', message: `Invitation for ${nameOf(p)} queued. The portal service emails a single-use link within a minute.` });
      data.reload();
    } catch (err) {
      notifications.show({ color: 'red', title: 'Not sent', message: normalizeErrorString(err) });
    } finally {
      setSending(undefined);
    }
  };

  return (
    <Section title={<Group gap={6}><IconDeviceMobile size={18} /><Text fw={650} size="lg">Patient portal</Text></Group>} loaded={data}>
      {({ invitations, tasks }) => (
        <Stack gap="md">
          {people.map((p) => {
            const ref = getReferenceString(p);
            const status = accessStatus(invitations.filter((b) => b.subject?.reference === ref), tasks.filter((t) => t.focus?.reference === ref));
            const email = emailOf(p);
            const isProxy = p.resourceType === 'RelatedPerson';
            // Minors use a guardian's proxy access until the teen sign-in age is decided (the server refuses it too).
            const blockedReason = isProxy ? (level.level === 'none' ? level.reason : undefined) : patientInviteProblem(p as Patient);
            const blocked = !!blockedReason;
            return (
              <Stack key={ref} gap={4}>
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text size="sm" fw={600}>{nameOf(p)} {isProxy && <Text span size="xs" c="dimmed">proxy</Text>}</Text>
                    <Text size="xs" c="dimmed">{email ?? 'No email on file'}{status.detail ? ` · ${status.detail}` : ''}</Text>
                  </div>
                  <Badge color={status.color}>{status.label}</Badge>
                </Group>
                {isProxy && !blocked && <Text size="xs" c={level.level === 'limited' ? 'orange.8' : 'dimmed'}>{level.level === 'full' ? 'Full access' : 'Limited access: scheduling and insurance only'}. {level.reason}</Text>}
                {status.label !== 'Portal active' && (
                  <Tooltip label={blockedReason ?? 'Add an email address first'} disabled={!!email && !blocked} multiline w={280}>
                    <Button size="xs" variant="light" leftSection={<IconSend size={14} />} disabled={!email || blocked} loading={sending === ref} onClick={() => void invite(p)} style={{ alignSelf: 'flex-start' }}>
                      {status.label === 'Not invited' ? 'Send invitation' : 'Send a new link'}
                    </Button>
                  </Tooltip>
                )}
              </Stack>
            );
          })}
          {related.length > 0 && level.level !== 'none' && <Alert color="gray" variant="light" p="xs"><Text size="xs">{MINOR_RULES_STATUS}</Text></Alert>}
        </Stack>
      )}
    </Section>
  );
}

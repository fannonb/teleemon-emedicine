import { Badge, Card, Group, ScrollArea, Stack, Tabs, Text } from '@mantine/core';
import type { Composition, DocumentReference, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { SCHEDULE_LABEL, renderNote } from '@teleemon/core';
import type { JSX } from 'react';
import { Sparkline } from '../../components/charts';
import { RoleRestricted } from '../../components/Section';
import { loadConditions, loadMeds, loadScores, medName, medSchedule } from '../../fhir/clinical';
import { isForbidden } from '../../fhir/patient';
import { noteData } from '../../fhir/visits';
import { useLoader } from '../../hooks/useLoader';
import { formatDate } from '../../utils/format';
import { scribeData } from '../../scribe/api';
import { TranscriptContent } from './ScribePanel';

/** Right-hand reference panel of the workspace: chart, measures, last note, transcript (Phase 4). */
export function SidePanel({ patient, previous, transcript }: { readonly patient: Patient; readonly previous?: Composition; readonly transcript?: DocumentReference }): JSX.Element {
  const medplum = useMedplum();
  const meds = useLoader(() => loadMeds(medplum, patient), [patient.id]);
  const problems = useLoader(() => loadConditions(medplum, patient), [patient.id]);
  const allergies = useLoader(() => medplum.searchResources('AllergyIntolerance', { patient: `Patient/${patient.id}`, 'clinical-status': 'active' }), [patient.id]);
  const scores = useLoader(() => loadScores(medplum, patient), [patient.id]);
  const prev = noteData(previous);

  return (
    <Card padding="sm">
      <Tabs defaultValue="chart" variant="pills" radius="md">
        <Tabs.List grow mb="sm">
          <Tabs.Tab value="chart">Chart</Tabs.Tab>
          <Tabs.Tab value="measures">Measures</Tabs.Tab>
          <Tabs.Tab value="prior">Last note</Tabs.Tab>
          <Tabs.Tab value="transcript">Transcript</Tabs.Tab>
        </Tabs.List>
        <ScrollArea.Autosize mah={420} type="auto" offsetScrollbars>
          <Tabs.Panel value="chart">
            <Stack gap="sm" px={4}>
              <div>
                <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
                  Allergies
                </Text>
                <Text size="sm" c={allergies.data?.some((a) => !a.code?.coding?.some((c) => c.code === '716186003')) ? 'red.7' : undefined} fw={500}>
                  {allergies.data?.length ? allergies.data.map((a) => a.code?.text).join(', ') : 'Not recorded'}
                </Text>
              </div>
              <div>
                <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
                  Active medications
                </Text>
                {meds.error && isForbidden(meds.error) ? (
                  <RoleRestricted what="Medications" />
                ) : (
                  (meds.data ?? []).map((m) => (
                    <Group key={m.id} gap={6} wrap="nowrap" mb={2}>
                      {medSchedule(m) && (
                        <Badge size="xs" color="red" variant="light">
                          {SCHEDULE_LABEL[medSchedule(m) as keyof typeof SCHEDULE_LABEL]}
                        </Badge>
                      )}
                      <Text size="sm">
                        {medName(m)} <Text span size="xs" c="dimmed">{m.dosage?.[0]?.text}</Text>
                      </Text>
                    </Group>
                  ))
                )}
              </div>
              <div>
                <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
                  Problem list
                </Text>
                {(problems.data ?? []).map((c) => (
                  <Text key={c.id} size="sm">
                    <Text span className="tm-num" c="dimmed" size="xs">
                      {c.code?.coding?.[0]?.code}
                    </Text>{' '}
                    {c.code?.text}
                  </Text>
                ))}
              </div>
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="measures">
            <Stack gap="xs" px={4}>
              {(scores.data ?? []).length === 0 && (
                <Text size="sm" c="dimmed">
                  No scores on file.
                </Text>
              )}
              {(scores.data ?? []).map((s) => {
                const last = s.points[s.points.length - 1];
                return (
                  <Group key={s.def.key} justify="space-between" wrap="nowrap">
                    <div>
                      <Text size="sm" fw={600}>
                        {s.def.shortTitle} {last.value}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {last.observation.interpretation?.[0]?.text} · {formatDate(last.date.slice(0, 10))}
                      </Text>
                    </div>
                    <Sparkline points={s.points} max={s.def.maxScore} />
                  </Group>
                );
              })}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="prior">
            {prev ? (
              <Stack gap="xs" px={4}>
                <Text size="xs" c="dimmed">
                  {previous?.title}
                </Text>
                {renderNote(prev).map((s) => (
                  <div key={s.key}>
                    <Text size="xs" fw={650} c="dimmed" tt="uppercase">
                      {s.title}
                    </Text>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                      {s.text}
                    </Text>
                  </div>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed" px={4}>
                No earlier signed note in this system. Notes from the previous system are not migrated yet; only demographics and past appointments are.
              </Text>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="transcript">
            <TranscriptContent session={transcript ? scribeData(transcript) : undefined} />
          </Tabs.Panel>
        </ScrollArea.Autosize>
      </Tabs>
    </Card>
  );
}


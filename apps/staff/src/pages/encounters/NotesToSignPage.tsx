import { Badge, Button, Card, Table, Text } from '@mantine/core';
import { getReferenceString } from '@medplum/core';
import type { Composition, Encounter, Patient, Resource } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { IconRosetteDiscountCheck } from '@tabler/icons-react';
import { isLateEntry, signProblems } from '@teleemon/core';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { patientName } from '../../fhir/patient';
import { noteData } from '../../fhir/visits';
import { useLoader } from '../../hooks/useLoader';
import { formatAge, formatDate } from '../../utils/format';

// P23 Notes to sign: every draft note, oldest first, with what still blocks signing.
export function NotesToSignPage(): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const drafts = useLoader(async () => {
    const bundle = await medplum.search(
      'Composition',
      new URLSearchParams([
        ['status', 'preliminary'],
        ['_sort', '_lastUpdated'],
        ['_count', '200'],
        ['_include', 'Composition:subject'],
        ['_include', 'Composition:encounter'],
      ]),
      { cache: 'no-cache' }
    );
    const byRef = new Map<string, Resource>();
    const notes: Composition[] = [];
    for (const e of bundle.entry ?? []) {
      const r = e.resource as Resource | undefined;
      if (!r) continue;
      if (r.resourceType === 'Composition') notes.push(r);
      else byRef.set(`${r.resourceType}/${r.id}`, r);
    }
    return notes
      .filter((n) => !n.relatesTo?.length)
      .map((n) => ({ note: n, patient: byRef.get(n.subject?.reference ?? '') as Patient | undefined, encounter: byRef.get(n.encounter?.reference ?? '') as Encounter | undefined }))
      .sort((a, b) => (a.encounter?.period?.start ?? '').localeCompare(b.encounter?.period?.start ?? ''));
  }, [medplum], 60000);
  const mine = profile ? getReferenceString(profile) : undefined;

  return (
    <PageBody>
      <PageHeader eyebrow="P23 · Clinical work" title="Notes to sign" subtitle="Goal: zero unsigned notes at the end of each day. Notes signed more than 72 hours after the visit are marked as late entries." />
      <Section
        loaded={drafts}
        isEmpty={(l) => l.length === 0}
        empty={{ icon: <IconRosetteDiscountCheck size={22} />, title: 'All notes are signed', text: 'Draft notes appear here until they are signed.' }}
        padding="md"
      >
        {(list) => (
          <Card padding={0} withBorder={false}>
            <Table.ScrollContainer minWidth={720}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Visit</Table.Th>
                    <Table.Th>Patient</Table.Th>
                    <Table.Th>Note</Table.Th>
                    <Table.Th>Still to do</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.map(({ note, patient, encounter }) => {
                    const data = noteData(note);
                    const problems = data ? signProblems(data) : [];
                    const late = isLateEntry(encounter?.period?.start, new Date().toISOString());
                    const isMine = encounter?.participant?.some((p) => p.individual?.reference === mine);
                    return (
                      <Table.Tr key={note.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/encounters/${encounter?.id}`)}>
                        <Table.Td className="tm-num">
                          <Text size="sm" fw={600}>
                            {formatDate(encounter?.period?.start?.slice(0, 10))}
                          </Text>
                          <Text size="xs" c={late ? 'red' : 'dimmed'}>
                            {formatAge(encounter?.period?.start)} ago{late ? ' · late' : ''}
                          </Text>
                        </Table.Td>
                        <Table.Td fw={600}>{patientName(patient)}</Table.Td>
                        <Table.Td>
                          <Text size="sm">{note.type?.text}</Text>
                          {!isMine && (
                            <Text size="xs" c="dimmed">
                              Another provider's visit
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {problems.length ? (
                            <Badge color="orange" variant="light">
                              {problems.length} item{problems.length > 1 ? 's' : ''}
                            </Badge>
                          ) : (
                            <Badge color="green" variant="light">
                              Ready to sign
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td ta="right">
                          <Button size="xs" variant={problems.length ? 'default' : 'filled'} onClick={(e) => { e.stopPropagation(); navigate(problems.length ? `/encounters/${encounter?.id}` : `/encounters/${encounter?.id}/note`); }}>
                            {problems.length ? 'Continue' : 'Review & sign'}
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>
        )}
      </Section>
    </PageBody>
  );
}

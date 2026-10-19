import { Anchor, Badge, Button, Card, Group, Pagination, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { Appointment, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconSearch, IconUserPlus, IconUsers } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PageBody, PageHeader } from '../../components/PageHeader';
import { PatientFlags } from '../../components/PatientBadges';
import { EmptyState, ErrorState, RowsSkeleton } from '../../components/states';
import { patientAge, patientMrn, patientName, telecom } from '../../fhir/patient';
import { classifyQuery, nextAppointments, patientPage, possibleDuplicates } from '../../fhir/patientSearch';
import { useLoader } from '../../hooks/useLoader';
import { formatDate, formatTime } from '../../utils/format';

const KIND_HINT: Record<string, string> = {
  name: 'Searching by name',
  dob: 'Searching by date of birth',
  phone: 'Searching by phone',
  email: 'Searching by email',
  mrn: 'Searching by chart number',
  member: 'Searching by insurance member ID',
};

interface Results {
  readonly patients: Patient[];
  readonly next: Map<string, Appointment>;
  readonly duplicates: Set<string>;
  readonly total: number;
  readonly query: string;
  readonly page: number;
}

// P07 Find patient.
export function PatientSearchPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  // Clear legacy deep links without copying identifying search terms into app state.
  useEffect(() => {
    if (params.has('q')) {
      const clean = new URLSearchParams(params);
      clean.delete('q');
      setParams(clean, { replace: true });
    }
  }, [params, setParams]);
  const [debounced] = useDebouncedValue(query.trim(), 250);
  const [criteria, setCriteria] = useState({ query: '', page: 1 });
  useEffect(() => {
    setCriteria((current) => current.query === debounced ? current : { query: debounced, page: 1 });
  }, [debounced]);

  const results = useLoader<Results>(async () => {
    const { patients, total } = await patientPage(medplum, criteria.query, criteria.page);
    const next = await nextAppointments(medplum, patients).catch(() => new Map<string, Appointment>());
    return { patients, total, next, duplicates: possibleDuplicates(patients), ...criteria };
  }, [criteria.query, criteria.page, medplum]);

  useEffect(() => {
    if (!results.loading && !results.error && results.data?.query === criteria.query && results.data.page === criteria.page) {
      const last = Math.max(1, Math.ceil(results.data.total / 10));
      if (criteria.page > last) setCriteria((current) => ({ ...current, page: last }));
    }
  }, [results.data, results.loading, results.error, criteria.query, criteria.page]);
  const pending = results.loading || query.trim() !== criteria.query || (!results.error && (results.data?.query !== criteria.query || results.data?.page !== criteria.page));

  const onChange = (value: string): void => {
    setQuery(value);
  };

  return (
    <PageBody>
      <PageHeader
        eyebrow="Patients"
        title="Find patient"
        subtitle="Browse all patients, or search by name, date of birth, phone, email, chart number or insurance member ID."
        actions={
          <Button component={Link} to="/patients/new" leftSection={<IconUserPlus size={16} />}>
            New patient
          </Button>
        }
      />
      <Card padding="md" mb="lg">
        <TextInput
          size="md"
          autoFocus
          leftSection={<IconSearch size={18} />}
          placeholder="e.g. thornton · 04/12/1991 · 425-555-0101 · TM-1001"
          value={query}
          onChange={(e) => onChange(e.currentTarget.value)}
          aria-label="Search patients"
          description={query.trim() ? KIND_HINT[classifyQuery(query).kind] : 'All patients · 10 per page · sorted by last name'}
        />
      </Card>

      <Card padding={0}>
        {pending && (
          <div style={{ padding: 'var(--mantine-spacing-lg)' }}>
            <RowsSkeleton rows={5} />
          </div>
        )}
        {!pending && results.error && (
          <div style={{ padding: 'var(--mantine-spacing-lg)' }}>
            <ErrorState error={results.error} onRetry={results.reload} />
          </div>
        )}
        {!pending && !results.error && results.data && results.data.patients.length === 0 && (
          <EmptyState
            icon={<IconUsers size={22} />}
            title={!criteria.query ? 'No patients yet' : `No patients match “${criteria.query}”`}
            action={
              criteria.query ? (
                <Button mt="sm" variant="light" component={Link} to={`/patients/new`} leftSection={<IconUserPlus size={16} />}>
                  Register a new patient
                </Button>
              ) : undefined
            }
          >
            {!criteria.query ? 'Register a new patient to start the directory.' : 'Check the spelling, or try the date of birth or phone number instead.'}
          </EmptyState>
        )}
        {!pending && !results.error && results.data && results.data.patients.length > 0 && (
          <>
            <Text size="xs" fw={650} tt="uppercase" c="dimmed" px="lg" pt="md" lts="0.05em" aria-live="polite">
              {criteria.query ? 'Search results' : 'All patients'}
            </Text>
            <Table.ScrollContainer minWidth={760}>
              <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="lg">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Patient</Table.Th>
                    <Table.Th>Date of birth</Table.Th>
                    <Table.Th>Phone</Table.Th>
                    <Table.Th>Flags</Table.Th>
                    <Table.Th>Next visit</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {results.data.patients.map((p) => {
                    const next = results.data?.next.get(p.id as string);
                    const dup = results.data?.duplicates.has(p.id as string);
                    return (
                      <Table.Tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/patients/${p.id}`)}>
                        <Table.Td>
                          <Anchor component={Link} to={`/patients/${p.id}`} fw={600} c="inherit" onClick={(e) => e.stopPropagation()}>
                            {patientName(p)}
                          </Anchor>
                          <Text size="xs" c="dimmed" className="tm-num">
                            {patientMrn(p) ?? 'No chart number'}
                          </Text>
                        </Table.Td>
                        <Table.Td className="tm-num">
                          {formatDate(p.birthDate)} <Text span size="xs" c="dimmed">({patientAge(p)})</Text>
                        </Table.Td>
                        <Table.Td className="tm-num">{telecom(p, 'phone') ?? '—'}</Table.Td>
                        <Table.Td>
                          <PatientFlags
                            patient={p}
                            extra={
                              dup
                                ? [
                                    <Tooltip key="dup" label="Looks like another record in these results. Ask an administrator to review and merge.">
                                      <Badge color="yellow" variant="light">
                                        Possible duplicate
                                      </Badge>
                                    </Tooltip>,
                                  ]
                                : undefined
                            }
                          />
                        </Table.Td>
                        <Table.Td className="tm-num">
                          {next?.start ? (
                            <Text size="sm">
                              {formatDate(next.start.slice(0, 10))} · {formatTime(next.start)}
                            </Text>
                          ) : (
                            <Text size="sm" c="dimmed">
                              None booked
                            </Text>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="space-between" gap="md" px="lg" py="md">
              <Text size="sm" c="dimmed" aria-live="polite">
                Showing {(criteria.page - 1) * 10 + 1}–{(criteria.page - 1) * 10 + results.data.patients.length} of {results.data.total} patient{results.data.total === 1 ? '' : 's'}
              </Text>
              {results.data.total > 10 && (
                <nav aria-label="Patient pages">
                  <Pagination
                    size="sm" withEdges siblings={0}
                    total={Math.ceil(results.data.total / 10)} value={criteria.page}
                    onChange={(page) => setCriteria((current) => ({ ...current, page }))}
                    getItemProps={(page) => ({ 'aria-label': `Go to patient page ${page}` })}
                    getControlProps={(control) => ({ 'aria-label': `${control[0].toUpperCase()}${control.slice(1)} patient page` })}
                  />
                </nav>
              )}
            </Group>
          </>
        )}
      </Card>
    </PageBody>
  );
}

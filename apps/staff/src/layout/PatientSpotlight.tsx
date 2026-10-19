import { Badge, Group, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { Spotlight } from '@mantine/spotlight';
import { calculateAgeString, formatHumanName } from '@medplum/core';
import type { HumanName, Patient } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconSearch, IconUser } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { LICENSED_STATES } from '@teleemon/core';
import { searchPatients } from '../fhir/patientSearch';
import { formatDate } from '../utils/format';

// Global patient search (Ctrl+K): same rules as the Find patient page (P07).

export function PatientSpotlight(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 200);
  const [results, setResults] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (debounced.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    searchPatients(medplum, debounced, 8)
      .then((r) => !cancelled && setResults(r))
      .catch(() => !cancelled && setResults([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, medplum]);

  return (
    <Spotlight.Root query={query} onQueryChange={setQuery} shortcut={['mod + K']} scrollable maxHeight={420}>
      <Spotlight.Search placeholder="Name, date of birth, phone or chart number" leftSection={<IconSearch size={18} />} />
      <Spotlight.ActionsList>
        {results.map((patient) => {
          const state = patient.address?.[0]?.state;
          const unlicensed = state && !(LICENSED_STATES as readonly string[]).includes(state);
          return (
            <Spotlight.Action key={patient.id} onClick={() => navigate(`/patients/${patient.id}`)}>
              <Group wrap="nowrap" w="100%" gap="sm">
                <IconUser size={18} stroke={1.6} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600} truncate>
                    {formatHumanName(patient.name?.[0] as HumanName)}
                  </Text>
                  <Text size="xs" c="dimmed" className="tm-num">
                    DOB {formatDate(patient.birthDate)} · {patient.birthDate ? calculateAgeString(patient.birthDate) : '—'}
                  </Text>
                </div>
                {state && (
                  <Badge color={unlicensed ? 'red' : 'gray'} variant="light">
                    {state}
                  </Badge>
                )}
              </Group>
            </Spotlight.Action>
          );
        })}
        {query.trim().length >= 2 && !loading && results.length === 0 && (
          <Spotlight.Empty>No patients match “{query.trim()}”.</Spotlight.Empty>
        )}
        {query.trim().length < 2 && <Spotlight.Empty>Type at least 2 characters to search.</Spotlight.Empty>}
      </Spotlight.ActionsList>
    </Spotlight.Root>
  );
}

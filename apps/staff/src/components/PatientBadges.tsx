import { Badge, Group, Tooltip } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconLock } from '@tabler/icons-react';
import { LICENSED_STATES } from '@teleemon/core';
import type { JSX } from 'react';
import { isRestricted, isSelfPay, patientIsMinor, patientState } from '../fhir/patient';

export function StateBadge({ state }: { readonly state: string | undefined }): JSX.Element | null {
  if (!state) return null;
  const licensed = (LICENSED_STATES as readonly string[]).includes(state);
  return licensed ? (
    <Badge color="navy" variant="light">
      {state}
    </Badge>
  ) : (
    <Tooltip label={`The provider is not licensed in ${state}.`}>
      <Badge color="red" variant="filled" leftSection={<IconAlertTriangle size={12} />}>
        {state} · not licensed
      </Badge>
    </Tooltip>
  );
}

/** Status flags shown wherever a patient appears in a list or header. */
export function PatientFlags({ patient, extra }: { readonly patient: Patient; readonly extra?: JSX.Element[] }): JSX.Element {
  return (
    <Group gap={6} wrap="wrap">
      <StateBadge state={patientState(patient)} />
      {patientIsMinor(patient) && (
        <Tooltip label="Under 18: guardian consent and minor-privacy rules apply">
          <Badge color="grape">Minor</Badge>
        </Tooltip>
      )}
      {isRestricted(patient) && (
        <Tooltip label="Restricted chart: opening it requires a reason, which is logged">
          <Badge color="orange" leftSection={<IconLock size={11} />}>
            Restricted
          </Badge>
        </Tooltip>
      )}
      {isSelfPay(patient) && <Badge color="gray">Self-pay</Badge>}
      {extra}
    </Group>
  );
}

import { Badge, Button, Card, Group, MultiSelect, NumberInput, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import type { EmMethod, MdmLevel, NoteData } from '@teleemon/core';
import { addOnFor, findTemplate, suggestPrimary } from '@teleemon/core';
import type { JSX } from 'react';

const POS = [
  { value: '10', label: '10 · Telehealth, patient at home' },
  { value: '02', label: '02 · Telehealth, patient not at home' },
  { value: '11', label: '11 · Office' },
];

// The billing panel of the encounter workspace (P21). Codes are captured here; the charge is
// created from the signed note and waits for charge review (P30).
export function BillingPanel({ note, onChange, readOnly }: { readonly note: NoteData; readonly onChange: (n: NoteData) => void; readonly readOnly?: boolean }): JSX.Element {
  const template = findTemplate(note.template);
  const b = note.billing;
  const set = (patch: Partial<NoteData['billing']>): void => onChange({ ...note, billing: { ...b, ...patch } });
  const suggestion = suggestPrimary(note);
  const addOn = template?.psychotherapy ? addOnFor(note.psychotherapy?.minutes) : undefined;
  const ungraded = template && ['telephone', 'crisis'].includes(template.code);

  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Text fw={650}>Billing</Text>
        <Badge variant="light" color="gray" size="sm">
          Charge created when you sign
        </Badge>
      </Group>
      {ungraded ? (
        <Text size="sm" c="dimmed">
          {template?.label}s are documented without a visit code. Billable telephone or crisis codes can be added once the payer rules cover them.
        </Text>
      ) : (
        <Stack gap="sm">
          {!template?.evaluation && (
            <>
              <SegmentedControl
                size="xs"
                value={b.emMethod}
                onChange={(v) => set({ emMethod: v as EmMethod })}
                disabled={readOnly}
                data={[
                  { value: 'mdm', label: 'By decision making' },
                  { value: 'time', label: 'By total time', disabled: !!b.addOnCode },
                ]}
              />
              {b.emMethod === 'mdm' ? (
                <Select
                  size="xs"
                  label="Medical decision making"
                  data={[
                    { value: 'straightforward', label: 'Straightforward' },
                    { value: 'low', label: 'Low' },
                    { value: 'moderate', label: 'Moderate' },
                    { value: 'high', label: 'High' },
                  ]}
                  value={b.mdm ?? null}
                  onChange={(v) => set({ mdm: (v ?? undefined) as MdmLevel | undefined })}
                  readOnly={readOnly}
                />
              ) : (
                <NumberInput size="xs" label="Total time on the date of service (minutes)" min={0} max={240} value={b.totalMinutes ?? ''} onChange={(v) => set({ totalMinutes: v === '' ? undefined : Number(v) })} readOnly={readOnly} />
              )}
            </>
          )}
          <div>
            <Group justify="space-between" align="flex-end" wrap="nowrap">
              <Select
                size="xs"
                label="Visit code"
                style={{ flex: 1 }}
                data={template?.evaluation ? ['90792'] : ['99212', '99213', '99214', '99215']}
                value={b.primaryCode ?? null}
                onChange={(v) => set({ primaryCode: v ?? undefined })}
                readOnly={readOnly}
              />
              {!readOnly && suggestion.code && suggestion.code !== b.primaryCode && (
                <Button size="xs" variant="light" onClick={() => set({ primaryCode: suggestion.code })}>
                  Use {suggestion.code}
                </Button>
              )}
            </Group>
            <Text size="xs" c="dimmed" mt={4}>
              Suggested: {suggestion.code ?? '—'} · {suggestion.reason}
            </Text>
          </div>
          {template?.psychotherapy && (
            <div>
              <Group justify="space-between" align="flex-end" wrap="nowrap">
                <Select
                  size="xs"
                  label="Psychotherapy add-on"
                  style={{ flex: 1 }}
                  clearable
                  data={['90833', '90836', '90838']}
                  value={b.addOnCode ?? null}
                  onChange={(v) => set({ addOnCode: v ?? undefined, emMethod: v ? 'mdm' : b.emMethod })}
                  readOnly={readOnly}
                />
                {!readOnly && addOn && addOn !== b.addOnCode && (
                  <Button size="xs" variant="light" onClick={() => set({ addOnCode: addOn, emMethod: 'mdm' })}>
                    Use {addOn}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed" mt={4}>
                With an add-on, the E/M level is chosen by decision making; time can't count twice.
              </Text>
            </div>
          )}
          <Group grow align="flex-start">
            <Select size="xs" label="Place of service" data={POS} value={b.pos ?? null} onChange={(v) => set({ pos: v ?? undefined })} readOnly={readOnly} />
            <MultiSelect size="xs" label="Modifiers" data={['95', '93', 'GT', 'FQ']} value={b.modifiers} onChange={(v) => set({ modifiers: v })} readOnly={readOnly} />
          </Group>
          <Text size="xs" c="dimmed">
            Diagnosis pointers follow the order in Diagnoses ({note.diagnoses.map((d, i) => `${String.fromCharCode(65 + i)} ${d.code}`).join(', ') || 'none yet'}). Telehealth modifiers follow each payer's set-up in Payers, fees &amp; codes.
          </Text>
        </Stack>
      )}
    </Card>
  );
}

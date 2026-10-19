import { Alert, Badge, Button, Card, Checkbox, FileButton, Group, Radio, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { createReference } from '@medplum/core';
import type { Coverage, DocumentReference } from '@medplum/fhirtypes';
import { IconAlertTriangle, IconCamera, IconCircleCheck } from '@tabler/icons-react';
import { CODE_SYSTEMS, EXT } from '@teleemon/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { errorText } from '../../api';
import { useMe, useSession } from '../../session';
import type { StepProps } from '../IntakePage';

const RELATIONSHIP = 'http://terminology.hl7.org/CodeSystem/subscriber-relationship';
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'];

// Insurance the patient enters is saved as a draft Coverage; the care team verifies it (policy
// writeConstraint: patients create and edit drafts only). Card photos are preliminary documents
// until the care team checks them. Self-pay patients acknowledge a good-faith estimate per visit.
export function InsuranceStep({ overview, saved }: StepProps): JSX.Element {
  const { medplum } = useSession();
  const me = useMe();
  const draft = overview.intakeState?.coverages.find((c) => c.status === 'draft');
  const verified = overview.intakeState?.coverages.find((c) => c.status === 'active');
  const source = draft ?? verified;
  const selfPay = overview.patient.extension?.some((e) => e.url === EXT.selfPay && e.valueBoolean === true);
  const [mode, setMode] = useState<'insurance' | 'self-pay'>(selfPay ? 'self-pay' : 'insurance');
  const [v, setV] = useState({
    payer: source?.payor?.[0]?.display ?? '',
    memberId: source?.subscriberId ?? '',
    group: source?.class?.find((c) => c.type.coding?.some((x) => x.code === 'group'))?.value ?? '',
    relationship: source?.relationship?.coding?.[0]?.code ?? 'self',
    subscriberName: source?.subscriber?.display ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const unchangedVerified = !draft && !!verified && v.payer === (verified.payor?.[0]?.display ?? '') && v.memberId === (verified.subscriberId ?? '');

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const patient = await medplum.readResource('Patient', overview.patient.id as string, { cache: 'no-cache' });
      const others = (patient.extension ?? []).filter((e) => e.url !== EXT.selfPay);
      const extension = mode === 'self-pay' ? [...others, { url: EXT.selfPay, valueBoolean: true }] : others;
      if ((mode === 'self-pay') !== !!selfPay) await medplum.updateResource({ ...patient, extension: extension.length ? extension : undefined });
      // A verified plan that the patient leaves as it is needs no new draft.
      if (mode === 'insurance' && !unchangedVerified) {
        const coverage: Coverage = {
          ...(draft ?? {}),
          resourceType: 'Coverage',
          status: 'draft',
          beneficiary: { reference: me.patientRef },
          payor: [{ display: v.payer.trim() }],
          subscriberId: v.memberId.trim(),
          relationship: { coding: [{ system: RELATIONSHIP, code: v.relationship }] },
          subscriber: v.relationship === 'self' ? { reference: me.patientRef } : { display: v.subscriberName.trim() },
          class: v.group.trim() ? [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'group' }] }, value: v.group.trim() }] : undefined,
        };
        await (draft ? medplum.updateResource(coverage) : medplum.createResource(coverage));
      }
      // Switching to self-pay stays on this step so the visit's estimate can be acknowledged.
      saved(mode === 'insurance' || (!!selfPay && !overview.estimate?.needed));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ok = mode === 'self-pay' || (v.payer.trim() && v.memberId.trim() && (v.relationship === 'self' || v.subscriberName.trim()));
  return (
    <Stack>
      {verified && <Alert color="green">Insurance on file: {verified.payor?.[0]?.display ?? 'verified plan'}. Change the details below only if your plan has changed.</Alert>}
      <Radio.Group value={mode} onChange={(m) => setMode(m as 'insurance' | 'self-pay')} label="How will you pay for visits?">
        <Stack gap="xs" mt="xs">
          <Radio value="insurance" label="With my health insurance" />
          <Radio value="self-pay" label="I will pay myself (self-pay)" description="You will see a good-faith estimate for each visit." />
        </Stack>
      </Radio.Group>
      {mode === 'insurance' && (
        <>
          <SimpleGrid cols={{ base: 1, xs: 2 }}>
            <TextInput label="Insurance company or plan" value={v.payer} onChange={(e) => setV({ ...v, payer: e.currentTarget.value })} />
            <TextInput label="Member ID" value={v.memberId} onChange={(e) => setV({ ...v, memberId: e.currentTarget.value })} />
            <TextInput label="Group number (optional)" value={v.group} onChange={(e) => setV({ ...v, group: e.currentTarget.value })} />
          </SimpleGrid>
          <Radio.Group value={v.relationship} onChange={(r) => setV({ ...v, relationship: r })} label="Whose plan is it?">
            <Group mt="xs"><Radio value="self" label="Mine" /><Radio value="spouse" label="Spouse or partner" /><Radio value="child" label="Parent's" /><Radio value="other" label="Someone else" /></Group>
          </Radio.Group>
          {v.relationship !== 'self' && <TextInput label="Plan holder's full name" value={v.subscriberName} onChange={(e) => setV({ ...v, subscriberName: e.currentTarget.value })} />}
          <CardPhotos cards={overview.cards} patientRef={me.patientRef} onUploaded={() => saved(false)} />
          <Text size="xs" c="dimmed">The care team checks your benefits before your visit and will contact you about anything that does not match.</Text>
        </>
      )}
      {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
      <Group justify="flex-end"><Button loading={busy} disabled={!ok} onClick={() => void save()}>{mode === 'self-pay' && !selfPay ? 'Save' : 'Save and continue'}</Button></Group>
      {mode === 'self-pay' && selfPay && overview.estimate?.estimate && <EstimateCard overview={overview} onDone={() => saved()} />}
    </Stack>
  );
}

/** Front and back of the card, uploaded as preliminary id-insurance documents on the patient's record. */
function CardPhotos({ cards, patientRef, onUploaded }: { readonly cards: DocumentReference[]; readonly patientRef: string; readonly onUploaded: () => void }): JSX.Element {
  const { medplum } = useSession();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const side = (label: string): DocumentReference | undefined => cards.find((d) => d.description === label);

  const upload = async (label: string, file: File | null): Promise<void> => {
    if (!file) return;
    setError(undefined);
    if (!TYPES.includes(file.type)) return setError('Upload a photo (JPEG, PNG, HEIC or WebP) or a PDF.');
    if (file.size > MAX_BYTES) return setError('That file is larger than 10 MB. Try a smaller photo.');
    setBusy(label);
    try {
      const doc = await medplum.createResource<DocumentReference>({
        resourceType: 'DocumentReference',
        status: 'current',
        docStatus: 'preliminary',
        category: [{ coding: [{ system: CODE_SYSTEMS.documentCategory, code: 'id-insurance', display: 'ID and insurance cards' }] }],
        subject: { reference: patientRef },
        date: new Date().toISOString(),
        description: label,
        content: [{ attachment: { contentType: file.type, title: label } }],
      });
      const attachment = await medplum.createAttachment({ data: file, contentType: file.type, filename: file.name, securityContext: createReference(doc) });
      await medplum.updateResource<DocumentReference>({ ...doc, content: [{ attachment: { ...attachment, title: label, size: file.size } }] });
      onUploaded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Text fw={600}>Photos of your insurance card</Text>
        <Text size="sm" c="dimmed">Take a clear photo of each side. This helps us check your benefits before your visit.</Text>
        <Group>
          {['Insurance card (front)', 'Insurance card (back)'].map((label) => {
            const done = side(label);
            return (
              <FileButton key={label} onChange={(f) => void upload(label, f)} accept={TYPES.join(',')}>
                {(props) => (
                  <Button {...props} variant={done ? 'light' : 'default'} loading={busy === label} leftSection={done ? <IconCircleCheck size={16} /> : <IconCamera size={16} />}>
                    {label.replace('Insurance card ', '').replace(/[()]/g, '').replace(/^./, (c) => c.toUpperCase())}{done ? ' added' : ''}
                  </Button>
                )}
              </FileButton>
            );
          })}
          {cards.some((d) => d.docStatus === 'final') && <Badge color="green">Checked by the care team</Badge>}
        </Group>
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
      </Stack>
    </Card>
  );
}

/** Self-pay: the patient acknowledges the estimate for their next visit (recorded with its exact text). */
function EstimateCard({ overview, onDone }: { readonly overview: StepProps['overview']; readonly onDone: () => void }): JSX.Element {
  const { api } = useSession();
  const me = useMe();
  const estimate = overview.estimate?.estimate;
  const [agree, setAgree] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!estimate) return <></>;
  if (!overview.estimate?.needed) return <Alert color="green" icon={<IconCircleCheck size={18} />}>You acknowledged the good-faith estimate for your next visit (${estimate.amount.toFixed(2)}).</Alert>;
  const acknowledge = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post('estimate/acknowledge', { appointmentId: estimate.appointmentId, signature, agree });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between"><Text fw={650}>{estimate.title}</Text><Text fw={650} className="tm-num">${estimate.amount.toFixed(2)}</Text></Group>
        <Text size="sm">{estimate.body}</Text>
        <Checkbox checked={agree} onChange={(e) => setAgree(e.currentTarget.checked)} label={me.access === 'self' ? 'I received this estimate.' : `I received this estimate on behalf of ${me.patientName}.`} />
        <TextInput label="Type your full name" value={signature} onChange={(e) => setSignature(e.currentTarget.value)} autoComplete="name" />
        {error && <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error}</Alert>}
        <Group justify="flex-end"><Button loading={busy} disabled={!agree || signature.trim().length < 2} onClick={() => void acknowledge()}>Acknowledge and continue</Button></Group>
      </Stack>
    </Card>
  );
}

// Post-commit Bot on signed notes (P21 → P30; SYSTEM-DESIGN.md §7.3). When a provider signs a
// note, its visit code and add-on become ChargeItems waiting for charge review. Idempotent: one
// ChargeItem per note and code. Addenda and corrections never create charges; a note without a
// visit code (telephone, crisis) creates none.

import type { BotEvent, MedplumClient } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type { ChargeItem, Composition, Coverage, Encounter, Patient } from '@medplum/fhirtypes';
import type { NoteData, PayerConfig } from '@teleemon/core';
import {
  CPT_SYSTEM, EXT, ICD10CM_SYSTEM, REVENUE_EXT, centsMoney, chargeIdentifier, chargeLinesFromNote, payerIdOf, readSettings,
} from '@teleemon/core';

/** Before a payer is known, no telehealth modifier is assumed; charge review adds it. */
const NO_PAYER: PayerConfig = { id: 'payer:unassigned', name: 'Unassigned', payerIdCode: '', timelyFilingDays: 365, appealDays: 180, requiresPriorAuthCodes: [], telehealthModifier: 'none', acceptsPos10: true, active: true };

export async function handler(medplum: MedplumClient, event: BotEvent<Composition>): Promise<ChargeItem[]> {
  const note = event.input;
  if (note.status !== 'final' || note.relatesTo?.length || !note.id || !note.encounter?.reference || !note.subject?.reference?.startsWith('Patient/')) return [];
  const json = note.extension?.find((e) => e.url === EXT.noteData)?.valueString;
  if (!json) return [];
  const data = JSON.parse(json) as NoteData;

  const [encounter, patient, settings] = await Promise.all([
    medplum.readReference(note.encounter as { reference: string }) as Promise<Encounter>,
    medplum.readReference(note.subject as { reference: string }) as Promise<Patient>,
    readSettings(medplum, 'billing'),
  ]);
  const selfPay = patient.extension?.some((e) => e.url === EXT.selfPay && e.valueBoolean === true);
  const coverage = selfPay ? undefined : await medplum.searchOne('Coverage', { beneficiary: getReferenceString(patient), status: 'active', _sort: '-_lastUpdated' });
  const payerId = selfPay ? 'self-pay' : payerIdOf(coverage as Coverage | undefined);
  const payer = settings.payers.find((p) => p.id === payerId) ?? NO_PAYER;
  const lines = chargeLinesFromNote(data, settings.fees, { payer });
  const signer = note.attester?.find((a) => a.mode === 'legal')?.party;
  const reason = data.diagnoses.slice(0, 12).map((d) => ({ coding: [{ system: ICD10CM_SYSTEM, code: d.code, display: d.display }] }));

  const out: ChargeItem[] = [];
  for (const line of lines) {
    const id = chargeIdentifier(note.id, line.code);
    const charge: ChargeItem = {
      resourceType: 'ChargeItem',
      status: 'planned',
      identifier: [id],
      code: { coding: [{ system: CPT_SYSTEM, code: line.code }] },
      subject: createReference(patient),
      context: createReference(encounter),
      occurrenceDateTime: encounter.period?.start ?? note.date,
      performer: signer ? [{ actor: signer }] : undefined,
      quantity: { value: line.units },
      priceOverride: centsMoney(line.chargeCents),
      reason,
      supportingInformation: [createReference(note)],
      extension: [
        { url: REVENUE_EXT.chargeLine, valueString: JSON.stringify(line) },
        ...(payerId ? [{ url: REVENUE_EXT.billingPayer, valueString: payerId }] : []),
      ],
    };
    out.push(await medplum.createResourceIfNoneExist(charge, `identifier=${id.system}|${id.value}`));
  }
  if (out.length) console.log(`charge capture: ${out.length} charge(s) for ${getReferenceString(note)}`);
  return out;
}

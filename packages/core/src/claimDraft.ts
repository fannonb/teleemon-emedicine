// Builds the scrubber's ClaimDraft from FHIR resources the caller has already fetched (Phase 8).
// claimDraftFromFhir is pure (no MedplumClient, no clock); fetchClaimSources does the reads. The claim pre-commit Bot and the worker's submission step both
// call this, so the scrub that gates submission sees exactly what goes on the 837.
//
// Missing data becomes an empty or undefined field, never a guess, so the scrubber reports it.

import type { MedplumClient } from '@medplum/core';
import type { ChargeItem, Claim, Coverage, Encounter, Organization, Patient, Practitioner, Reference } from '@medplum/fhirtypes';
import type { ChargeLine, ClaimAddress, ClaimDraft, PersonName, ProviderInfo } from './billing';
import { EXT, NPI_SYSTEM } from './fhir';
import { licensedStates } from './licensure';
import { REVENUE_EXT, chargeLineOf, payerIdOf } from './revenue';

/** Tax identification (EIN) on the practice Organization. Same system the Practice settings page writes. */
export const TAX_ID_SYSTEM = 'urn:oid:2.16.840.1.113883.4.4';

export interface ClaimSources {
  readonly claim: Claim;
  readonly patient: Patient;
  readonly coverage: Coverage;
  /** The rendering provider (Claim.provider). Undefined when not fetched; the scrubber then refuses. */
  readonly rendering?: Practitioner;
  /** The billing organization (Claim.organization). */
  readonly billing?: Organization;
  /** ChargeItems named by the claim's items (REVENUE_EXT.chargeItem). Extra items are ignored. */
  readonly chargeItems: readonly ChargeItem[];
  /** The visit Encounter, for the patient-location state (EXT.patientLocationState). Telehealth needs it. */
  readonly encounter?: Encounter;
}

/**
 * The payer a claim goes to: the claim's own billing payer when it has one, otherwise the payer
 * named on the coverage. Undefined when neither is set.
 */
export function claimPayerId(claim: Claim, coverage: Coverage | undefined): string | undefined {
  const own = claim.extension?.find((e) => e.url === REVENUE_EXT.billingPayer)?.valueString;
  if (own) return own;
  return coverage ? payerIdOf(coverage) : undefined;
}

const SUBSCRIBER: Readonly<Record<string, 'self' | 'spouse' | 'child' | 'other'>> = { self: 'self', spouse: 'spouse', child: 'child', other: 'other', injured: 'other' };

/** Money as whole cents. priceOverride is dollars in FHIR; Math.round keeps the cents integral. */
export function chargeItemCents(c: ChargeItem): number | undefined {
  const value = c.priceOverride?.value;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * 100);
}

type ClaimItem = NonNullable<Claim['item']>[number];

function lineFor(item: ClaimItem, chargeItems: readonly ChargeItem[]): ChargeLine {
  const ref = item?.extension?.find((e) => e.url === REVENUE_EXT.chargeItem)?.valueReference?.reference;
  const ci = ref ? chargeItems.find((c) => `ChargeItem/${c.id}` === ref) : undefined;
  const parsed = ci ? chargeLineOf(ci) : undefined;
  if (parsed) {
    const cents = ci ? chargeItemCents(ci) : undefined;
    // The ledger posts the ChargeItem's priceOverride, so the claim must bill the same amount.
    return cents === undefined ? parsed : { ...parsed, chargeCents: cents };
  }
  // No readable ChargeLine: the scrubber refuses the line (zero charge, no place of service, no pointers).
  return { code: item?.productOrService?.coding?.[0]?.code ?? '', modifiers: [], units: 1, diagnosisPointers: [], chargeCents: 0, pos: '' };
}

function personName(p: Patient): PersonName {
  const name = p.name?.find((n) => n.use === 'official') ?? p.name?.[0];
  return { given: name?.given?.[0] ?? '', family: name?.family ?? '' };
}

function patientAddress(p: Patient): ClaimAddress | undefined {
  const a = p.address?.find((x) => x.use === 'home') ?? p.address?.[0];
  if (!a) return undefined;
  // SCR-028 wants five or nine digits with no hyphen, so the hyphen is removed here.
  return { line: a.line?.[0], city: a.city, state: a.state, zip: a.postalCode?.replace(/-/g, '') };
}

/** Rendering provider: NPI and the states licensed on the date of service (SCR-014). */
function renderingInfo(p: Practitioner | undefined, serviceDate: string): ProviderInfo {
  return { npi: p?.identifier?.find((i) => i.system === NPI_SYSTEM)?.value, licensedStates: p ? licensedStates(p, serviceDate || undefined) : [] };
}

/** Billing organization: NPI and EIN. Organizations carry no licences. */
function billingInfo(o: Organization | undefined): ProviderInfo {
  return { npi: o?.identifier?.find((i) => i.system === NPI_SYSTEM)?.value, taxId: o?.identifier?.find((i) => i.system === TAX_ID_SYSTEM)?.value, licensedStates: [] };
}

/** The scrubber's view of a claim. Frequency 7 when the claim names an original claim (Claim.related), otherwise 1. */
export function claimDraftFromFhir(src: ClaimSources): ClaimDraft {
  const { claim, patient, coverage, rendering, billing, chargeItems, encounter } = src;
  const items = claim.item ?? [];
  const lines = items.map((item) => lineFor(item, chargeItems));
  const matched = items
    .map((item) => chargeItems.find((c) => `ChargeItem/${c.id}` === item.extension?.find((e) => e.url === REVENUE_EXT.chargeItem)?.valueReference?.reference))
    .filter((c): c is ChargeItem => c !== undefined);
  const serviceDate = (claim.billablePeriod?.start ?? matched[0]?.occurrenceDateTime ?? '').slice(0, 10);
  const poses = [...new Set(lines.map((l) => l.pos))];
  const original = claim.related?.find((r) => r.claim?.reference)?.claim?.reference;
  const originalId = original?.replace(/^Claim\//, '');
  const relationship = coverage.relationship?.coding?.[0]?.code;
  const memberId = coverage.subscriberId ?? coverage.identifier?.[0]?.value;
  const groupNumber = coverage.class?.find((c) => c.type?.coding?.[0]?.code === 'group')?.value;
  const patientState = encounter?.extension?.find((e) => e.url === EXT.patientLocationState)?.valueCode;
  const sex = patient.gender === 'male' || patient.gender === 'female' ? patient.gender : 'unknown';

  return {
    id: claim.id ?? '',
    patient: { id: patient.id ?? '', name: personName(patient), birthDate: patient.birthDate, sex, address: patientAddress(patient) },
    subscriber: { relationship: relationship ? SUBSCRIBER[relationship] : undefined },
    coverage: {
      payerId: claimPayerId(claim, coverage) ?? '',
      memberId,
      groupNumber,
      periodStart: coverage.period?.start?.slice(0, 10) ?? '',
      periodEnd: coverage.period?.end?.slice(0, 10),
    },
    providers: { rendering: renderingInfo(rendering, serviceDate), billing: billingInfo(billing) },
    serviceDate,
    placeOfService: poses[0] ?? '',
    patientLocationState: patientState,
    lines,
    diagnoses: (claim.diagnosis ?? []).map((d) => ({ code: d.diagnosisCodeableConcept?.coding?.[0]?.code ?? '' })),
    priorAuth: claim.insurance?.[0]?.preAuthRef?.[0],
    frequencyCode: originalId ? '7' : '1',
    originalClaimId: originalId || undefined,
  };
}

/** The practice billing organization: the Organization typed as a healthcare provider ('prov'). */
export const PRACTICE_ORG_TYPE = 'http://terminology.hl7.org/CodeSystem/organization-type|prov';

/**
 * Fetches everything claimDraftFromFhir needs, by reference. Shared by the claim-rules Bot (which
 * re-scrubs on the server) and the worker (which builds the 837P), so both see the same claim.
 * Missing pieces are left out and the scrubber reports them.
 */
export async function fetchClaimSources(medplum: MedplumClient, claim: Claim): Promise<ClaimSources> {
  const coverageRef = claim.insurance?.[0]?.coverage;
  if (!coverageRef?.reference?.startsWith('Coverage/')) throw new Error('the claim has no coverage');
  const [patient, coverage] = await Promise.all([
    medplum.readReference(claim.patient as Reference<Patient>),
    medplum.readReference(coverageRef as Reference<Coverage>),
  ]);
  const rendering = claim.provider?.reference?.startsWith('Practitioner/') ? await medplum.readReference(claim.provider as Reference<Practitioner>) : undefined;
  const billing = (await medplum.searchOne('Organization', { type: PRACTICE_ORG_TYPE, active: 'true' }, { cache: 'no-cache' })) ?? undefined;
  const chargeRefs = (claim.item ?? []).map((i) => i.extension?.find((e) => e.url === REVENUE_EXT.chargeItem)?.valueReference?.reference).filter((r): r is string => !!r?.startsWith('ChargeItem/'));
  const chargeItems = await Promise.all(chargeRefs.map((r) => medplum.readReference<ChargeItem>({ reference: r })));
  const encounterRef = (claim.item ?? []).flatMap((i) => i.encounter ?? []).find((e) => e.reference?.startsWith('Encounter/'))?.reference ?? chargeItems.find((c) => c.context?.reference?.startsWith('Encounter/'))?.context?.reference;
  const encounter = encounterRef ? await medplum.readReference<Encounter>({ reference: encounterRef }) : undefined;
  return { claim, patient, coverage, rendering, billing, chargeItems, encounter };
}

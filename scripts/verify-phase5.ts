// Phase 5 gate: e-prescribing and PDMP rules, proven against the local Medplum server with real
// role logins, the deployed pre-commit Bots and the worker's mock e-prescribing adapter. Uses one
// synthetic patient created here; everything is removed afterwards. No vendor is contacted.

import type { MedplumClient } from '@medplum/core';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { MedicationRequest, Patient, Practitioner, Task } from '@medplum/fhirtypes';
import type { RxDraft } from '@teleemon/core';
import { CODE_SYSTEMS, DERIVED_IDENTIFIER_SYSTEM, EXT, SEED_IDENTIFIER_SYSTEM, buildMedicationRequest, buildPdmpTask, buildRenewalTask, erxStatus } from '@teleemon/core';
import { MockErxAdapter, processPrescriptions } from '../services/worker/src/erx';
import { connectWorker } from '../services/worker/src/index';
import { connect, connectAsPassword } from './lib/client';

const PASSWORD = process.env.TELEEMON_TEST_PASSWORD ?? 'Teleemon-Local-2026';
const MARK = `verify-phase5-${Date.now()}`;
let failures = 0;
let passes = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail.slice(0, 140)})` : ''}`);
}
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: normalizeErrorString(err) };
  }
}
const draft = (over: Partial<RxDraft> = {}): RxDraft => ({ medication: 'Sertraline', sig: 'Take 1 tablet by mouth daily', quantity: 30, unit: 'tablet', daysSupply: 30, refills: 1, pharmacy: 'Synthetic Pharmacy, Bellevue WA', state: 'WA', substitutionAllowed: true, ...over });

async function main(): Promise<void> {
  const admin = await connect();
  const patient = await admin.createResource<Patient>({
    resourceType: 'Patient', identifier: [{ system: SEED_IDENTIFIER_SYSTEM, value: MARK }], name: [{ family: 'Prescribing Verification', given: ['Synthetic'] }], birthDate: '1990-01-01',
  });
  try {
    await checks(admin, patient);
  } finally {
    console.log(`\n(cleaned up ${await cleanup(admin, patient)} test resources)`);
  }
  console.log(`\n${passes} PASS, ${failures} FAIL (${passes + failures} checks)`);
  console.log(failures === 0 ? '✓ Phase 5 server-side checks passed' : `✗ ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

async function checks(admin: MedplumClient, patient: Patient): Promise<void> {
  const provider = await connectAsPassword('provider@teleemon.test', PASSWORD);
  const frontdesk = await connectAsPassword('frontdesk@teleemon.test', PASSWORD);
  const practiceAdmin = await connectAsPassword('admin@teleemon.test', PASSWORD);
  const worker = await connectWorker();
  const prac = (await admin.searchOne('Practitioner', { identifier: `${SEED_IDENTIFIER_SYSTEM}|prac-provider` })) as Practitioner;
  const me = createReference(prac);
  const p = createReference(patient);
  const rx = (d: RxDraft, pdmpTaskId?: string): MedicationRequest => buildMedicationRequest(d, { patient: p, requester: me, send: true, pdmpTaskId });
  const mine = (ids: string[]) => (r: MedicationRequest): boolean => ids.includes(r.id as string);
  const adapter = new MockErxAdapter();

  console.log('Prescribing rules (pre-commit Bot, any client)');
  const plain = await attempt(() => provider.createResource(rx(draft())));
  report(plain.ok, 'Provider sends a non-controlled prescription for a WA patient', plain.error);
  const stim = draft({ medication: 'Lisdexamfetamine', refills: 0, quantity: 30 });
  const noPdmp = await attempt(() => provider.createResource(rx(stim)));
  report(!noPdmp.ok && /PDMP/.test(noPdmp.error ?? ''), 'Controlled prescription without a PDMP check is refused', noPdmp.error);
  const tx = await attempt(() => provider.createResource(rx(draft({ state: 'TX' }))));
  report(!tx.ok && /not licensed in TX/.test(tx.error ?? ''), 'Patient located in an unlicensed state (TX) is refused', tx.error);
  const refills = await attempt(() => provider.createResource(rx({ ...stim, refills: 2 })));
  report(!refills.ok && /refills/.test(refills.error ?? ''), 'C-II prescription with refills is refused', refills.error);
  const freeText = await attempt(() => provider.createResource(rx(draft({ medication: 'Unlisted compound' }))));
  report(!freeText.ok && /catalogue/.test(freeText.error ?? ''), 'Free-text medication is refused until the vendor drug database is connected', freeText.error);
  const held = await attempt(() => provider.createResource({ ...rx(stim), status: 'on-hold' }));
  report(!held.ok, 'A non-active initial status cannot bypass prescribing checks', held.error);

  console.log('PDMP checks');
  const backdated = await attempt(() => provider.createResource(buildPdmpTask({ patient: p, practitioner: me, state: 'WA', result: 'no-concerns', checkedAt: new Date(Date.now() - 3 * 3600000).toISOString() })));
  report(!backdated.ok && /within the last/.test(backdated.error ?? ''), 'Backdated PDMP check is refused', backdated.error);
  const forOther = await attempt(() => practiceAdmin.createResource(buildPdmpTask({ patient: p, practitioner: me, state: 'WA', result: 'no-concerns' })));
  report(!forOther.ok && /own name/.test(forOther.error ?? ''), 'Administrator cannot record a PDMP check in the provider’s name', forOther.error);
  const fdPdmp = await attempt(() => frontdesk.createResource(buildPdmpTask({ patient: p, practitioner: me, state: 'WA', result: 'no-concerns' })));
  report(!fdPdmp.ok, 'Front desk cannot record a PDMP check', fdPdmp.error);
  const ownFd = await attempt(() => frontdesk.createResource(buildPdmpTask({ patient: p, practitioner: frontdesk.getProfile() ? createReference(frontdesk.getProfile()!) as typeof me : me, state: 'WA', result: 'no-concerns' })));
  report(!ownFd.ok, 'Front desk cannot record a PDMP check even under its own profile', ownFd.error);
  const check = await attempt(() => provider.createResource(buildPdmpTask({ patient: p, practitioner: me, state: 'WA', result: 'no-concerns', note: 'Synthetic review' })));
  report(check.ok, 'Provider records a WA PDMP check at the time of review', check.error);
  const pdmpId = check.value?.id as string;
  const edit = await attempt(() => provider.updateResource({ ...(check.value as Task), extension: [{ url: EXT.pdmpResult, valueCode: 'concerns-discussed' }] }));
  report(!edit.ok && /cannot be changed/.test(edit.error ?? ''), 'A recorded PDMP check cannot be edited', edit.error);
  const uncited = await attempt(() => provider.createResource(rx(stim)));
  report(!uncited.ok && /Link a current PDMP check/.test(uncited.error ?? ''), 'Controlled prescription must cite the PDMP check it relies on', uncited.error);
  const controlled = await attempt(() => provider.createResource(rx(stim, pdmpId)));
  report(controlled.ok, 'Controlled prescription with a current WA PDMP check and WA DEA is accepted', controlled.error);

  console.log('DEA registration follows the patient’s location');
  const caCheck = await attempt(() => provider.createResource(buildPdmpTask({ patient: p, practitioner: me, state: 'CO', result: 'no-concerns' })));
  const co = await attempt(() => provider.createResource(rx({ ...stim, state: 'CO' }, caCheck.value?.id)));
  report(!co.ok && /no active DEA registration in CO/.test(co.error ?? ''), 'No DEA registration in CO: controlled prescription refused', co.error);
  const riCheck = await attempt(() => provider.createResource(buildPdmpTask({ patient: p, practitioner: me, state: 'RI', result: 'no-concerns' })));
  const ri = await attempt(() => provider.createResource(rx({ ...stim, state: 'RI' }, riCheck.value?.id)));
  report(!ri.ok && /no active DEA registration in RI/.test(ri.error ?? ''), 'Expired RI DEA registration: controlled prescription refused', ri.error);
  const adminSend = await attempt(() => practiceAdmin.createResource(rx(draft())));
  report(!adminSend.ok && /prescriber named/.test(adminSend.error ?? ''), 'Administrator cannot send a prescription in the provider’s name', adminSend.error);
  const serviceSend = await attempt(() => admin.createResource(rx(draft())));
  report(!serviceSend.ok && /prescriber named/.test(serviceSend.error ?? ''), 'A service client cannot send a prescription', serviceSend.error);

  console.log('Access and transmission state');
  const fakeSent = buildMedicationRequest(draft(), { patient: p, requester: me, send: true });
  fakeSent.extension = [...(fakeSent.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'sent' }];
  const claimed = await attempt(() => provider.createResource(fakeSent));
  report(!claimed.ok, 'Provider cannot mark a prescription as already sent (worker only)', claimed.error);
  const fdRead = await attempt(() => frontdesk.searchResources('MedicationRequest', { subject: `Patient/${patient.id}` }));
  report(!fdRead.ok || (fdRead.value ?? []).length === 0, 'Front desk cannot read prescriptions', fdRead.error ?? `${fdRead.value?.length} visible`);
  const fdWrite = await attempt(() => frontdesk.createResource(rx(draft())));
  report(!fdWrite.ok, 'Front desk cannot create prescriptions', fdWrite.error);

  console.log('Worker transmission (mock vendor)');
  const failing = await attempt(() => provider.createResource(rx(draft({ pharmacy: 'FAIL Synthetic Pharmacy' }))));
  const ids = [plain.value?.id, controlled.value?.id, failing.value?.id].filter(Boolean) as string[];
  const pass1 = await processPrescriptions(worker, adapter, mine(ids));
  report(pass1.sent === 2 && pass1.failed === 1, 'Worker sends queued prescriptions and records a rejected one', JSON.stringify(pass1));
  const sentPlain = await admin.readResource('MedicationRequest', plain.value?.id as string, { cache: 'no-cache' });
  report(erxStatus(sentPlain) === 'sent' && !!sentPlain.identifier?.length, 'Sent prescription carries the vendor id', sentPlain.identifier?.[0]?.value);
  const statement = await admin.searchOne('MedicationStatement', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|rx-${plain.value?.id}` }, { cache: 'no-cache' });
  report(statement?.status === 'active', 'Sent prescription appears on the chart medication list');
  const failTask = await admin.searchOne('Task', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|erx-failure-${failing.value?.id}` }, { cache: 'no-cache' });
  report(failTask?.priority === 'urgent' && failTask.owner?.reference === `Practitioner/${prac.id}`, 'Failed transmission creates an urgent task for the prescriber');
  const pass2 = await processPrescriptions(worker, adapter, mine(ids));
  report(pass2.sent === 0 && pass2.failed === 0, 'A second worker pass sends nothing again', JSON.stringify(pass2));

  console.log('After sending');
  const changed = await attempt(() => provider.updateResource({ ...sentPlain, dosageInstruction: [{ text: 'Take 2 tablets daily' }] }));
  report(!changed.ok && /cannot be edited/.test(changed.error ?? ''), 'A sent prescription cannot be edited', changed.error);
  const cancel = { ...sentPlain, status: 'cancelled' as const, extension: [...(sentPlain.extension ?? []).filter((e) => e.url !== EXT.erxStatus), { url: EXT.erxStatus, valueCode: 'cancel-requested' }] };
  const cancelled = await attempt(() => provider.updateResource(cancel));
  report(cancelled.ok, 'Provider requests cancellation', cancelled.error);
  const pass3 = await processPrescriptions(worker, adapter, mine(ids));
  const after = await admin.readResource('MedicationRequest', plain.value?.id as string, { cache: 'no-cache' });
  const stopped = await admin.searchOne('MedicationStatement', { identifier: `${DERIVED_IDENTIFIER_SYSTEM}|rx-${plain.value?.id}` }, { cache: 'no-cache' });
  report(pass3.cancelled === 1 && erxStatus(after) === 'cancelled' && stopped?.status === 'stopped', 'Worker completes the cancellation and stops the chart medication', JSON.stringify(pass3));
  const reactivate = await attempt(() => provider.updateResource({ ...after, status: 'active' }));
  report(!reactivate.ok, 'A cancelled prescription cannot be reactivated', reactivate.error);

  console.log('Renewal requests (P26)');
  const renewal = await attempt(() => frontdesk.createResource(buildRenewalTask({ patient: p, prescriber: me, prior: createReference(sentPlain), medication: 'Sertraline', from: 'Synthetic Pharmacy (fax)' })));
  report(renewal.ok && !!renewal.value?.restriction?.period?.end, 'Front desk records a faxed renewal request with a 2-business-day due date', renewal.error);
  const fdDeny = await attempt(() => frontdesk.updateResource({ ...(renewal.value as Task), status: 'rejected', statusReason: { text: 'A non-provider should not deny clinical treatment' } }));
  report(!fdDeny.ok, 'Front desk cannot deny a clinical renewal request', fdDeny.error);
  const fullUrl = `urn:uuid:${crypto.randomUUID()}`;
  const done = await attempt(() => provider.executeBatch({ resourceType: 'Bundle', type: 'transaction', entry: [
    { fullUrl, resource: buildMedicationRequest(draft(), { patient: p, requester: me, send: true, basedOn: createReference(sentPlain) }), request: { method: 'POST', url: 'MedicationRequest' } },
    { resource: { ...(renewal.value as Task), status: 'completed', businessStatus: { text: 'Approved' }, output: [{ type: { text: 'prescription' }, valueReference: { reference: fullUrl } }] }, request: { method: 'PUT', url: `Task/${renewal.value?.id}`, ifMatch: `W/"${renewal.value?.meta?.versionId}"` } },
  ] }));
  report(done.ok, 'Renewal approval and new prescription are committed atomically', done.error);
  const queue = await provider.searchResources('Task', { owner: `Practitioner/${prac.id}`, code: `${CODE_SYSTEMS.taskCode}|rx-renewal`, status: 'requested' }, { cache: 'no-cache' });
  report(!queue.some((t) => t.id === renewal.value?.id), 'Approved request leaves the open queue');
}

async function cleanup(admin: MedplumClient, patient: Patient): Promise<number> {
  let n = 0;
  const subject = `Patient/${patient.id}`;
  for (const type of ['MedicationStatement', 'MedicationRequest', 'Task'] as const) {
    for (const r of await admin.searchResources(type, { subject, _count: '200' }, { cache: 'no-cache' })) {
      if ((await attempt(() => admin.deleteResource(type, r.id as string))).ok) n++;
    }
  }
  if ((await attempt(() => admin.deleteResource('Patient', patient.id as string))).ok) n++;
  return n;
}

main().catch((err: unknown) => {
  console.error(normalizeErrorString(err));
  process.exit(1);
});

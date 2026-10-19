# Phase 5 verification: e-prescribing and PDMP (vendor-neutral)

17 October 2026 audit: [findings, corrections and release gates](phase-5-6-audit.md). Current evidence: 18 regression tests and 34 local API checks passed. The earlier evidence below records the original implementation run.

Built locally: 16 October 2026. Status: **built for synthetic review; vendor integration pending**. No e-prescribing vendor has been contracted. iPrescribe's $30/month plan is its standalone app. EHR integration is in its custom-priced Enterprise tier, and no public developer API was found. Every rule below runs now. Transmission goes through a mock adapter, so no prescription reaches a pharmacy.

## What was built

| Area | Delivered |
|---|---|
| Rules engine (`packages/core/src/prescribing.ts`) | Shared by the form, the server Bot and the worker. It requires a catalogue drug, sig, quantity, 1–90 days' supply and a pharmacy. It also checks:<br>• licence and prescriptive authority in the state where the patient is located<br>• an active DEA registration in that state that covers the drug's schedule (2/2N/3/3N/4/5)<br>• refill limits: none for C-II, up to 5 for C-III–V, up to 11 otherwise<br>• for controlled drugs, the prescriber's own PDMP check for that state within 24 hours |
| `prescription-rules` pre-commit Bot | Re-runs the rules on every send and on every retry after a failure, for every client including admins. It also enforces:<br>• the controlled schedule is derived from the drug on the server<br>• the PDMP check cited must be current and the prescriber's own<br>• only the prescriber named on the prescription can send it<br>• a sent prescription is locked; only cancel or stop is allowed, and cancelled stays cancelled |
| `task-rules` pre-commit Bot (was `pdmp-rules`) | A PDMP check must:<br>• name a state and a result<br>• be recorded at the time of review (no backdating)<br>• be owned by, and only changeable by, the reviewing provider<br>• stay unchanged once completed, apart from being marked entered-in-error |
| Access policy | Providers can queue a prescription or request cancellation, but cannot mark it sent, failed or cancelled. Only the worker can. Front desk and billers have no prescription access. |
| Worker (`services/worker/src/erx.ts`) | The `ErxAdapter` interface (`ERX_VENDOR=mock` by default) moves a prescription through queued → sending → sent or failed. Cancellation follows cancel-requested → cancelled.<br>• Uses an idempotency key and If-Match concurrency control.<br>• A sent prescription is written to the chart medication list, which also triggers the existing lab-monitoring task.<br>• A failure creates an urgent task for the prescriber.<br>• Cancelling stops the chart medication. |
| UI | • **Prescribe** form from the chart's Medications tab and from the visit. It shows live rule explanations, an inline PDMP review record, a sandbox banner and the server's error if it refuses.<br>• **Prescriptions** card with each prescription's status, plus send draft, retry, renew, cancel and discard.<br>• **P25 E-prescribing** page: items needing attention, sent prescriptions and PDMP checks.<br>• **P26 Refill requests** page: record phone or fax requests; approve (by sending a renewal), deny with a reason, or escalate. It tracks the 2-business-day due date and shows overdue requests.<br>• The Today page's **Refill requests** queue now shows a live count. |
| Seed | The synthetic provider now has DEA registrations: WA (all schedules), CA (no C-II narcotics), RI (expired), and none for CO. |

## Run locally

```powershell
npm run setup -- --erx-only   # policies, Bots, worker access; then sign out and back in
npm run seed                  # adds the synthetic DEA registrations once
npm run worker                # transmits queued prescriptions through the mock adapter
npm run dev
npm run test:phase5
npm run verify:phase5
```

## Evidence (16 October 2026)

| Check | Result |
|---|---|
| Phase 5 regression tests | 13 passed |
| Phase 5 checks against local Medplum (real role logins, deployed Bots, worker) | 31 passed |
| Phases 1–4 regression tests and server checks | All passed again; the new Task pre-commit Bot doesn't affect other Tasks |
| Typecheck and build | Passed |

## Your checklist (synthetic patients only)

1. Sign in as provider. Open a patient's **Medications** tab and choose **Prescribe**. Sertraline in WA should show "All prescribing checks pass". Send it. Within a minute the status changes to **Sent (sandbox)**, and the drug appears in the medication list.
2. Choose **Lisdexamfetamine**. Send stays blocked until you record a WA PDMP check. Refills are capped at 0.
3. Change the state to **CO** and then **RI**. Both are blocked: CO has no DEA registration and RI's has expired. **TX** is blocked as unlicensed.
4. Use a pharmacy name containing **FAIL**. The status becomes **Not sent**, and an urgent task appears under My tasks. **Retry** re-checks every rule.
5. Cancel a sent prescription. It ends **Cancelled**, and the medication moves to Past.
6. As front desk, open **Refill requests → Record request**. Then, as provider, approve it (the form opens pre-filled), deny one with a reason, and escalate one.
7. From a visit, choose **Prescribe**. The state defaults to the visit's location check.

## Still required before real prescribing

- **Contract a certified eRx/EPCS vendor** with an EHR API: iPrescribe Enterprise, DoseSpot or another partner. Then build its adapter for:
  - transmission
  - cancellation
  - RxRenewal and RxChange messages
  - pharmacy directory and drug database (RxNorm/NDC)
  - medication history
- **EPCS**, done through the vendor:
  - identity proofing and two-factor signing
  - logical access control
  - the certification audit for the host application, where the vendor requires it
- **PMP Gateway (Bamboo Health)** through the vendor or state programs. Until then, providers review each state's PDMP website and record the result.
- **Rule review by the clinical owner:**
  - state-specific PDMP mandates and exemptions
  - partial fills
  - C-II multiple-prescription rules
  - current DEA telemedicine rules for controlled substances
  - holidays in the 2-business-day SLA, which currently counts weekdays only
- **Medplum pre-commit behaviour:** the server runs only the first matching pre-commit Bot per resource type. A future second pre-commit Bot on `Task` or `MedicationRequest` must be merged into the existing one.

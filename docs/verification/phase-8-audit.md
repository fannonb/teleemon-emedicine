# Phase 8 implementation review

Review date: 18 October 2026. **The findings below describe the initial audit. The identified defects have since been corrected and verified locally; see [remediation evidence](phase-8-fixes.md).** Verification used synthetic records, a mock payer and disposable ledger databases. Live clearinghouse acceptance remains outstanding.

## Verdict

Phase 8 is substantially implemented as a local synthetic revenue-cycle system, but it is not ready for real billing. The ledger foundation, server-side claim/charge validation and regression coverage are useful. Three financial correctness defects require correction, and the clearinghouse integration has not passed the plan's actual Stedi test-payer acceptance gate.

## Findings

### P1 — Replacement claims bypass duplicate protection

`bots/src/claim-rules.ts:102–105` treats any related reference beginning `Claim/` as a replacement and skips the one-live-claim rejection. The original claim is not read or checked for matching patient, encounter, payer, status or replacement eligibility. `packages/core/src/billing.ts:386–390` checks only that a frequency-7 claim supplies a reference.

A crafted relation to an unrelated or nonexistent claim can allow another live claim for the same visit, risking duplicate billing. Validate the original and replacement frequency, enforce matching clinical/billing context, and allow only the intended replacement relationship. Add direct-API negative tests and concurrent duplicate-submission tests.

### P1 — Concurrent refunds/credits can exceed available funds

`services/ledger/src/index.ts:126–128` checks available credit and amount owed before applying credit. Lines 135–137 check refund credit before posting. Write-offs have the same external balance-check pattern.

`services/ledger/src/store.ts:132–138, 211–217` creates a serializable posting transaction, but the eligibility/balance reads are outside that transaction and are not repeated inside it. Balanced, append-only journals and unique idempotency keys do not prevent two distinct requests from using the same available credit. The schema does not enforce a nonnegative credit ceiling.

For example, two distinct $100 refund approvals can both observe the same $100 credit and approve $200 in total. Move the relevant balance reads and business limits inside a locked/serializable posting operation. Recheck on retry and test concurrent requests with distinct keys.

### P1 — Payer balances can be transferred to an unrelated patient

`services/ledger/src/index.ts:153–160` accepts separate patient, payer, encounter and claim IDs. It verifies patient readability and an open payer/encounter balance, but does not verify that the supplied patient and claim belong to that encounter or payer. `packages/core/src/ledger.ts:333` builds the posting using these supplied references.

A biller could transfer Patient A's visit balance to Patient B's receivable. Resolve the encounter/claim from FHIR, validate their patient and payer relationships, derive the posting references server-side, and enforce the open-balance ceiling atomically. Test cross-patient, cross-payer and unrelated-claim requests.

These findings were confirmed by source inspection. No exploit transactions were posted to the running ledger during this review.

### Runtime issue — Seeded biller cannot access Charge review

Browser sign-in with `biller@teleemon.test` succeeded as Sam, but no Billing section appeared. Navigating to `/billing/charges` displayed **Your role doesn't include this page**. Current source defines the Phase 8 menu and routes (`apps/staff/src/navigation.ts:132–166`, `App.tsx:80–87`); this is therefore an account/role-resolution or running-instance discrepancy, not proof that the pages are absent. Resolve it and repeat the biller browser checklist before sign-off. The footer also still says Phases 1–7.

[Browser evidence of biller access refusal](phase8-biller-access-review.jpg).

## Documented gaps that also prevent production sign-off

- The Stedi adapter's endpoints and 277CA/835 retrieval paths are unverified/placeholders. Mock-payer acceptance does not meet the implementation plan's Stedi test-payer acceptance criterion.
- Manual 835 posting updates the ledger without updating claim status, leaving work queues potentially inconsistent with the financial record.
- CR corrections/reversals are treated as contractual adjustments; this mapping needs correction/validation before processing actual reversal remittances.
- Billing settings save the complete resource without an If-Match check, so simultaneous editors can overwrite changes.
- Stripe is sandbox/test-mode; billing policies, fee amounts, refund/write-off authority and statement rules still need practice approval. Large A/R queries have a documented cap and require a scaling follow-up.

## Verification performed

| Check | Result |
|---|---|
| `npm run test:phase8` | 116 passed, 0 failed |
| `npm run test:ledger` | 9 passed, 0 failed against a disposable local database |
| `npm run ledger:schema` | 28 invariant checks passed against a disposable local database |
| `npm run typecheck` | Passed across scripts, packages, Bots, services and both apps |
| Staff and portal production builds | Passed; existing bundle-size warnings remain |
| Browser biller workflow | Sign-in succeeded, Charge review refused; full interactive billing checklist could not proceed under this account |
| `npm run verify:phase8` | Not rerun: an active local worker processes the shared Medplum project. The script explicitly requires stopping it and creates persistent synthetic claims/charges. Running both would risk processing test records into the normal local ledger. The prior document reports 58 checks; that is historical evidence, not a fresh result of this review. |

Passing the current suite does not cover the three negative/concurrency cases above. Financial correctness must hold for simultaneous requests and malformed relationships, not only successful sequential workflows.

## Recommended order

1. Fix cross-patient transfers and make financial balance limits atomic.
2. Validate replacement claims and duplicate protection.
3. Reconcile manual ERA posting/status, implement correct reversal handling and protect concurrent settings saves.
4. Run new adversarial tests and the isolated end-to-end billing gate.
5. Validate real Stedi/Stripe test integrations and approve billing policy before production use.

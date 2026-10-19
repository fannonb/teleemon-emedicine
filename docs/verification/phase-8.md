# Phase 8 verification: revenue cycle

Built locally: 18 October 2026. Status: **built for synthetic review. The Stedi test account, Stripe account and practice billing policy are pending.**

Current evidence:

| Command | Result |
|---|---|
| `npm run ledger:schema` | 28 database invariant checks pass |
| `npm run test:ledger` | 23 ledger service and HTTP route tests pass (throwaway database) |
| `npm run test:phase8` | 135 regression tests pass: rules, Bots, worker, access, settings and portal bill pay |
| `npm run verify:phase8` | 65 checks pass against local Medplum, with the mock test payer and a throwaway ledger |

The API suite attempts invalid actions directly, bypassing the apps, and checks server refusals and ledger reconciliation. See [audit fixes and verification](phase-8-fixes.md) for the corrected concurrency, replacement-claim, role and manual-remittance behavior.

Earlier phases still pass after these changes: `verify:phase1` (38), `verify:phase3`, `verify:phase6` (37) and `verify:phase7` (119), plus all unit-test suites.

**Vendors:**
- **Clearinghouse:** a mock test payer. The Stedi adapter switches on when `STEDI_API_KEY` is set. It has not been run against Stedi yet.
- **Cards:** the sandbox adapter. Stripe test mode switches on when Stripe test keys are set.
- **Policy:** write-off and refund rules are placeholders in P40.

## Practice decisions after the build (18 October 2026)

- **Providers do billing work.** Providers see and use P19 and P30–P36 and the financial reports, like billers: navigation, the Provider access policy and the ledger service all allow it. Payers, fees and policy (P40) stay administrator and biller only, and front desk still cannot see charges or finance. `verify:phase8` checks both directions.
- **Missed-visit fees.** Self-pay no-show and late-cancellation fees are set in P40 (default $0, which means no fee). They are posted from the appointment. The ledger checks the visit and the patient's self-pay status, takes the amount from policy, posts once per appointment, and never bills insurance.

## What was built

| Area | Delivered |
|---|---|
| Ledger ([ADR-005](../adr/005-ledger.md)) | • `services/ledger` on port 3130. Posting rules are pure builders in `@teleemon/core` (`ledger.ts`).<br>• Every posting is keyed by its source event: a replay is a no-op, and a replay with different amounts is refused.<br>• Schema v2 records each 835's stated total.<br>• Patient balance, A/R by aging bucket, and reconciliation. |
| Rules (`packages/core/src/billing.ts`, `claimDraft.ts`, `revenue.ts`) | • Payer, fee and policy settings.<br>• Charge capture from the signed note.<br>• 30 claim scrub rules; 5 cannot be switched off.<br>• 835 normalisation and posting plan: it ties to the cent, or the claim goes to exceptions.<br>• Denial categories with appeal deadlines.<br>• Eligibility summary, aging, statements, claim status transitions. |
| Bots | • **charge-capture:** signing a note creates one ChargeItem per billed code. Addenda and notes without a visit code create none.<br>• **charge-rules:** see the rules below. It also keeps work-queue tags, because R4 ChargeItem has no status search.<br>• **claim-rules:** re-runs the scrubber on the server and replaces any client-written result. Submitted claims are locked. One live claim per visit. Payer outcomes only from the clearinghouse. Claims are never deleted. |
| Worker billing pass | Each pass:<br>• posts released charges to the ledger, and reverses charges voided after posting;<br>• sends scrubbed claims as 837P and records 277CA acknowledgements;<br>• stores 835s raw and normalised, auto-posts clean claims, and opens exception and denial tasks. A stored 835 is retried until fully applied;<br>• runs eligibility checks (270/271), including a daily batch for tomorrow's visits;<br>• runs statements as draft Invoices for biller review (a draft waiting for review blocks another one for that patient), sends the patient notice only once a statement is issued, and opens refund and small-balance reviews. |
| Staff app | • **P40** payers, fees, scrub rules and billing policy.<br>• **P30** charge review.<br>• **P31** claims workbench, with a scrub preview.<br>• **P32** eligibility.<br>• **P33** remittance, posting and exceptions.<br>• **P34** denials and appeals.<br>• **P35** statements.<br>• **P36** A/R dashboard with reconciliation.<br>• **P19** patient account: payments, write-offs, credit, refunds and reversals. |
| Portal | **X08** Billing & payments: balance, statements, and pay with the card on file. Hidden from limited proxies. |

### Charge rules (`charge-rules`)

- Status moves in order: planned → billable → billed.
- To be billable, a charge needs a payer, a diagnosis and a whole-cent amount.
- An AI-suggested code is billable only after the rendering provider accepts it.
- Only the worker marks a charge billed or records its ledger posting.
- A posted charge is frozen. A correction is entered-in-error, which the worker reverses, plus a new charge.
- Holds and voids need a reason. Charges are never deleted.

## Run locally

```powershell
npm run setup                     # Bots (charge-capture, charge-rules, claim-rules), policies, LEDGER_INTERNAL_TOKEN
npm run seed                      # adds the practice NPI and tax id, the provider NPI and payer links
npm run ledger:schema -- --apply  # creates or upgrades the local teleemon_ledger (schema v3)
npm run ledger                    # ledger service, port 3130 (keep running)
npm run worker                    # billing pass every minute, with the mock payer (keep running)
npm run dev                       # staff app, http://localhost:3100
npm run portal; npm run dev:portal   # for X08
npm run test:phase8
npm run verify:phase8             # stop the worker first: verify runs its own billing passes
```

Staff sign-ins (password `Teleemon-Local-2026`): `provider@teleemon.test`, `biller@teleemon.test`, `frontdesk@teleemon.test` and `admin@teleemon.test`.

## Checklist (synthetic patients only)

1. **Settings (P40).**
   - As admin or biller, open **Settings → Payers, fees & codes**.
   - Three synthetic payers are listed, the fee schedule shows 99212–99215, 90792 and the add-ons, and five scrub rules are shown locked.
   - The policy tab shows the amber placeholder notice.
2. **Charge capture.**
   - As provider, start and sign a follow-up note for a seeded insured patient (99214, one diagnosis).
   - As biller, **Billing → Charge review** shows the charge as planned, with modifier 95 and the patient's payer.
   - Release it. Within a minute (worker), the patient's **Account** tab shows the charge.
3. **Claim.**
   - In **Claims**, under Ready to bill, create the claim for that visit. The preview lists no errors.
   - Scrub it, then submit it.
   - Within two worker passes, it moves to Accepted and then Partially paid.
   - **Remittance** shows the 835 as Reconciled: payer total equals cash posted.
4. **Patient share.**
   - The patient's Account shows $25.00 owed (the mock copay).
   - As front desk, record a $30 cash payment. The account shows $5.00 credit.
   - As biller, approve a $5 refund and mark it paid. Credit returns to $0.
5. **Denial.**
   - Give another insured synthetic patient a coverage member ID starting with `DENY`, then bill a visit.
   - **Denials** shows the claim with an appeal deadline.
   - Write down the payer balance as "denial-final", or transfer it to the patient.
   - A member ID starting with `REJ` produces a claim-rejected task instead.
6. **Eligibility.**
   - In **Eligibility**, check a coverage with member ID `INACTIVE…`: an eligibility task appears for the biller.
   - Check a normal coverage: active, $25 copay.
7. **Statements.**
   - In **Statements**, run statements.
   - A draft for the patient from step 4 appears under **Statements to review**. Its amount equals their Account balance.
   - Nothing is in the outbox yet, and the portal does not show the draft.
   - Choose **Issue**. Within a minute, the outbox (`services/worker/outbox.log`) has one "new statement" notice with no amounts, and the statement appears in the portal.
8. **A/R dashboard.**
   - **A/R dashboard** totals equal the sum of the patient and payer balances.
   - The Reconciliation panel shows every check green and "Ties to the ledger".
9. **Bill pay (X08).**
   - Sign in to the portal as `maya.thornton@example.com` (after `npm run portal:demo`) with a sandbox card on file and a balance.
   - Open **Billing & payments** and pay part of the balance. The staff Account tab shows the card payment.
   - Sign in as limited proxy `emily.bennett@example.com`: there is no Billing entry.
10. **Server refusals (`npm run verify:phase8` proves each one through the API):**
    - releasing a charge without a diagnosis;
    - a biller accepting an AI-suggested code;
    - marking a charge billed by hand;
    - re-pricing a posted charge;
    - a forged clean scrub result;
    - submitting without scrubbing;
    - two live claims for one visit;
    - editing a submitted claim;
    - a biller recording a payer outcome;
    - front desk writing off;
    - small-balance write-offs over $5.00;
    - courtesy and timely-filing write-offs by a non-administrator;
    - refunds over credit held;
    - double reversal;
    - a statement notice before the statement is issued;
    - internal ledger calls without the service token.

## Known limits and follow-ups

- **Stedi.**
  - The adapter's endpoints are unverified, and the 277CA/835 retrieval paths are placeholders.
  - With a test key, confirm the endpoints, set the Stedi test payer's trading-partner ID in P40, and check that Stedi treats CLM01 (the Claim id) as a duplicate key.
  - Webhooks are a deployment item; locally the worker polls.
- **Manual 835 posting (P33)** atomically queues a durable Claim status projection with the journal. The worker applies it with version checks. Conflicting, newer, denied, closed or reversed states require review rather than being overwritten.
- **CR adjustments** (correction and reversal group) are held for manual review without an automatic journal. Automatic correction/reversal processing remains a follow-up.
- **Billing settings** use version-checked saves and conditional creation; a stale editor must reload before saving.
- **A/R scale.** The A/R report reads up to 10,000 entries, and a completeness check flags truncation. Move aging into SQL before real volume.
- **Verification data.** Verification charges and claims stay on the "Billing Verification" patients, because charges and claims can never be deleted.

## Still required before real use

- A Stedi account (test, then production), the payer list and enrollment (ERA/EFT).
- A Stripe account and a payment-processing review.
- Practice decisions:
  - small-balance threshold;
  - refund timing;
  - who approves write-offs;
  - statement cycle and minimum;
  - whether clean ERAs auto-post.
- D5 billing staffing.
- A billing advisor's review of the scrub rules and fee schedule (synthetic amounts today).

# Phase 8 audit remediation

18 October 2026. **Corrected and verified locally with synthetic data. Live billing acceptance is still pending.** The original findings are retained in [the audit](phase-8-audit.md).

## Corrections

- Replacement claims now validate the original, relationship, patient, encounter, payer and eligible status. Invalid or competing live claims are refused during server validation.
- Refunds, credit application, write-offs, payer transfers and receipts read balances inside their posting transaction. Concurrent requests retry and recheck limits; exact successful replays remain idempotent. Receipt splitting between debt and held credit is also atomic.
- Payer adjustments, transfers and manual ERA posting verify the related patient, encounter, claim, coverage and charges before posting.
- Manual ERA journals queue a durable Claim status projection in the same transaction (schema v3). The worker uses version checks and acknowledges successful projections. Failed updates remain pending; conflicting or terminal states produce review tasks. The HTTP response remains compatible with the remittance screen.
- CR correction/reversal adjustments become manual exceptions without an automatic journal, rather than being misclassified as contractual adjustments.
- Staff roles come from the effective authenticated access policy. Missing or unknown policies no longer default to provider. The biller can open Charge review; loading and session failures are explicit.
- Billing settings use version-checked updates and conditional creation. Stale saves require reloading instead of overwriting another editor.

## Verification

| Check | Result |
|---|---|
| Phase 8 regression tests | 135 passed |
| Ledger store and HTTP route tests | 23 passed |
| Ledger schema invariants | 28 passed |
| Local Medplum/API verification | 65 passed, 0 failed |
| Earlier-phase regression tests | 104 passed |
| Workspace typecheck | Passed |
| Staff and portal production builds | Passed; existing bundle-size warnings |

API evidence: [verification log](phase8-fixes-api.log). Browser verification confirmed that the synthetic biller can open Charge review and see the billing navigation ([screenshot](phase8-biller-access-fixed.jpg)). The A/R dashboard loaded and reported all reconciliation checks passing against the current empty local ledger. No financial actions were taken through the browser.

Corrected Bots and policies were deployed locally and the additive schema v3 migration was applied. Local ledger and worker services were restored. Verification uses a mock clearinghouse and sandbox payments; no live vendor submission was made. Verification charges/claims remain on synthetic verification patients because those resources are not deleted.

## Remaining release gates

- Validate the actual Stedi endpoints, trading-partner enrollment, 277CA/835 retrieval, duplicate handling and test-payer round trip; current retrieval paths remain placeholders.
- Validate Stripe test-mode flows and production payment configuration.
- Approve practice billing policies, fee schedule, write-off/refund authority and statement timing with the billing team.
- Review correction/reversal exceptions manually; automatic CR processing is not implemented.
- Move aging/report aggregation into SQL before exceeding the current 10,000-entry A/R read limit; the completeness warning remains.

These fixes support continued synthetic review. They do not certify production billing or regulatory readiness.

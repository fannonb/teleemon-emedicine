# ADR-005: Double-entry ledger in PostgreSQL

Status: **Accepted** (schema in Phase 7, 17 October 2026; service, posting rules, schema versions 2–3 and reconciliation in Phase 8, 18 October 2026).

## Context

Billing must reconcile to the cent: posted totals must equal ERA totals, and the A/R dashboard must tie to the ledger after every posting. FHIR ChargeItem, Claim and ClaimResponse describe billing documents, but they cannot enforce multi-row invariants such as "every posting balances", nor append-only history.

## Decision

A dedicated PostgreSQL database (`teleemon_ledger`), separate from the FHIR store, owned by the ledger service. The schema is `services/ledger/schema.sql`, version 1:

- `account`: patient receivable and credit (per patient), insurance receivable (per payer), and practice accounts (cash, card clearing, revenue, contractual adjustment, write-off, refund payable). Each kind requires the right owner. There is one account per kind and owner.
- `journal`: one posting, with a unique **idempotency key** per source event (ERA line, Stripe charge, ChargeItem), and an optional `reverses` link.
- `entry`: integer cents. Debits are positive and credits negative, with optional Encounter, Claim and ChargeItem references (FHIR ids only, never names or clinical content).

The database enforces the invariants:

1. A journal's entries sum to zero, checked when the transaction commits (a deferred constraint trigger).
2. Every journal has at least two non-zero entries.
3. Journals and entries are append-only: update, delete and truncate are refused by triggers, even for the owner. Corrections are reversal journals that must exactly mirror the original, and a journal can be reversed only once.
4. The `ledger_service` role may only insert and read; `ledger_reader` may only read.

The views `account_balance` and `patient_balance` give balances directly from entries.

## Phase 8: the service (version 2)

Audit remediation adds **schema version 3**: `claim_projection` is a durable outbox inserted atomically with manual ERA journals. The service can read/insert jobs and update only their completion timestamp. Financial journals remain append-only. Balance-limited posting and receipt splitting perform their reads within the serializable posting transaction, with retry and idempotent replay handling. See [verification](../verification/phase-8-fixes.md).

- **Schema version 2** adds `remittance`: one append-only row per 835 with the payer's stated total (BPR02), so reconciliation can prove that the cash posted under a trace number equals what the payer says it paid.
- **Posting rules** live in `@teleemon/core` (`packages/core/src/ledger.ts`) as pure builders. Each one turns one event into one balanced journal draft:
  - a charge for each ChargeItem version (a re-priced charge reverses the earlier version in the same transaction);
  - an 835 claim payment, posted atomically: cash, contractual write-down and patient share all leave the payer receivable together;
  - a patient payment, with any overpayment held as credit;
  - write-off, credit applied, refund approved and paid, card payout, transfer to patient, and exact reversal.
- **The service** (`services/ledger`, `npm run ledger`, port 3130):
  - persists drafts unchanged as the `ledger_service` role (`set role` on every connection);
  - treats a replay of the same key as a no-op, and refuses a replay with different amounts (409);
  - serves the A/R report and reconciliation (`reports.ts`). Open items are built per visit and oldest first, and always sum to the account balances.
- **Callers:**
  - Staff send their Medplum token. Roles come from the policies Medplum applied to the session (`auth/me` → `accessPolicy.basedOn`).
  - The worker and portal send `LEDGER_INTERNAL_TOKEN`, which `npm run setup` creates.
- **Policy placeholders** (P40), pending a practice decision:
  - small-balance write-offs up to $5.00 by a biller;
  - other write-offs by an administrator only;
  - credits older than 30 days go to a refund-review task;
  - refunds are approved by a biller.
  - Nothing moves money automatically except clean ERA auto-posting.
- **Not yet decided:** CR (correction/reversal) adjustment groups are booked as contractual adjustments. A billing advisor should confirm this before go-live.

## Verification

`npm run ledger:schema` applies the schema to a throwaway database, proves each invariant (28 checks), and drops the database. `npm run test:ledger` exercises the service against another throwaway database, and `npm run verify:phase8` runs the whole claim-to-cash flow with reconciliation after every posting. `npm run ledger:schema -- --apply` creates or upgrades the local `teleemon_ledger`.

## Consequences

- Phase 8 builds the ledger service: posting rules for charges, ERA payments, adjustments, Stripe payments and refunds, plus statements and the A/R dashboard. It uses the schema unchanged, or with a version 2 migration.
- Reporting reads a replica (ADR-010). Nothing in the ledger identifies a patient beyond the FHIR id.
- Holding credit balances and refunds still needs practice policy: refund timing and the small-balance threshold. Phase 8 ships configurable placeholders.

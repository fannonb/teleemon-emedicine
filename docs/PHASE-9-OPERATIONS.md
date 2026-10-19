# Phase 9 local operations and acceptance

No go-live is authorized. Do not perform production cutover, import real patient exports, enable live messaging/payments or enroll vendors as part of these procedures.

## AdvancedMD staging and migration

The source export format and history scope must be agreed with the practice. `teleemon-advancedmd-v1` is an explicit normalized bridge contract, not a claim that arbitrary AdvancedMD files can be imported unchanged. The current contract covers demographics and historical appointments only; insurance, balances, signed notes, clinical history, providers and active scheduling require separately reviewed mapping.

1. Map a copy of the source export into JSON matching `docs/verification/advancedmd-synthetic.json`. Preserve stable source identifiers. Birthdays use YYYY-MM-DD, timestamps require timezones, statuses must be mapped explicitly, and every appointment references a patient in the batch.
2. Run `npm run migration:validate -- <file.json>` offline. It returns source/accepted counts and row/field errors without printing patient values. Correct every error; the validator never imports data.
3. For synthetic local rehearsal only, run `npm run migration:rehearse -- docs/verification/advancedmd-synthetic.json --synthetic-local`. The importer refuses non-loopback servers, non-synthetic IDs and active appointments. A single conditional-create transaction preserves identifier-based idempotency; different existing target content is refused rather than overwritten. Read-back counts must match the source.
4. Re-run the same fixture to verify replay behavior. Real migration and cutover remain prohibited until source mapping, restricted-chart enforcement, clinical validation, backup/rollback, the broader integration audit and explicit owner approval are complete.

## Recovery rehearsal

`npm run recovery:rehearse` creates two uniquely named disposable local databases, builds a synthetic ledger fixture, dumps it, restores it and compares counts and hashes. It cleans up only those databases. It does not touch the operational ledger. The archive and measured report are written under `docs/verification/phase9-*`.

The target is RPO 15 minutes and RTO 4 hours. The fixture rehearsal validates the tools and integrity only; it cannot establish production RPO or RTO. Production acceptance must recover the FHIR database, ledger, object storage (audio/documents), keys/configuration and background-job state together, verify journal reconciliation, test identity/authorization and restore a point-in-time transaction. Record backup age, last recoverable write, end-to-end restore time and approver. Verify scheduled backups and WAL retention, encrypted/offsite recovery, denied audit modification and read-replica lag. Do not mark this complete using the fixture timing alone.

## Training and parallel-run preparation

Use synthetic accounts and patients. Train the front desk on patient matching, waitlist/recall follow-up, scheduling location checks and check-in; providers on encounter documentation, scribe review, signing, prescribing and lab review; billers on charge review, claim exceptions, manual remittance, refunds and reconciliation; administrators on access review, audit search, integration failures and evidence-based compliance tracking.

For each role, record trainer, date, scenarios attempted, pass/fail, evidence and unresolved issues. Exported data must be authorized and audited. A successful demo is not a completed production training program.

The later 2–4 week parallel run needs a named owner and daily source/target comparisons: patients/appointments, signed notes, charge totals, payer/patient balances, receipts/refunds, remittances, messages and lab/refill queues. Maintain discrepancy IDs, owner and resolution. Any mismatch in patient identity, restricted access, clinical content or money blocks cutover.

## Cutover remains deferred

No DNS change, production migration, live credentials, vendor enrollment, real outbound messages, final source-system freeze or retirement is part of this implementation. After Phase 9 local verification, perform the requested integration-gap audit and approve the remaining external/security acceptance activities before planning a launch.

# Phase 5 and 6 implementation audit

Audit date: 17 October 2026. Scope: implementation plan, shared rules, access policies, pre-commit and subscription Bots, workers, staff UI, regression tests, and local Medplum workflows using synthetic data.

## Assessment

Both phases have working local foundations, but neither represents a completed production integration. Significant authorization, state-transition, patient-linking, retry, and UI-state defects were corrected during this audit. The corrected Bots and role policies were applied to local Medplum.

Phase 5 implements local prescribing decisions and a mock transmission workflow. Phase 6 implements the unified inbox, manual lab workflow, tasks and sandbox fax processing. Embedded vendor eRx/EPCS, vendor RxChange/renewal messages, real fax delivery, and AI fax classification remain incomplete integration work; they must not be represented as delivered production features.

## Corrections made

| Area | Finding and correction |
|---|---|
| Prescribing authorization | Front desk could record a PDMP check under its own Practitioner profile or resolve a clinical renewal. Policies now reject these actions; recording an administrative renewal no longer requires prescription access. |
| Prescription integrity | Alternate statuses could evade initial validation; direct transmission transitions and edits to clinical instructions were insufficiently protected. Added explicit status transitions, immutable clinical content, named-prescriber checks, positive finite quantity validation and single transmission-status validation. |
| PDMP | A recorded decision not to prescribe could still pass the shared checks. It now blocks sending. The form uses only the current prescriber's checks, matching server enforcement. |
| Dispatch and recovery | Worker dispatch did not revalidate current credentials and missed old queues/later pages. Added dispatch-time checks, pagination, concurrency leases, cancellation recovery, and idempotent repair of chart medications after interrupted processing. |
| Renewal approval | Creating a prescription and closing its renewal were separate writes. They now commit in one transaction with a version check. |
| Patient and lab linkage | A result could point to another patient's order or have its reviewed file replaced. Same-patient linkage, immutable review/file content, completed-file checks and reasoned withdrawal are enforced. |
| Review-task bypass | Completing a task directly could remove a result or fax from the queue without reviewing/filing the source. Server checks now require the source action. Result processing rereads the current document and uses version checks for derived updates. |
| Messages | Removing the patient-message category or unlinking a matched patient could bypass safeguards. Updates now preserve identity and require a closure note. |
| Prior-state reads | Catching every read failure as a nonexistent record could bypass update locks during an outage. Only a genuine not-found outcome permits create behavior. |
| Recurring tasks | Unknown rules and invalid dates could cause unsafe scheduling; month arithmetic drifted past short months. Rules/dates are validated, month ends clamp, and overdue recurrences schedule from completion without an unbounded catch-up loop. Holidays remain unimplemented. |
| Fax intake and delivery | Interrupted uploads could leave a fax permanently incomplete. Redelivery now repairs attachments and review tasks. Added PDF/size validation, bounded webhook bodies, private-document exclusions, authenticated local attachment-origin checks and versioned dispatch claims. |
| Queue completeness | Unified inbox, inbound fax and refill queues and worker scans follow search pages rather than silently stopping at their first page. Historical sent/removed fax views and some chart/history lists still have bounded queries; server-side pagination is a future scale improvement. |
| Staff workflow | Forms reset between records, unchanged task due timestamps are preserved, patient/category changes clear fax confirmations and order links, preview failures are visible, and filing waits for a loaded preview. Multiple lab orders now save atomically with a busy state. The mobile patient header no longer sticks over lab action buttons. Sandbox fax status and outdated phase text were corrected. |

## Verification

| Check | Result |
|---|---|
| Phase 5 regression tests | 18 passed |
| Phase 6 regression tests | 19 passed |
| Phase 5 deployed local API checks | 34 passed, 0 failed |
| Phase 6 deployed local API checks | 37 passed, 0 failed, including multi-order transaction commit and rollback |
| Earlier regression suites | Phase 1: 8; Phase 3: 14; Phase 4: 21 passed |
| Earlier deployed API workflows | Phases 1–4 passed; Phase 1: 38 checks, Phase 4: 15 checks |
| Type checking and production build | Passed; existing Vite bundle-size warning remains |
| Browser smoke review | Local synthetic provider sign-in, prescribing sandbox, inbox, task form, fax queue, patient chart and labs checked. Browser access initially failed, then succeeded after the user's environment fix. This is a focused smoke check, not exhaustive browser automation or accessibility certification. |

## Remaining release gates

- Contract a vendor and validate its real embedded prescribing, pharmacy directory, medication database, EPCS identity proofing/MFA, PDMP access, RxChange/renewal events and medication writeback in its sandbox. The mock adapter's behavior is not proof of real vendor delivery or EPCS compliance.
- Build real fax transport, authenticated vendor callbacks, reconciliation/idempotency for ambiguous delivery outcomes, a cover page and OCR integration. Current outbound transport only logs. The existing patient/category suggestions are local rules, not AI classification.
- Electronic lab connectivity remains Phase 9; the current workflow prints requisitions and reviews PDF/image reports as documents.
- Validate clinical/legal configuration, state-specific prescribing requirements, holidays/SLA policy and production BAAs before handling real records. This audit is a software correctness review, not a HIPAA or prescribing-law certification.
- Validate GCP storage-origin handling, deployment isolation, multi-instance worker behavior and crash recovery against the chosen live vendors. Current worker attachment-origin checks cover the local Medplum storage paths. External service idempotency and reconciliation must be part of each live adapter.
- Daily summary delivery uses local counts-only transport; verify vendor delivery deduplication before enabling real email. Large historical lists and bundle splitting remain performance follow-ups.

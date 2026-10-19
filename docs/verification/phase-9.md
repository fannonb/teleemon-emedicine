# Phase 9 verification

Local implementation and synthetic verification only. **No production go-live, cutover, real-patient import or vendor activation is authorized.** See [implementation plan](../PHASE-9-IMPLEMENTATION.md) and [operations procedures](../PHASE-9-OPERATIONS.md).

## Delivered scope

- P37: a documented 24-report catalogue, date filters, role-filtered operational reports, server-authorized financial reports, paging/completeness warnings and audited CSV exports. Financial amounts come from the ledger; current reconciliation reads one repeatable-read snapshot.
- P06: waitlist requests, availability matching and explicit booking through the existing scheduling checks; internal recall tasks with patient/consent checks and suppression when a future visit is already booked. No automatic outreach is introduced.
- P27: a practice-wide queue for existing lab orders, manually supplied result documents and review/monitoring tasks. This is not a live HL7 connection.
- P44: observed local health signals, unknown/unconfigured vendor states and evidence-backed BAA attestations. No credentials are displayed, and an attestation is not independent verification.
- P45: audit search, failure/restricted-access alerts and evidence-backed compliance tracking. Chart section views wait for their audit event to be recorded; a pre-commit Bot prevents audit modification/deletion, including by administrators.
- Offline AdvancedMD staging validator and explicitly synthetic local import/replay tooling with source/target count reconciliation. The normalized format is a defined bridge contract, not universal AdvancedMD export support.
- Synthetic PostgreSQL restore rehearsal with count/hash comparison, plus training and parallel-run preparation runbooks.
- Local-only Metabase/read-only analytics configuration examples under `infra/analytics`; no replica or external analytics instance has been deployed.

## Verification evidence

| Verification | Result |
|---|---|
| Phase 9 regression tests | 31 passed |
| Local Phase 9 API checks | 33 passed, 0 failed |
| Ledger store/HTTP regression tests | 24 passed |
| Portal regressions / local API checks | 27 / 120 passed |
| Workspace TypeScript checks | Passed |
| Staff and portal production builds | Passed; existing bundle-size warnings |

Recorded API results: [phase9-api.log](phase9-api.log). Restore measurement: [phase9-recovery.json](phase9-recovery.json). The synthetic restore matched account/journal/entry counts and hashes; these timings do not establish production RPO/RTO. Synthetic imports matched patient/appointment source counts, replayed without duplication, and refused differing target content.

Browser checks confirmed the operational report catalogue/results, financial report loading, audit history paging beyond the first 200 records, integration/evidence status display and the waitlist queue. The role API checks also prove that ordinary staff cannot forge or read compliance/control records and administrators cannot modify their recorded attestations. A live lab vendor was not exercised.

## Explicit remaining acceptance gates

- **Restricted-chart isolation:** ordinary staff APIs currently apply role permissions but do not enforce patient-compartment security labels with time-limited break-glass grants. The current restricted-chart reason dialog is a UI gate. Audit instrumentation and alerts do not close that authorization gap. A mediated compartment/grant architecture and direct-API penetration checks are required before restricted real-patient records are used.
- **Analytics deployment:** create and validate the approved reporting replica/views, identity restrictions, minimum-necessary access and lag monitoring before deploying Metabase.
- **Real migration:** agree history scope and source mapping, validate representative exports, resolve identity/clinical/accounting discrepancies and approve rollback before any real import. Only synthetic rehearsals ran.
- **Full-system recovery:** rehearse FHIR, ledger, object storage, secrets and job-state recovery together at representative volume. Demonstrate RPO 15 minutes/RTO 4 hours using actual backup/PITR evidence.
- **External acceptance:** the lab interface is conditional; vendor connectivity/contracts/BAAs and the broader integration-gap audit remain separate. No penetration-test attestation, workforce training completion or 2–4 week parallel run is claimed.
- **Cutover:** deferred by the owner. No launch, DNS change, live payment/message activation or source-system retirement occurred.

This report distinguishes local features from external/security acceptance. It is not a declaration of production or regulatory readiness.

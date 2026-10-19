# Teleemon: app inventory and completion roadmap

Review date: 19 October 2026. Scope: Teleemon.com for the owner's own practice, not a platform sold to other practices. **Local development and synthetic review only; go-live remains deferred.**

## Executive assessment

Phases 0–9 have substantial local implementation. The app already has its main staff and patient workflows; it does not need to be scaffolded again from an empty project. This document provides the missing delivery scaffold: phase status, dependencies, owners, acceptance criteria and release gates across the existing app.

“Built” in earlier plans means a local implementation exists. It does not establish live vendor delivery, production security, executed contracts or clinical acceptance. No external BAA, production account or payer enrollment was verified during this review. See the [integration and BAA register](INTEGRATION-BAA-REGISTER.md) for procurement actions.

## App and data map

| Component | Current responsibility | Remaining delivery work |
| --- | --- | --- |
| Staff web app, `apps/staff` | Daily work, calendar, patient charts, encounters, prescribing, inbox, documents, revenue, reports and administration; P01–P45 navigation catalogue | Cross-role acceptance, accessibility, browser coverage and removal of misleading readiness signals |
| Patient web app, `apps/portal` | Signup/onboarding, booking, check-in, visits, messages, summaries, refill requests and billing | Real email delivery, payment acceptance, proxy/minor policies and complete authorization testing |
| Shared domain, `packages/core`; Medplum Bots, `bots` | FHIR conventions, clinical/scheduling rules, validations, consent and access workflows | Restricted-record isolation at the API, temporary grants and remaining policy decisions |
| Self-hosted Medplum | Identity, FHIR clinical records, document references, binaries and audit resources | GCP deployment, production access policies, private storage and recovery acceptance |
| Worker, `services/worker` | Reminders and integration jobs: Meet, prescribing, fax and clearinghouse adapters | Vendor implementations/qualification, durable dispatch and contract approval enforcement |
| Scribe, `services/scribe` | Session audio upload, post-recording transcription and structured draft generation | Real media qualification, approved OpenAI account/model/retention, durable processing and clinical acceptance |
| Portal service, `services/portal` | Trusted patient actions, mail and payment endpoints | Production transport/processor integration, delivery recovery and distributed abuse controls |
| Ledger, `services/ledger` | Financial posting, reversals/projections and reconciliation foundations | Real payer/processor reconciliation, correction handling, scale and recovery acceptance |
| Infrastructure and analytics, `infra` | Local infrastructure/configuration and deployment guidance | Reproducible GCP environments, read-only analytics replica, monitoring and tested recovery |
| Migration tooling, `scripts` | Local normalized demographics/appointment validation and synthetic replay | Real AdvancedMD source mapping, clinical/billing scope, secure staging, reconciliation and rollback |

Current scribe audio is stored as a Medplum Binary under its configured local storage. It is **not already stored in a deployed private GCP bucket**. Meet is the meeting gateway; the chosen product flow records audio and generates afterward, without live transcription or Google's transcript. Browser/OS capture support remains an acceptance dependency.

## Phase inventory

| Phase | Locally implemented | Pending before operational acceptance | Evidence |
| --- | --- | --- | --- |
| 0 — Foundation | Staff shell, sign-in, design system, local setup and synthetic seed | Reproducible staging, domain/TLS, production identity and operational controls | [Phase 0](verification/phase-0.md), [GCP deployment](GCP-DEPLOYMENT.md) |
| 1 — Patients/chart | Patient lists/search/registration, chart, consent and clinical lists | Server-side restricted-chart/Part 2 isolation; consent, minor/proxy and release policies | [Phase 1](verification/phase-1.md), [Phase 9 gaps](verification/phase-9.md) |
| 2 — Scheduling/licensure | Calendar, appointments, conflicts, licence rules and reminder workflow | Real reminder transport, delivery recovery and qualification of time/location/role edge cases | [Phase 2](verification/phase-2.md) |
| 3 — Encounters | Encounter forms, review/signing and note workflow | Final document/PDF/export visual acceptance and patient-summary release/access verification | [Phase 3 review](verification/phase-3-review.md) |
| 4 — Meet and scribe | Meet adapter/sandbox links, audio capture/upload, post-session transcript/draft and retention foundations | Actual Meet capture matrix; OpenAI BAA/account qualification; durable jobs; audio/transcript retention; clinician fidelity acceptance | [Phase 4](verification/phase-4.md), [scribe plan](TELEHEALTH-SCRIBE-PLAN.md) |
| 5 — Prescribing/PDMP | Vendor-neutral prescribing screens, rules and mock transmission | Select API product; contract/BAA; real adapter; EPCS identity/MFA; PDMP access; pharmacy/drug data; renewals and pharmacy responses | [Phase 5/6 audit](verification/phase-5-6-audit.md) |
| 6 — Inbox/documents/fax/labs | Inbox/tasks, document processing, fax log/webhook simulator; manual lab ordering/result review | Real fax transport/receipts; selected lab orders/results interface and analyte mapping; delivery/deduplication and holiday policies | [Phase 6](verification/phase-6.md), [Phase 5/6 audit](verification/phase-5-6-audit.md) |
| 7 — Patient portal | Independent signup, onboarding, booking, active-visit check-in, patient pages and sandbox billing | Real invitation/reset/notice email; tested payments; minor/proxy/consent decisions; coverage/pharmacy gaps; distributed rate limiting | [Phase 7](verification/phase-7.md), [portal audit](verification/phase-7-audit.md) |
| 8 — Revenue cycle | Charges/claims workflow, mock/sandbox clearinghouse, financial ledger and fixes | Validate Stedi schemas/endpoints; implement acknowledgement/remittance retrieval; payer enrollments; real financial reconciliation; correction/refund/write-off policies | [Phase 8](verification/phase-8.md), [fixes](verification/phase-8-fixes.md) |
| 9 — Operations/migration preparation | Reports, waitlist/recalls, manual lab queue, audit/compliance evidence, limited migration validator/replay and disposable ledger restore | Full-system restore/PITR; real export mapping; analytics replica; penetration test; training; parallel run; deployment and release approval | [Phase 9](verification/phase-9.md), [operations](PHASE-9-OPERATIONS.md) |

Check-in is now status-driven: an active booked appointment can check in without waiting for a scheduled 30-minute window. Closed visits remain blocked. Confirmation of actual current location and the corresponding provider licence remains required. This does not mean a patient may independently start a clinical encounter or bypass provider readiness.

## Prioritized completion backlog

Priority P0 means a release blocker for the affected PHI workflow. P1 means required before enabling that module. Owners below are responsibilities, not assigned contractors. No calendar estimate is promised before vendor selection, scope and access are confirmed.

| ID / priority | Work and phase | Owner / dependency | Acceptance evidence |
| --- | --- | --- | --- |
| SEC-01 / P0 | Restricted-chart isolation, including Part 2 where applicable; scoped, expiring break-glass grants; alerts and audit (1/9) | Engineering + practice privacy lead; approved legal/access policy | Direct FHIR/API and Binary access denied across staff, portal, proxy, search and export paths; approved grants expire/revoke; read/write and audit tests pass |
| GOV-01 / P0 | Implement one integration approval gate across worker, scribe and portal services (4–9) | Engineering + practice compliance lead; BAA register | Missing/revoked/expired required agreement or wrong account/product blocks network dispatch; synthetic mode explicit; approval/revocation audited; no secrets exposed |
| GOV-02 / P0 | Correct P44 integration coverage and configuration truth (9) | Engineering; GOV-01 | OpenAI/scribe, payments, labs and analytics represented; mode is consistent with the adapter actually selected; distinguish mock, credentials present, connection tested, contract verified and PHI approved |
| INF-01 / P0 | Reproducible GCP synthetic staging, then separately approved production configuration (0/9) | Infrastructure engineer + practice administrator; GCP access and covered services review | Private databases/storage, TLS, least-privilege identities, secrets management, deployment/rollback, monitoring, budget alerts and environment separation demonstrated |
| OPS-01 / P0 | Full recovery and operational readiness (9) | Infrastructure/security lead; INF-01 | Restore FHIR, ledger, objects, secrets/configuration and jobs into an isolated environment; reconcile records; demonstrate target RPO 15 minutes/RTO 4 hours, or approve a revised target before release |
| LEG-01 / P0 | Agreements, risk analysis and practice policies (all) | Practice owner + privacy/security lead + counsel | Register evidence accepted; documented risk assessment/remediation; recording/telehealth, minors/proxies, access/release and retention decisions; incident response and workforce training evidence |
| SCR-01 / P1 | Qualify Meet + OpenAI post-visit workflow (4) | Engineering + clinician; Workspace/OpenAI approvals | Synthetic two-party calls on supported OS/browser combinations capture both sides; stop generates once; network/tab-close/retry cases handled; ten-session clinician review measures omissions, attribution, unsupported findings, latency and cost |
| SCR-02 / P1 | Durable audio processing and retention (4/9) | Engineering + privacy lead; storage/job design | Recover interrupted uploads/jobs; prevent duplicate draft application; reconcile potentially duplicated vendor charges; audio deletion verified against signing policy; transcript and draft retention separately governed |
| MSG-01 / P1 | Implement email and qualify SMS (2/6/7) | Engineering + practice owner; selected covered products | Invitation, reset, reminder and reply notice delivered; authenticated webhooks, retry/deduplication, bounces, opt-out, rate limiting and PHI-minimized templates tested |
| RX-01 / P1 | Real eRx/EPCS and PDMP (5) | Vendor + engineering + prescriber | Signed contract and integration entitlement; sandbox transmission, renewal/change/error paths; identity/MFA and applicable PDMP authorization demonstrated; no mock success shown as sent |
| FAX-01 / P1 | Real fax (6) | Vendor + engineering | Authenticated inbound events; outbound receipts, failures/retries, duplicate handling, patient routing and audit verified |
| LAB-01 / P1 | Select and implement electronic labs (6/9) | Practice + lab/interface vendor + engineering | Account/interface agreements; order catalogue/specimen metadata, signed orders, acknowledgements, patient matching, preliminary/corrected/final results, units/ranges, critical-result escalation and provider sign-off tested |
| REV-01 / P1 | Clearinghouse/payer completion (8) | Billing lead + engineering + selected clearinghouse | Official schema/endpoint mapping; enrollment; eligibility, claim submission, 999/277CA/835 and denial/rejection lifecycle qualified; duplicate/retry and remittance reconciliation proven |
| PAY-01 / P1 | Production-capable payment adapter and financial policy (7/8) | Engineering + billing lead; processor scope review | Production mode deliberately gated; no clinical details in processor payloads; webhook replay/idempotency, refund, failed payment, payout and ledger reconciliation tested; applicable PCI validation completed |
| UX-01 / P1 | Finish encounter/portal acceptance (3/7) | Clinician + engineering | Document/export visual review; summary release permissions; keyboard/accessibility/browser checks; secondary coverage, subscriber details and reverification scope explicitly accepted or completed |
| DATA-01 / P1 | Real migration and reporting (9) | Migration engineer + practice/billing leads | Real export format mapped; notes, history, insurance, balances, providers and active schedule scoped; secure staging and manifests; counts/totals reconciled; replay/rollback tested; reporting uses approved read-only access |
| REL-01 / P0 | Independent final acceptance and release decision (all) | Practice owner + clinical/billing/security leads | Remediated penetration test; role-based end-to-end review; training; planned 2–4 week parallel run and reconciliation; explicit later authorization to cut over |

### Specific implementation gaps behind this backlog

- P44 currently stores evidence/attestation; it is not a universal runtime BAA enforcement mechanism. Its worker registry does not cover all scribe/payment/lab/analytics integrations.
- Clearinghouse configuration can disagree with the selected adapter: the P44 signal checks `CLEARINGHOUSE_VENDOR`, while adapter selection checks the Stedi API key. Credentials alone must not silently enable a PHI path.
- Email currently logs messages. Fax only implements the log adapter. Changing an environment variable does not implement those missing transports.
- Stedi includes unverified endpoints and placeholder retrieval. Stripe currently enforces test keys. Both require engineering and vendor acceptance, not only credentials.
- Audio awaiting upload can be lost when a browser tab closes; processing is request-driven. Server-persisted audio recovery and vendor billing/idempotency need acceptance.
- Migration accepts a normalized local demographics/appointments format. It is not a full AdvancedMD clinical/financial migration, and no production cloud staging pipeline exists.
- Ledger restore rehearsal does not prove full-system recovery. Current local reports do not prove a deployed analytics replica.

## Delivery sequence

1. **Approve scope and procure in parallel:** practice identity, core GCP/Workspace/OpenAI agreements; choose email, prescribing, fax, lab and clearinghouse products. Retain mock/manual paths explicitly until each module is accepted.
2. **Close cross-cutting security first:** SEC-01, GOV-01/GOV-02, synthetic staging and risk/policy decisions. These protect all subsequent integration work.
3. **Complete patient/clinical paths:** messaging, Meet/scribe, encounter exports, portal authorization; then prescribing, fax and lab adapters as vendors become available.
4. **Complete money/data paths:** payer enrollment and revenue acceptance, payments, analytics and full migration mapping/reconciliation.
5. **Prove operations:** full recovery, independent security review, workforce training, clinical/billing acceptance and parallel run. Stop at a documented readiness review. Go-live requires a separate later decision from the owner.

There is no newly approved Phase 10. These are completion workstreams attached to Phases 0–9. Deferred features must have an explicit scope decision and remain unavailable or clearly manual; a disabled integration is not a completed integration.

## Evidence and limits of this review

Reviewed the implementation plan, phase verification/audit records and targeted current source paths through a read-only code inventory. Examples include `apps/staff/src/App.tsx`, `apps/staff/src/navigation.ts`, `apps/portal/src/App.tsx`, `services/worker/src/index.ts`, `services/worker/src/clearinghouse.ts`, `services/portal/src/payments.ts`, `services/scribe/src/service.ts` and migration tools.

Existing verification records report local synthetic checks, including Phase 9 unit/API checks and check-in regressions. Those are historical evidence, not tests rerun for this documentation review. No production environment, contract repository, live vendor transaction or complete clinical migration was inspected. A percentage-complete claim would therefore be misleading.

## Owner decisions needed

- Confirm the practice's exact legal name, authorized signer and privacy/security contact; these are agreement inputs, not secrets to place in source control.
- Select eRx/PDMP, BAA-capable email, fax and lab connectivity products. Confirm whether Stedi remains the clearinghouse choice.
- Obtain vendor implementation entitlements, sandbox accounts, payer/lab enrollment and fees in writing; a BAA does not supply these.
- Approve retention, recording/AI consent, minor/proxy and financial policies with the appropriate clinical/legal reviewers.
- Agree the initial operational scope and recovery targets. Keep go-live deferred until the acceptance register is complete.

# Teleemon Care Platform: implementation plan

Current cross-phase status: [App readiness and completion roadmap — 19 October 2026](APP-READINESS-AND-IMPLEMENTATION-ROADMAP.md). Procurement and agreement actions: [Integration and BAA register](INTEGRATION-BAA-REGISTER.md). “Built” below describes local implementation; production/vendor acceptance remains separate and go-live is deferred.

Source scope: *Teleemon Care Platform – Product Scope, Feature Specification and Process Flows*, v1.0, 15 October 2026.
Foundation: Medplum 5.2.4 (self-hosted, Apache 2.0). Page IDs (P01–P45, X01–X09) follow the scope document.

## How we work

- **One phase at a time, each ending in a verification gate.** At the end of a phase you get a short checklist of things to click through, using synthetic patients only. The next phase starts after you sign off, or after the issues you raise are fixed.
- **Every phase ships something usable.** We build vertical slices (a page that works end to end), not layers that only make sense later.
- **Every gate includes a design check.** Besides the screen checks listed below, each phase's sign-off confirms three things against [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md): the components built match its §12 row; every hard rule in the phase is tested by calling the API directly, bypassing the UI, and is refused by the server; and the ADRs the phase depends on are marked Accepted.
- **Medplum is a dependency, not a fork.** The Teleemon apps live in this repo and use the published `@medplum/*` packages. We never edit Medplum's server, so security updates are a version bump.
- **Unbuilt pages are visible but honest.** Every page in the site map is already in the navigation. Pages not yet built open a "Planned" screen that shows the scope, phase and acceptance criteria, so you can see the whole product and track progress.
- **No real patient data until go-live.** Staging uses synthetic data from `scripts/seed.ts`.

## Repository layout

```
teleemon/
  apps/staff/        Staff web app (React, Vite, Mantine, Medplum components)   – from Phase 0
  apps/portal/       Patient portal and public booking (X01–X09)                – from Phase 7
  bots/              Medplum Bots: scheduling rules, scribe, billing, messaging  – from Phase 2
  services/          Long-running workers (scribe processing, clearinghouse)        – from Phase 4
  scripts/           Project setup, synthetic seed data, migration tools
  docs/              This plan, design system, verification records
```

## Design system (applies to every phase)

| Decision | Choice and reason |
| --- | --- |
| Palette | Brand blue `#3953A4` (from the Teleemon logo, 18 October 2026) for primary actions, and navy `#1F2D5C` in the same hue for structure (sidebar, portal header, headings). The blue logo is used on light surfaces and the white logo on navy surfaces and in dark mode. Semantic colours are reserved: red = safety or blocking, amber = needs attention, green = done or verified, blue = information. Colour never carries meaning on its own; there is always an icon or label too. |
| Typography | Inter (self-hosted; no font CDN, so no third-party requests), 14 px base for dense clinical screens, tabular numerals for times, money and scores. |
| Layout | A navy left sidebar with built pages grouped by area and future pages under Coming later, and a white top bar with global patient search (Ctrl+K), quick actions and the user menu. On chart pages the patient header stays visible (sticky). |
| Density | Compact tables and 8 px radius, with generous whitespace between sections. Clinicians scan, so key numbers come first and their labels second. |
| States | Every list has a loading skeleton, an empty state that explains what will appear and how to add it, and an error state with a retry. |
| Safety cues | Controlled substances, positive safety items, unlicensed states and missing consent always use the same red badge plus icon pattern. |
| Accessibility | WCAG 2.1 AA contrast, visible focus rings, full keyboard navigation, `aria-live` for counts that change. |
| Themes | Light and dark mode; the user's choice is remembered. |
| Privacy | No patient identifiers in URLs beyond opaque FHIR IDs; no analytics scripts. |

## Phases and verification gates

Durations assume the scope's team of four engineers. Phase numbers here are finer-grained than the scope's phases 0–3; the right-hand column maps them back.

| # | Phase | Pages | Scope phase |
|---|---|---|---|
| 0 | Foundation and design system | P01, P02 (first version), shell, navigation, P38/P43 stubs | 0 |
| 1 | Patients and chart | P07–P15, P17, P18, P20 | 1 |
| 2 | Scheduling and licensure | P04, P05, P39, licence engine, reminders (P42) | 1 |
| 3 | Encounter documentation | P21, P23, P24, P41 | 1 |
| 4 | Telehealth capture and AI scribe | P22, capture, transcription, P21 draft population, P23 evidence review | 1 |
| 5 | E-prescribing and PDMP | P25, P26, X07 | 1 |
| 6 | Inbox, tasks, documents and fax | P03, P16, P28, P29 | 1 |
| 7 | Patient portal | X01–X06, X09 | 1 |
| 8 | Revenue cycle | P19, P30–P36, P40, X08 | 2 |
| 9 | Reports, compliance, migration, go-live | P06, P27, P37, P44, P45, migration | 3 |

### Phase 0 – Foundation and design system (built)

Delivers: the `teleemon` repo; the staff app with the Teleemon theme; the sign-in page; the app shell with role-aware navigation for all 45 staff pages; P02 Today (first version, live data); Planned screens for unbuilt pages; a project setup script (enforce MFA, create a service client); and a synthetic seed (practice, provider with four state licences, Bellevue and virtual locations, 10 patients, today's appointments, tasks and messages).

**Verify:**
1. Run `npm run dev`, open http://localhost:3100 and sign in.
2. After running `npm run setup -- --mfa`, sign-in requires an authenticator code. A user without MFA cannot reach any page.
3. Today shows today's synthetic appointments in time order, with modality and state badges.
4. The work-queue tiles show live counts; tiles for queues not yet built say which phase builds them instead of showing a fake zero.
5. Every sidebar item opens either a working page or a Planned page with its scope and acceptance criteria.
6. Ctrl+K patient search works, the theme toggles between light and dark, and the layout holds at tablet width.

### Phase 1 – Patients and chart (built; awaiting your verification: [phase-1.md](verification/phase-1.md))

P07 search (name, DOB, phone, member ID, duplicate warning); P08 registration (required fields, guardian rule for minors, manual referring-clinician NPI entry with check-digit validation (directory lookup deferred), duplicate check); a chart shell with the sticky header and P09 overview (clinical summary, PHQ-9/GAD-7/ASRS sparklines, timeline, compliance panel); P10 demographics with change history; P11 insurance (eligibility shown as a stub until Phase 8); P12 consents (including the per-encounter recording consent model and the Part 2 switch, off by default); P13 problems (ICD-10-CM validated, with DSM-5 display); P14 medications and allergies; P15 measures (scoring, severity bands, an urgent alert on a positive safety item); P17 documents (12 categories); P18 encounters list; P20 communications (with opt-out enforcement). Platform work from the system design: role AccessPolicies (P43), restricted-chart UI reason logging (server compartment isolation and Part 2 enforcement remain deferred), the first pre-commit Bot (duplicate patient), audit events switched on, and a GCP deployment plan (remote staging is not provisioned).

**Verify:** a front-desk user calling the API directly cannot read note contents; register an adult and a minor (the minor is blocked without guardian details); a duplicate is caught; a PHQ-9 with item 9 > 0 raises an urgent alert; the overview loads in under 2 seconds; every demographics edit appears in history.

### Phase 2 – Scheduling and licensure (built; awaiting your verification: [phase-2.md](verification/phase-2.md))

P39 provider licences, DEA registrations and payer enrolment; a licence engine shared by booking, check-in and prescribing; P04 calendar (day/week/month/list, 15-minute grid, drag to reschedule, blocked time, UTC storage with patient-local display); P05 appointment drawer (visit types, repeat bookings, licence block, ICS invite, cancellation reasons); P42 reminders (72/24/2 hours, quiet hours, STOP handling) through an SMS/email Bot (sandbox credentials).

**Verify:** booking a patient located in Texas is blocked; an expired CO licence blocks CO bookings; a double booking needs an override; a Rhode Island patient sees Eastern time; a reminder reaches a test phone; replying STOP stops further messages.

### Phase 3 – Encounter documentation (built; awaiting your verification: [phase-3.md](verification/phase-3.md))

P21 encounter workspace (psychiatric templates: 90792, 99212–99215, 90833/90836/90838 add-ons, crisis, telephone; structured MSE; autosave; billing panel with E/M suggestion and POS/modifier from modality and location); P23 review, sign and amend (pre-sign checklist, locking, addenda, late-entry flag); P24 export (Word and PDF on practice letterhead, after-visit summary release); P41 template and smart-phrase settings.

**Verify:** a note without a diagnosis cannot be signed; a 90836 add-on with 20 minutes documented is rejected; a signed note can only be changed by addendum; the exported .docx opens cleanly in Word and Google Docs.

### Phase 4 – Telehealth capture and AI scribe (built locally; synthetic review: [phase-4.md](verification/phase-4.md))

Detailed delivery plan, costs, dependencies and acceptance gates: [TELEHEALTH-SCRIBE-PLAN.md](TELEHEALTH-SCRIBE-PLAN.md). The requested workflow uses Google Meet for the call, Teleemon for audio capture, and OpenAI for transcription and template-driven clinical drafting. Google transcripts are not the source. Owner decision: record during the appointment; transcribe and generate afterward. Live transcription and Zoom are excluded.

*Needs first for PHI: applicable Google Workspace, OpenAI and GCP BAAs, eligible endpoints and approved retention configuration.* Synthetic capture experiments can proceed before production credentials. A paid meeting subscription does not grant audio API access. Confirm the supported browser/OS capture combination for the selected Meet integration.

- **4A — Capture and consent:** P22 inside the encounter; meeting link, browser/OS support check, provider microphone plus remote tab audio, per-session consent, separate source meters, start/pause/resume/stop, interrupted-capture warning, authenticated resumable upload. Office visits use microphone capture. Verify Meet tab capture with synthetic calls. Audio may upload to GCP during recording; no OpenAI processing starts until stop and upload finalization.
- **4B — After-visit scribe (first release):** record during the appointment, transcribe after stopping, generate one clinical draft from the selected template and instructions, validate a typed result, and propose field changes to P21. Retain timestamped evidence and authorized audio playback. Apply through the existing revision-aware draft saver; preserve provider edits and existing signing controls. Reuse Phase 3 Word/print export rather than building it again.

**Verify:** use the detailed 10-session synthetic gate in the linked plan. It covers consent bypass attempts, capture of both sides with headphones, interruptions and retries, evidence accuracy, missing-data behavior, preservation of concurrent provider edits, rejected cross-patient jobs, signing locks, export consistency, retention/legal holds and measured cost. Speaker accuracy >=95% and a 30-minute appointment's draft ready within 60 seconds of stop are initial targets to measure, not achieved guarantees. Recording refusal must leave manual documentation available.

### Phase impact review — 16 October 2026

This is a roadmap/source review; prior verification records are evidence of earlier runs, not a fresh execution or user sign-off.

| Phase | Current evidence and planned impact |
|---|---|
| 0–2 | Built locally; verification/sign-off remains as recorded. Phase 4 reuses authentication, patient identity, location/licensure and recording consent types. Phase 2 gains a meeting-link association/creation adapter; no automated invite or external account change is part of this documentation update. |
| 3 | Built with remediation recorded in [phase-3-review.md](verification/phase-3-review.md). Reuse NoteData, templates, autosave, canonical signing and exports. Add AI field proposals, evidence and provenance in Phase 4. Separate author-restricted private notes and medication snapshots are now implemented for new documentation; legacy data still needs review; Word/Google Docs/PDF visual verification is still outstanding. |
| 4 | Built locally: services/scribe, encounter capture, transcript/findings review, consent/authorization and retention. Verify 4A/4B with actual synthetic Meet audio and an OpenAI test key before clinical acceptance. Template instructions shape the note, never rewrite the faithful transcript. |
| 5 | Draft medication decisions remain suggestions; prescribing still requires the eRx/PDMP workflow. The scribe cannot create prescriptions automatically. |
| 6 | Reuse background-job failure Tasks and document access controls. Before the inbox ships, show failed capture/transcription/drafting jobs and retry actions within P22. |
| 7 | Portal check-in can expose the chosen meeting link after location confirmation. Patients receive only explicitly released summaries; raw audio/transcripts and private notes are not automatically portal-visible. |
| 8 | AI billing and diagnosis suggestions require provider acceptance; use existing code validation and the later charge-review workflow. Session length is not automatically billable E/M or psychotherapy time. |
| 9 | Bring minimum scribe access controls, audit, retention and failure monitoring into Phase 4. Full audit search/reporting and go-live checks stay here; cloud deployment and restore testing remain pending. |
| Deployment | GCP is the accepted target. A small illustrative scribe hosting allowance is not the cost of the proposed full GKE/Cloud SQL/Memorystore platform; obtain a separate deployment estimate. |
| Gate | Keep Phase 0–3 status as built/awaiting verification; local implementation does not establish Phase 4 clinical acceptance or authorize processing the attached real-patient example. Use synthetic fixtures only. |

### Phase 5 – E-prescribing and PDMP (built vendor-neutral; synthetic review: [phase-5.md](verification/phase-5.md))

*Built against a mock vendor adapter. Still needs a contracted eRx/EPCS vendor with an EHR API (iPrescribe Enterprise, DoseSpot or Ensora) and its sandbox before real prescribing.* P25: an embedded Ensora screen with patient context; medication writeback; a PDMP check record and a 24-hour rule for controlled substances; the state/DEA rules engine. P26: renewal and RxChange queue. X07: refill requests (built with the portal in Phase 7).

**Verify:** a controlled prescription without a PDMP check in the last 24 hours is blocked; a state without an active DEA registration is blocked; a sandbox renewal lands in the queue and its response returns.

### Phase 6 – Inbox, tasks, documents and fax (built; fax vendor pending; synthetic review: [phase-6.md](verification/phase-6.md))

P03 unified inbox (tabs, assignment, SLA timers, patient-match review); P29 tasks (recurring tasks included); P28 fax center (inbound queue, AI-suggested patient and category with human confirmation, never auto-deleted); P16 labs, manual (requisitions, PDF results, acknowledgement).

**Verify:** an unmatched fax cannot be filed without confirming the patient; every item ends assigned, filed or closed with a reason; dashboard counts equal list rows.

### Phase 7 – Patient portal (built; email vendor, Stripe and counsel items pending; synthetic review: [phase-7.md](verification/phase-7.md))

Audited and extended with independent email-verified adult registration: [Phase 7 audit](verification/phase-7-audit.md). Patients may register and complete intake before selecting a visit. Booking-first and staff invitations remain supported.

*Built with emails on the log transport, a sandbox card adapter (Stripe test mode when keys are set), and placeholder minor-proxy ages pending counsel. ADR-012 and the ADR-005 ledger schema are accepted.* `apps/portal`: X01 public booking (state first, live slots, captcha, no trackers, 988/911 on every page); X02 intake wizard (save and resume, e-signed consents, card on file through Stripe test mode); X03 home; X04 check-in with location confirmation, and a join link only after check-in; X05 messages; X06 summaries; X07 refills; X09 profile and proxies.

**Verify:** a returning patient books in under 2 minutes on a phone; an out-of-state patient cannot book; a proxy for a minor sees only what that state's rules allow; the join button stays hidden until location is confirmed.

### Phase 8 – Revenue cycle (built; Stedi test account, Stripe and billing policy pending; synthetic review: [phase-8.md](verification/phase-8.md))

*Built against a mock test payer, with a Stedi adapter that switches on when `STEDI_API_KEY` is set. Refund and write-off rules are configurable placeholders in P40.* *Originally needed first: a Stedi test account; our own Stedi Bots, because `$stedi-submit-claim` is not in open-source Medplum.* An append-only ledger service; P40 payers, fees, codes and scrub rules; P30 charge review; P31 claims workbench with 25–30 rules; P32 eligibility batches; P33 ERA auto-posting and exceptions; P34 denials and appeals; P35 statements; P36 A/R dashboard; P19 patient account; X08 bill pay.

**Verify:** test claims are accepted by Stedi's test payer; posted totals equal ERA totals; the ledger balances to the cent after every posting; the A/R dashboard reconciles to the ledger.

### Phase 9 – Reports, compliance and migration preparation (built locally; no go-live; synthetic review: [phase-9.md](verification/phase-9.md))

*Built for synthetic review: P37, P45, P44, P06, the P27 queue (no HL7 interface yet), AdvancedMD validation and rehearsal tooling, and the recovery rehearsal. Penetration test, training, parallel run, production restore test and cutover still need people, vendors and owner approval.*


P37 with the 24 standard reports, plus Metabase on a read replica; P45 audit search, alerts and compliance checklist; P44 integration health; P06 waitlist and recalls; P27 labs over HL7 (if a lab interface is ready); AdvancedMD import with validation counts; penetration test; training; a 2–4 week parallel run; cutover.

The owner explicitly deferred go-live and cutover. Local delivery follows [the Phase 9 implementation plan](PHASE-9-IMPLEMENTATION.md). The 24-report catalogue is defined in `packages/core/src/reportCatalog.ts`. Deployed analytics, server-side restricted-compartment isolation, real migration and full-system recovery remain acceptance gates; local tooling does not establish them as complete.

**Verify:** financial reports tie to the ledger; every chart view is in the audit log and can't be edited; imported patient and appointment counts match the AdvancedMD export; the restore test meets RPO 15 minutes and RTO 4 hours.

## Decisions needed before the phase that uses them

| Decision (scope ref) | Needed before |
|---|---|
| D1 meeting vendor and supported capture environment | Meet accepted by owner; verify browser/OS/audio capture in Phase 4A; after-visit processing only |
| OpenAI BAA / eligible endpoints / retention configuration | Before Phase 4 PHI; synthetic-only development can precede this |
| Audio/transcript retention, legal holds and private-note separation | Phase 4 production gate; details in TELEHEALTH-SCRIBE-PLAN.md |
| eRx/EPCS vendor contract and sandbox (iPrescribe Enterprise, DoseSpot or Ensora) | Before real prescribing; Phase 5 rules and UI already built |
| D4 clearinghouse (Stedi recommended) | Phase 8 |
| D5 billing staffing | Phase 8 |
| D2 Part 2 applicability | Go-live (built switchable in Phase 1) |
| D6 history to migrate | Phase 9 |
| Email vendor with a BAA (portal emails, invitations, password reset) | Before real patients use the portal; Phase 7 uses the log transport |
| Minor-confidentiality ages per state, adult proxies and final consent wording (counsel) | Before real patients use the portal; Phase 7 ships placeholders |
| Stripe account (test, then live) | Card on file before go-live; Phase 7 sandbox and test-mode adapter built |

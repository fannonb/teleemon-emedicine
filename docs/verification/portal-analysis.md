# Patient portal — feature analysis and hand-off

Written 2026-10-18. Companion to `docs/verification/phase-7.md`, `docs/verification/phase-7-audit.md`
and `docs/PATIENT-ONBOARDING-PLAN.md`. It describes how the portal works today, the intended
workflow, what is missing, and the API integrations still required. No go-live is authorized.

## 1. Architecture: two data paths

The portal is an app (`apps/portal`) plus a small service (`services/portal`). There are **two ways**
patient data moves, and this split is deliberate:

1. **Direct FHIR reads.** The portal app talks straight to Medplum as the signed-in patient. A
   per-patient "compartment" AccessPolicy (`scripts/config/portal.ts`, applied by `npm run setup`)
   limits reads to that patient's own records. Proxy access is a parameterized policy (`%patient`).
   Sensitive extensions — including the telehealth link — are removed from patient reads with
   `hiddenFields`, so the raw link never leaks through a direct read.

2. **Rule-bearing writes through the service.** Anything with practice rules — booking, cancelling,
   check-in, e-signatures, card on file — goes to `services/portal` at `/api/portal/*`. The service
   re-checks the patient's own Medplum token on every request and enforces the rules centrally.

A few **direct writes** are allowed but guarded by **pre-commit Bots** (they run inside Medplum and
can reject, amend or post-process): sending a portal message, creating a refill Task, and editing the
profile. Besides the request handlers, the service runs a **20-second background clock** that advances
time-based state (hold expiry, reminders, and similar).

Why it matters for support: a broken *view* is usually a policy/hiddenFields problem; a broken *action*
is usually the service or a Bot.

## 2. The intended workflow

1. **Invitation → activation.** The practice sends an invitation; the patient activates their account.
   Email currently uses a **log transport** (nothing is actually sent until a vendor is chosen).
2. **Sign-in.** Patient signs in; a proxy signs in on the patient's behalf at `full` or `limited`
   access. (`limited` hides the clinical areas and shows only scheduling and insurance.)
3. **Intake.** About you, history, measures (PHQ-9, GAD-7, …), consents, insurance, card on file,
   review — then submit. New-patient forms.
4. **Book / confirm.** Online booking is limited to visit types offered online, on the 15-minute grid,
   inside practice hours and within the booking window.
5. **Reminders → check-in.** Reminders go out; patients can check in whenever they are ready for an active booked visit. The patient (or staff on their behalf) confirms their current location and the provider's licensure before the visit proceeds, and renews it if it has gone stale by the time they join.
6. **Join the video visit.** The Google Meet link is released to the patient **only after check-in**.
7. **After the visit.** Summaries (signed notes), secure messages, refill requests, billing and
   payments.

## 3. Feature by feature

| Feature | What works | How it works | Gaps |
| --- | --- | --- | --- |
| **Home** | Next visit, pending actions, crisis footer | Direct FHIR reads + service status | — |
| **Visits / appointments** | List, view, cancel, reschedule | Reads direct; booking/cancel via service | Reschedule depends on the same availability rules as booking |
| **Online booking** | Public + signed-in booking | `services/portal/src/booking.ts` + availability | Minors' booking and self-sign-up need an owner decision |
| **Check-in** | Available for an active booked visit at any time; confirms current patient location and provider licensure, then releases the join link while the confirmation is recent | `services/portal/src/checkin.ts`; the staff dialog is the assisted path for phone/in-person | A confirmation older than `PORTAL_RULES.locationFreshHours` must be renewed before joining; the provider re-confirms on camera when it is stale |
| **Messages** | Send; care team replies; crisis-language routing | Direct write guarded by `bots/src/communication-rules.ts` | **Now:** auto-refresh + "new reply" indicator added (see §5). Attachments and realtime still absent |
| **Summaries** | View signed notes/summaries | Direct FHIR reads | — |
| **Refills** | Request a refill | Direct Task write guarded by `bots/src/task-rules.ts` | Pharmacy selection needs a **pharmacy directory** (vendor) |
| **Billing & payments** | Balance, statements, recent activity, pay on card on file | Service `billing.ts` / `payments.ts` (sandbox or Stripe **test**) | **Now:** printable / save-as-PDF statement added. Live card processing needs Stripe |
| **Intake / registration** | Full new-patient intake | `registration.ts`, `intake.ts` | Secondary insurance, subscriber DOB, photo ID deferred |
| **Profile** | Edit contact details | Direct write guarded by a Bot | — |
| **Consents** | Capture e-signatures | `consents.ts` + `packages/core/src/intake.ts` | Wording is a **placeholder pending counsel** (proxy authority, minor/teen ages) |
| **Proxies** | Proxy sign-in at full/limited | Portal AccessPolicies | Teen/confidentiality rules need counsel |
| **Notifications** | Reminders queued and delivered | Worker + transport | Email is a **log transport**; SMS needs Twilio + BAA |
| **Video visit** | Join link for patient and provider | Google Meet (see §4) | Going live needs Google Workspace credentials |

## 4. Telehealth: Google Meet auto-provisioning

Google Meet was already the chosen platform (the Phase 4 scribe captures the Meet tab and
`validMeetUrl` enforces `meet.google.com/xxx-xxxx-xxx`), but staff had to paste the link by hand.
That gap is now closed by an **idempotent provisioning pipeline**:

- The worker gives every **confirmed video appointment inside the horizon** (booked / arrived /
  checked-in, next 60 days) a meeting link, unless it already has one.
- The **provider** sees it on the appointment / in the scribe panel; the **patient** receives the same
  stored link, released by the portal service **only after check-in**. Both reach the same meeting.
- **Retries never create a second meeting.** The appointment id is the idempotency key; in Google mode
  the calendar event id is derived deterministically from it, so a retried insert returns `409` and the
  adapter reads the existing event back. Provisioning only writes when no valid link is present.
- **Modes.** `MEET_VENDOR=sandbox` (default) mints a valid-shaped synthetic link and calls nothing, so
  the whole flow is testable locally. `MEET_VENDOR=google` creates a real Meet link through a Workspace
  service account (Calendar API + `conferenceData`).

**Going live (config only):** set `MEET_VENDOR=google` and provide
`GOOGLE_MEET_SERVICE_ACCOUNT_JSON` (or `GOOGLE_MEET_CLIENT_EMAIL` + `GOOGLE_MEET_PRIVATE_KEY`),
`GOOGLE_MEET_CALENDAR_ID`, and `GOOGLE_MEET_IMPERSONATE` (domain-wide delegation). See `.env.example`.

Code: `packages/core/src/telehealth.ts`, `services/worker/src/meet.ts`; tests: `scripts/meet.test.ts`
(`npm run test:meet`).

## 5. Changes made in this pass (no vendors required)

- **Video:** Google Meet auto-provisioning (above).
- **Messages:** the page now refreshes quietly every 30 seconds and flags care-team replies that
  arrived since the patient's last visit (a "N new" badge and a "New" mark per reply). The mark is
  stored per patient in `localStorage`; no data leaves the browser.
- **Billing:** a statement can be printed or saved as a PDF from the statement view (a standalone,
  print-formatted window with the practice heading; all values escaped).
- **Check-in: a confirmation expires.** A location confirmation now holds for
  `PORTAL_RULES.locationFreshHours` (6 hours). A patient who checks in early stays checked in, but when
  they return to join they confirm their location again — so someone who checked in days ahead cannot
  travel to a state the provider is not licensed in and still join. The portal shows the renewal form
  rather than a dead end (`locationConfirmationFresh`, `checkInProblem`, `joinProblem`;
  `scripts/checkin-location.test.ts`, `npm run test:location`).
- **Check-in: the provider re-confirms on camera.** The encounter workspace shows whether the patient's
  confirmation is current. When it is missing or stale — or the visit was started from an old check-in —
  the provider gets a prompt and, in one click, records their own on-camera confirmation on the Encounter
  (`EXT.providerLocationConfirmed`). Licensure enforcement is unchanged; this adds the provider's
  attestation to the record.
- **Staff check-in dialog is modality-aware.** In-person visits confirm arrival without the odd "where
  are you now?" prompt (the booked location is kept); video visits say the patient normally checks in
  from the portal and the desk action is demoted to "Check in on their behalf"; phone visits keep the
  prompt. The state is pre-filled from the booking, and the video dialog can copy the patient's
  check-in link. Wording and flow only; the check-in Bot still requires the who/when/state confirmation.

## 6. Still missing / deferred

**Release gates that need a vendor, a contract or counsel (not code):**

- Email vendor (currently a log transport) and SMS via Twilio with a BAA.
- Live card processing (Stripe) and live payer connectivity.
- Consent wording — proxy authority, minor/teen ages, Part 2 — **pending counsel**.
- Deployment acceptance: GCP setup, `TRUST_PROXY` behind the load balancer (already implemented),
  backups, and an accessibility review.
- eRx and clearinghouse go-live (adapters exist; sandbox/mock only).

**Deferred product scope (needs an owner decision):**

- Secondary insurance, subscriber date of birth, annual re-verification, photo ID capture.
- Teen/confidential access and minors' online booking.
- Pharmacy directory (blocks refill pharmacy selection).

## 7. API integrations required

| Capability | Provider | Config | Notes |
| --- | --- | --- | --- |
| Video visits | Google Meet (Workspace) | `MEET_VENDOR`, `GOOGLE_MEET_*` | Adapter built; sandbox until credentials are supplied |
| Email | TBD | transport env | Log transport today |
| SMS | Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Needs BAA |
| Payments | Stripe | payments env | Sandbox / test keys only |
| e-Prescribing | iPrescribe / DoseSpot … | `ERX_VENDOR` | Mock adapter default |
| Claims / eligibility | clearinghouse (Stedi test) | `STEDI_API_KEY` | Mock test payer default |
| Fax | TBD | `FAX_VENDOR` | Log adapter default |
| Pharmacy directory | TBD | — | Blocks refill pharmacy selection |
| Identity verification | TBD | — | Deferred |

## 8. Verification performed

- `npm run typecheck` — all projects clean (scripts, core, bots, worker, scribe, portal, ledger,
  staff, portal app).
- `npm run test:meet` — 6/6 pass (link shape, adapter idempotency, base32hex event id, RS256 JWT
  signature verified against the matching public key, selection plan, idempotent provisioning pass).
- `npm run build -w apps/portal` — builds.

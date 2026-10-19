# Phase 7 verification: patient portal and public booking

Updated audit: [Phase 7 registration completion](phase-7-audit.md). Current verification: **27 regression tests and 120 local API checks passed**. The API suite confirms check-in a full day before the scheduled visit. Independent registration is available at `/register`; original evidence below records the earlier implementation.

Check-in timing update: active booked visits remain available regardless of their scheduled start/end, while closed visits stay blocked. Patient and staff-assisted check-in retain confirmed current location and server-side licensure checks. [Portal screenshot](early-checkin-portal.jpg) shows tomorrow's visit with the check-in form available; its confirmation button requires the patient to affirm their location.

Built locally: 17 October 2026. Status: **built for synthetic review; email, Stripe and counsel items pending**.

No email vendor is connected, so emails go to the worker's log transport (`services/worker/outbox.log`). Payments use a sandbox that collects no card details; Stripe test mode turns on when test keys are configured. Proxy ages are placeholders pending counsel.

## What was built

| Area | Delivered |
|---|---|
| Identity (ADR-012, [write-up](../adr/012-portal-identity.md)) | • Separate public portal ClientApplication (PKCE, 30-minute tokens).<br>• Patients sign in as their Patient profile; parents and guardians as a RelatedPerson.<br>• Policies: `Teleemon Patient`, `Teleemon Proxy` (full) and `Teleemon Proxy (limited)`, all parameterized to the patient's compartment.<br>• Sign-ins come from single-use, 72-hour invitation links; only the link's hash is stored. |
| Rules (`packages/core/src/portal.ts`, `intake.ts`) | • Online booking window: new patients a 60-minute evaluation at least 24 hours ahead; returning patients follow-ups at least 2 hours ahead. Always on the 15-minute grid, inside practice hours, video only, up to 60 days ahead.<br>• Cancellation: within 24 hours is recorded as a late cancellation.<br>• Check-in is available for an active booked visit whenever the patient and care team are ready, regardless of its scheduled start or end. It requires a recorded current location, confirmer, time, and a provider licensed in that state on the actual check-in date.<br>• The join link is released after check-in with a confirmed location; an active checked-in visit is not blocked by its planned start or end time. The provider starts the encounter when ready.<br>• Proxy level comes from the minor's age and home state.<br>• Patient self-edit limits, crisis language, portal message rules, intake questions, versioned consent texts, and the save-and-resume step logic. |
| Bots (no new Bot; rules merged into existing pre-commit Bots) | • **Appointment rules:** online and portal bookings must meet the online booking window, be video, never overbook, and an unconfirmed hold needs an expiry.<br>• **Patient:** a patient or proxy may change only contact details, address, pronouns, pharmacy, text preference, self-pay and emergency contacts.<br>• **Messages:** portal messages are sent under the sender's own name, about their own patient, as plain text up to 4,000 characters. Possible crisis language is marked urgent. Staff replies go out under the replier's name and can't be changed once sent.<br>• **Tasks:** portal refill requests are for the patient's own medication, one open request per medication; the server sets the SLA and priority. Invitation requests must name a Patient or RelatedPerson. |
| Portal service (`services/portal`, port 3120) | • Public: options, live free times (no patient details), proof-of-work challenge, booking, invitation lookup and activation.<br>• Signed in: profile and visit types, booking, cancelling, check-in, join link, e-signatures, and card on file (sandbox or Stripe test mode).<br>• Every 20 seconds it sends staff-requested invitations, releases expired holds and emails "you have a reply" notices (no content). Hourly it reviews proxy policies.<br>• Rate limits per address: 5 booking requests per hour, 20 link uses per hour. |
| Portal app (`apps/portal`, http://localhost:3200) | • **X01** public booking (state first, live times, details, check).<br>• **X02** intake wizard: about you, insurance (draft coverage or self-pay), health history, questionnaires, e-signed consents, card on file, review. Saved as you go.<br>• **X03** home: next visit and check-in, before-visit tasks.<br>• **X04** check-in and join.<br>• **X05** messages.<br>• **X06** after-visit summaries.<br>• **X07** refill requests.<br>• **X09** profile and proxies.<br>• 988 and 911 on every page, and immediately when an answer or message suggests danger. No analytics or third-party scripts; Stripe.js loads only on the card step in Stripe mode. 15-minute idle sign-out. Light and dark mode. |
| Staff app | • **Chart → Demographics → Patient portal:** invitation status and Send invitation for the patient and each related person, with the proxy level and its reason.<br>• **Inbox:** portal messages join the patient-messages queue, with a "Possible crisis language" badge, and Reply in portal (reply and close in one transaction).<br>• **Refills:** portal requests show the patient's note. |
| Ledger (ADR-005, [write-up](../adr/005-ledger.md)) | `services/ledger/schema.sql`: a double-entry, append-only ledger with balance, reversal and idempotency invariants enforced by PostgreSQL. |

## Run locally

```powershell
npm run setup -- --portal-only   # policies, Bots, portal clients; writes apps/portal/.env.local
npm run portal                   # portal service on http://127.0.0.1:3120
npm run dev:portal               # portal app on http://localhost:3200 (first time: copy apps/portal/.env.defaults to .env)
npm run portal:demo              # synthetic sign-ins: maya.thornton@example.com and emily.bennett@example.com
npm run dev                      # staff app, as before
npm run test:phase7
npm run verify:phase7
npm run ledger:schema
```

Local Medplum must allow the portal origin. `local-runtime/medplum.config.json` now lists `http://localhost:3200` in `allowedOrigins`, and the API server was restarted.

Emails, including invitation links, appear as JSON lines in `services/worker/outbox.log`. The demo password is `Synthetic-portal-2026!`, or `TELEEMON_PORTAL_DEMO_PASSWORD` if set.

## Evidence (17 October 2026)

| Check | Result |
|---|---|
| Phase 7 regression tests | 24 passed (14 for the portal, 10 for onboarding) |
| Phase 7 checks against local Medplum (anonymous public, patient, limited proxy, full proxy and staff sign-ins; deployed Bots and policies; portal service over HTTP; onboarding) | 119 passed |
| Onboarding checks within that total | 27 passed: minor invitations refused, verification blocked while items are missing, sex at birth, card upload, estimate, reminder |
| Ledger schema invariants (throwaway database) | 25 passed |
| Earlier regression suites | Phase 1: 8 · Phase 3: 14 · Phase 4: 21 · Phase 5: 18 · Phase 6: 19, all passed |
| Earlier server checks after the Bot changes | Phases 1–6 passed (Phase 1: 38, Phase 4: 15, Phase 5: 34, Phase 6: 37) |
| Typecheck and production builds | Passed; the same bundle-size warning as the staff app (portal about 240 kB gzipped) |
| Browser smoke check | Public booking (TX refused, WA times), sign-in, home, questionnaires, visits, messages, and the limited-proxy view. Found and fixed: missing `MEDPLUM_BASE_URL` for the portal, a misleading intake stepper, new-patient forms offered to established patients, clipped time buttons. A focused smoke check, not full browser automation or accessibility certification. |

### How the scope's acceptance criteria are met

| Criterion | Evidence |
|---|---|
| A returning patient books in under 2 minutes on a phone | Visit type and state are pre-filled from history, so booking is pick a day, pick a time, confirm: one server request. The time itself is for you to confirm on a phone (checklist step 4). |
| An out-of-state patient cannot book | Refused for free times, public booking, signed-in booking, and a direct API write (appointment Bot licensure check). |
| A proxy for a minor sees only what that state's rules allow | A WA 15-year-old's guardian is on the limited policy: Medplum refuses their reads of summaries, messages, answers and medications. A 9-year-old's guardian has full access. When the child reaches the state age, the hourly review moves the guardian to limited. |
| The join button stays hidden until location is confirmed | The link is hidden from the patient's own reads (policy). The service refuses it before check-in and refuses check-in from an unlicensed state. |
| 988 and 911 on every page | Crisis footer in the app shell. Immediate crisis panel on intake, questionnaires and messages. Every email ends with 988 and 911. |
| No trackers | No analytics, fonts or captcha from third parties; the proof-of-work check is self-hosted. |

## Your checklist (synthetic data only)

Start Medplum, then `npm run portal`, `npm run dev:portal` and `npm run dev`. Run `npm run portal:demo` once.

1. **Public booking.** Open http://localhost:3200/book.
   - Choose Texas: booking is refused.
   - Choose Washington, pick a time, and enter a synthetic adult with an `@example.com` email.
   - The page says to check your email. In `services/worker/outbox.log`, open the link from the newest email for that address.
   - Set a password. The visit is confirmed and shows on the staff calendar.
2. **Hold release.** Book another time and do not open the link. After 60 minutes the time is released, and it appears free again on the booking page.
3. **Intake.** Sign in as the new patient and continue the forms on home. Stop halfway, sign out, sign back in: the forms resume at the same step.
   - Answer PHQ-9 item 9 with anything but "Not at all". The crisis panel appears at once, and the provider's Today page shows the safety alert.
   - Sign the consents and save the sandbox card. Then submit; the answers are now read-only.
4. **Returning booking on a phone.** Sign in as `maya.thornton@example.com` on a phone, or a narrow browser window. Book a follow-up and time it from Visits to confirmation.
5. **Check-in.** As front desk, book Maya a video visit starting in 15 minutes and add a telehealth link. Patient check-in is available immediately for the booked visit; the provider starts the encounter when ready.
   - In the portal, open the visit: there is no join button.
   - Check in from Texas: refused. Check in from Washington: Join video visit appears.
6. **Messages.** As Maya, send a message.
   - As front desk, find it in **Inbox → Messages** and use Reply in portal. Within 20 seconds an email "you have a new message" appears in the outbox, without the reply text, and Maya sees the reply.
   - Send a message containing "suicide": the portal shows 988 and 911, and the inbox row shows Possible crisis language.
7. **Refills.** As Maya, request a refill. It appears in **Refills** with the patient's note. A second request for the same medication is refused.
8. **Proxy.** Sign in as `emily.bennett@example.com`, Lucas's mother; Lucas is 16 and lives in WA.
   - Only Home and Visits are shown.
   - Opening `/summaries` returns home.
   - The server refuses direct reads; `npm run verify:phase7` proves this.
9. **Staff invitations.** In Lucas's chart → Demographics → Patient portal, the card shows Emily's limited access and the reason. For another patient with an email, choose Send invitation: the status moves to Invited within a minute.

## Still required before real use

- **Email vendor with a BAA.** Configure it for portal emails and for Medplum's password reset, and point the reset link at the portal. Until then there is no self-service password reset; staff send a new invitation.
- **Counsel:**
  - minor-confidentiality ages per state (placeholders WA 13, CA 12, CO 12, RI 14);
  - adult proxies (authorization form);
  - final consent wording, which replaces the placeholder texts and needs a new version code;
  - whether a minor may sign their own treatment consent.
- **Stripe:** a test account first (set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` test keys), then a live account and a payment-processing review. The Stripe adapter has not yet been exercised against Stripe's sandbox.
- **Production deployment** (ADR-012):
  - run the portal accounts client as a separate internal workload;
  - add Cloud Armor rate limits in front of `/api/portal/public`;
  - set `TRUST_PROXY=1` behind the load balancer;
  - keep the portal origin in Medplum's allowed origins.
- **Accessibility:** a formal WCAG 2.1 AA review of the portal with a screen reader. Bundle code-splitting is a performance follow-up.
- **Online booking for minors** is by phone only. Online scheduling by guardians covers only patients who already have a record.

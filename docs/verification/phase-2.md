# Phase 2 verification: scheduling, licensure and reminders

Status: **ready for review** · built 16 October 2026 · synthetic data only · no vendors needed

## Before you start

1. The Medplum stack is running. From `teleemon/`: `npm run setup` (adds the appointment and reminder Bots and the worker's client), then `npm run seed`.
2. Run `npm run dev` and, in a second terminal, `npm run worker`. Open http://localhost:3100. Password for every account: `Teleemon-Local-2026`.
3. The worker uses a **log transport**: texts and emails are written to `services/worker/outbox.log` instead of being sent. Setting `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` in `.env.local` switches texts to Twilio, once decision D7 is made and a BAA is signed.

## A. Server-side enforcement (no UI involved)

Run `npm run verify:phase2`. Expected: **29 PASS, 0 FAIL**, followed by "cleaned up … test resources". It covers:
- licensure (Texas refused, expired CO licence refused, WA still allowed);
- double booking, overbooking with a reason, and blocked time;
- check-in from an unlicensed state being recorded;
- history and patient-local time;
- reminder scheduling, idempotency, opt-outs, quiet hours, STOP/START/HELP;
- phone search in three formats;
- least privilege for the worker and front desk.

The script tags its test data, never touches your real queued reminders, and cleans up even if interrupted. `npm run verify:phase1` should still pass as well.

## B. Dashboard and navigation (UI/UX pass)

| # | Check | Expected | Pass? |
|---|---|---|---|
| 1 | Today, as **provider** | Four equal summary cards: Visits today · Next visit · Needs attention · My work. Each one jumps to its section | |
| 2 | Today's schedule | Aligned columns (Time, Patient and visit, Where, Status) under a header row; a red **Now** marker between past and upcoming visits; All/Upcoming filter; each whole row opens the visit | |
| 3 | Right column | "Needs attention": the safety flag for Priya, the TX check-in and the CO licence, each opening the right page. "Work queues" as a compact list with counts aligned right | |
| 4 | Sidebar | "Find patient" stays highlighted inside a chart; a **Recent** list under Patients after you open charts | |
| 5 | Keyboard | `/` opens search; Alt+T, Alt+P, Alt+C and Alt+N jump; `?` shows the shortcut list (also in the account menu) | |
| 6 | Chart | A "Patients / name" breadcrumb above the patient header | |

## C. Scheduling screens

| # | Check | Expected | Pass? |
|---|---|---|---|
| 7 | Calendar → Week | Mon–Sat 9 AM–9 PM grid; today highlighted with a now-line; neutral "Lunch and admin time" block; visits show status dots and a matching legend, without colored left rails. Short visits show patient names | |
| 8 | Day / Month / List | Each view shows the same visits; clicking a month day opens that day | |
| 9 | Click an empty time | The booking drawer opens at that time | |
| 10 | Book **Grace Kim** (CA): Medication management at a free time | The Time list shows only free times; a green "Licensed in CA until …" check; Rhode Island patients also show "Patient's local time … ET". After saving: a confirmation with a **Calendar invite (.ics)** download | |
| 11 | Book a patient with "Patient located in" = **Texas** | A red licence message; the Book button stays disabled | |
| 12 | Tick "Show all times", choose an occupied time | A red overlap warning; booking needs an overbooking reason | |
| 13 | New booking with Repeat = every 2 weeks × 4 | "Book 4 visits" with the four dates listed; if one clashes, none are booked | |
| 14 | Drag a future booked visit to another time | A "Move appointment?" confirmation, then the visit moves; dropping onto blocked time is refused with a reason | |
| 15 | Open a visit → **Check in** | Asks for the patient's current state; status becomes "Checked in" | |
| 16 | Open a visit → **Cancel visit** → "Late cancellation" | Asks for a reason; the History tab shows each change with who and when | |
| 17 | Calendar → **Block time** tomorrow 3–4 PM | The block appears; booking into it needs an overbook reason | |
| 18 | Settings → **Provider and licensure** (admin) | WA, CA, CO (orange "Expiring") and RI licences. Edit CO to expire yesterday, then try a CO booking: refused. Restore the date afterwards | |
| 19 | Settings → **Practice and locations** | Practice identity (NPI checked), locations with POS codes, weekly hours; add a closure date and the calendar shows that day as Closed | |
| 20 | Settings → **Messaging and reminders** | 72/24/2-hour switches, quiet hours, templates with live preview and SMS segment count. Typing "medication" into a template is refused. "Recent reminders" lists queued and sent messages | |
| 21 | With the worker running during the day | Reminders for tomorrow's visits move from Queued to Sent; `services/worker/outbox.log` shows the exact text. At night they stay Queued (quiet hours) | |
| 22 | Simulate a reply: `curl -X POST http://127.0.0.1:3110/webhooks/sms -d "From=4255550102&Body=STOP"` | Daniel Okafor's chart shows "Opted out of text messages"; send `Body=START` to undo | |

## D. Design conformance

- Calendar layout refinement: 112 px/hour, inset appointment cards, a scrollable grid with sticky weekday/time headings, wider month cells, and wrapping toolbar groups. Browser checks cover 1440, 1024 and 390 px; patient names fit vertically in all seeded visits, including the 15-minute visit.

- The Phase 2 row of SYSTEM-DESIGN.md §12 is delivered. ADR-007 is Accepted; Pub/Sub replaces the worker's clock when deployed to GCP (ADR-009).
- §6 lists the new enforcement points: `appointment-rules`, worker delivery and template checks.

## Known limits

- Texts and emails are recorded, not sent, until a vendor and BAA are in place (D7). 10DLC registration is needed before real texting.
- A patient in an unlicensed state can be *checked in* (it's a fact), but nothing stops starting that visit until the encounter workspace adds the rule in Phase 3.
- Late-cancel and no-show fees for self-pay patients are posted with the ledger in Phase 8.
- The "Appointment" quick action creates visits; "Message" and "Task" arrive in Phase 6.

## Sign-off

Reviewer: ____________ Date: ________ Result: ☐ accepted ☐ changes requested
Notes:

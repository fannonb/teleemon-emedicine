# Phase 0 verification: foundation and design system

Status: **ready for review** · built 15 October 2026 · synthetic data only

## Before you start

1. The Medplum stack is running (`..\Start-Medplum.ps1`). The local server config now also allows `http://localhost:3100`.
2. From `teleemon/`: `npm run seed` (safe to re-run; each new day adds that day's visits), then `npm run dev`.
3. Open http://localhost:3100 and sign in as `admin@teleemon.test` / `Teleemon-Local-2026`. (Since Phase 1 the practice has its own project; see phase-1.md.)

## Checklist

| # | Check | Expected | Pass? |
|---|---|---|---|
| 1 | Open any URL while signed out, e.g. `/today` | Redirects to the branded sign-in page | |
| 2 | Sign in | Lands on **Today**, greeted by first name, with today's date | |
| 3 | Today's schedule | 9 synthetic visits in time order. Past visits are dimmed; the next open visit is highlighted and tagged **Next**. Each row shows modality, state badge and status | |
| 4 | Time zones | Rhode Island and Colorado patients also show their local time (ET/MT) under the Pacific time | |
| 5 | Unlicensed state | Elijah Morales (4:30 PM) shows a red **TX · not licensed** badge, and Alerts lists it | |
| 6 | Licence expiry | Alerts shows "CO licence expires in 45 days" | |
| 7 | MFA alert | While MFA is off, Alerts shows "Two-factor sign-in is not enforced" | |
| 8 | Work queues | **Patient messages = 2** (oldest about 1 day, in orange) and **My tasks = 3** (oldest about 2 days, in red). The other tiles are dashed and say which phase builds them; none shows a made-up number | |
| 9 | Navigation | Five areas plus Settings. Every unbuilt item shows a phase tag (P1, P2…) and opens a **Planned** page with its purpose, acceptance criteria and phase | |
| 10 | Role preview | Account menu → Preview as **Biller**: the sidebar shows only Today, Inbox, Find patient, Tasks, the Billing area, Reports and Settings (only Payers, fees and codes inside). An amber "Previewing" note appears in the sidebar. Exit restores everything | |
| 11 | Patient search | Ctrl+K → type `thor`, `04/12/1991` or `425-555-0101` → the patient appears; Enter opens their (planned) chart | |
| 12 | Dark mode | The moon icon switches themes; the choice survives a reload | |
| 13 | Tablet width | At about 800 px the sidebar collapses behind the menu button and the schedule rows wrap cleanly | |
| 14 | Idle sign-out | Set `TELEEMON_IDLE_MINUTES=2` in `apps/staff/.env`, restart dev, and wait: a warning counts down from 60 seconds, then you're signed out with an explanation | |
| 15 | MFA enforcement | `npm run setup -- --mfa`, sign out, sign in: you must enrol an authenticator app (QR code) before reaching any page. Scripts keep working through the service client | |
| 16 | Matches the system design | Phase 0 row of SYSTEM-DESIGN.md §12 is delivered (staff app shell, FHIR constants, setup/seed scripts, MFA setting); ADR-001 and ADR-002 are Accepted | |

To turn MFA off again: `npm run setup -- --no-mfa`. If you lose the authenticator: a project admin calls `POST /admin/projects/{projectId}/members/{membershipId}/mfa/reset`.

## Known limits (by design for Phase 0)

- The role preview changes the UI only. Server-side AccessPolicies that enforce roles arrive in Phase 1 (P43).
- Chart pages, Inbox, Tasks and Calendar are Planned pages; their tile counts link to them.
- The JavaScript bundle is about 260 kB gzipped; route-level code splitting arrives in Phase 1.

## Sign-off

Reviewer: ____________ Date: ________ Result: ☐ accepted ☐ changes requested
Notes:

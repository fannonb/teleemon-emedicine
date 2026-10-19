# Phase 3 verification: encounter documentation

Status: **ready for review** · built 16 October 2026 · synthetic data only · no vendors needed

## Before you start

1. From `teleemon/`: `npm run setup` (adds the note and encounter Bots and the provider's signed-note lock), then `npm run seed`.
2. Run `npm run dev` (and `npm run worker` if you want reminders). Open http://localhost:3100. Password for every account: `Teleemon-Local-2026`.
3. Notes are clinical: sign in as **provider@teleemon.test** for sections B–D.

## A. Server-side enforcement (no UI involved)

Run `npm run test:phase3` (13 regressions), then `npm run verify:phase3`. Expected: **33 PASS, 0 FAIL**. It covers:
- a visit can't start in Texas;
- drafts always save;
- signing is refused without a diagnosis, with 90836 and only 20 minutes, with an add-on and time-based E/M, or with active suicidal ideation and no safety plan;
- an administrator can't sign the provider's note;
- an administrator cannot impersonate the provider by supplying their attester reference;
- a signed narrative must match the structured content, and `amended` cannot bypass validation;
- signed notes can't be edited or deleted by anyone;
- addenda need a reason and leave the original unchanged;
- addenda cannot cross patient or encounter boundaries;
- a calendar update conflict rolls back signing and encounter completion; all three writes succeed together;
- late entries are flagged;
- coding helpers;
- Word exports exclude private psychotherapy notes, and the after-visit summary excludes MSE and risk details;
- template changes affect new notes only.

Signed notes can't be deleted, by design. The script's signed test notes and linked synthetic appointment therefore stay on one synthetic patient, **Test Verification**. `verify:phase1` and `verify:phase2` should still pass.

Atomic signing requires the Medplum project feature `transaction-bundles`. Setup enables it (a Medplum super administrator is needed to change project features). Existing local projects can run `npm run setup -- --transactions-only` without changing authentication settings. The app refuses to sign atomically if the feature is absent. Sign in again after enabling it so the session sees the new project feature.

## B. Starting and documenting a visit

| # | Check | Expected | Pass? |
|---|---|---|---|
| 1 | Calendar → open a booked visit for today → **Check in** (WA) → **Start visit** | Opens the encounter workspace. The context bar shows the patient, "WA · licensed", consent status and start time | |
| 2 | Open **Elijah Morales** (checked in from Texas) → Start visit | Refused: "This visit can't start: … not licensed in TX" | |
| 3 | Clinical work → **Encounters** | Ready to start (checked-in patients), In progress, Recently finished, with note status badges | |
| 4 | Type `.plan-cont` and a space in Plan | Expands to the smart phrase | |
| 5 | MSE → "Fill empty domains with normal findings", then type the mood in the patient's words | Pick-lists filled; the mood stays free text | |
| 6 | Risk: choose "Active suicidal ideation without plan" | "Safety plan reviewed" turns red and becomes required | |
| 7 | Diagnoses: add from the problem list, add a new one from the catalogue, reorder | A/B/C pointers follow the order; the new one also appears on the problem list | |
| 8 | Measures section | Shows the latest PHQ-9/GAD-7 with previous scores | |
| 9 | (Med management + psychotherapy visit) enter 40 minutes | "40 minutes supports add-on 90836"; Billing offers "Use 90836" and switches E/M to decision making | |
| 10 | Billing: choose Moderate | Suggests 99214 with the reason; POS 10 and modifier 95 for video from home | |
| 11 | Wait 10 seconds after typing | "Saved hh:mm" appears; reloading the page keeps your text | |
| 12 | Last note tab / Copy forward | For a patient with a signed note, "Copy forward" fills Assessment or Plan and labels it "Copied from last note · review" | |
| 12a | Edit Plan, immediately click Notes to sign, reopen the draft | "Saving before leaving…" appears; navigation waits for saving, and the new text survives. A failed save keeps the editor open with an error | |
| 12b | Type while a draft is saving, then Review & sign | The save queue writes the latest revision before opening review; newer edits are never marked saved by an older request | |

## C. Review, sign and amend

| # | Check | Expected | Pass? |
|---|---|---|---|
| 13 | **Review & sign** with something missing | A paper-style preview; the checklist lists what's missing by section; the affected sections are highlighted orange in the editor | |
| 14 | Complete the note, tick the attestation, **Sign note** | Green "Signed" stamp with name and time; the visit and appointment are completed; Today's "Unsigned notes" count drops | |
| 15 | Try to change the signed note | No edit controls; the server would refuse anyway (see A) | |
| 16 | **Add addendum or correction** | Needs a reason; appears in blue under the original with its own signature time | |
| 17 | Clinical work → **Notes to sign** | Drafts oldest first, "Ready to sign" or the number of items left; visits over 72 hours show "late" | |
| 18 | Sign in as admin, open a draft's review page | "Only the visit's provider can sign this note"; the Sign button is disabled | |
| 18a | Open an older signed note whose encounter/calendar update did not complete | "Visit completion is pending" offers Complete visit; retries do not modify the signed note and errors remain visible | |

## D. Exports and patient copy

| # | Check | Expected | Pass? |
|---|---|---|---|
| 19 | Signed note → Export → **Session summary** → Word | A .docx with letterhead, patient and visit table (location state and modality), medications, MSE, measures, risk, assessment and diagnoses, plan, psychotherapy time, attestation and AI statement when applicable. **It opens in Microsoft Word and Google Docs** | |
| 20 | Full note → Word; Patient copy → Print / PDF | The full note has every section and the addenda. The patient copy has only the plan, next visit and 988/911 | |
| 21 | Write something in "Private psychotherapy notes", sign, export | It appears in none of the exports | |
| 22 | **Release to patient** | "Released …"; the chart's Documents tab shows it under "After-visit summaries" (patients see it in the portal from Phase 7) | |
| 23 | Chart → Encounters | Note column shows Draft / Signed / Signed · amended / Late; clicking opens the note. Front desk sees "Restricted" | |
| 24 | Chart → Encounters → **New note** → Telephone note | Asks where the patient is now; starts an encounter with the telephone template (no visit code needed) | |
| 25 | Settings → **Templates and questionnaires** | Default text per template and section; smart phrases (add, edit, remove; invalid or duplicate triggers are refused). Changes apply to new notes only | |

## E. Design conformance

- The Phase 3 row of SYSTEM-DESIGN.md §12 is delivered; ADR-014 (browser-side exports) is recorded.
- §6 lists the new enforcement points: `note-rules`, `encounter-rules`, the provider's Composition write constraint, and the export builders.

## Known limits

- Charges are not yet created from signed notes. The billing panel captures the codes, and P30 (Phase 8) turns them into charges.
- "Prescribe" and "Order lab" are visible but disabled until Phases 5 and 9.
- The AI draft and the live transcript arrive in Phase 4. The workspace shows where they will appear.
- Two people editing the same draft at once: the last save wins. A version check with a warning is planned for hardening (Phase 9).
- The E/M and add-on rules follow the scope and current CPT guidance as summarised there; the billing advisor confirms them before go-live.

## Sign-off

Reviewer: ____________ Date: ________ Result: ☐ accepted ☐ changes requested
Notes:

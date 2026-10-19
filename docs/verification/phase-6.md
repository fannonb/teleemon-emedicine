# Phase 6 verification: inbox, tasks, documents, fax and manual labs

Built locally: 16 October 2026. Status: **built for synthetic review; fax vendor pending**. No fax vendor has been contracted. Inbound faxes come through the vendor-neutral worker webhook or `npm run fax:simulate`. Outbound faxes go to the log adapter (`services/worker/outbox.log`), so nothing is transmitted.

## What was built

| Area | Delivered |
|---|---|
| Rules (`packages/core/src/inbox.ts`, `labs.ts`) | • Inbox kinds and default teams.<br>• SLAs: faxes 1 business day, results 2.<br>• Overdue status.<br>• Closing without completion requires a reason.<br>• Recurring tasks: every business day, weekly, every 2 weeks, monthly or every 3 months.<br>• Document matching, which requires a fresh personal confirmation.<br>• Fax text parsing and the patient/category suggestion.<br>• Lab test catalogue (LOINC) and lab orders. |
| `task-rules` pre-commit Bot (was `pdmp-rules`, renamed in place) | • A task closed without completion needs a reason.<br>• A filed fax review cannot be reopened.<br>• All PDMP rules from Phase 5 still apply. |
| `document-rules` pre-commit Bot | • A fax is filed to a patient only with a confirmation made by the person filing, within the last 10 minutes.<br>• Removing a fax needs a reason; it is never deleted.<br>• A fax cannot be re-typed to dodge these rules.<br>• A lab result is reviewed under the reviewer's own name, and the review is final. |
| `communication-rules` pre-commit Bot | • An unmatched text is linked to a patient only after a confirmed match.<br>• Closing a message requires a note on how it was handled. |
| `result-review` Bot | A lab result filed to a patient creates one review task for the ordering provider (or the patient's provider). Recording the review completes the task and the lab order. |
| `recurring-tasks` Bot | Completing a recurring task creates the next one, once and never in the past. |
| Access policy | • Front desk can file results but cannot record a result review.<br>• No role can delete faxes or tasks.<br>• The worker can store faxes and read documents to fax them. |
| Worker | • Inbound fax intake: idempotent on the vendor fax id; stores the PDF, makes a suggestion and creates a review task.<br>• Outbound fax sending through the log adapter; a failure creates an urgent task.<br>• Unknown-number texts are kept for review instead of dropped.<br>• Daily summary email after 7:00 AM Pacific: open and overdue task counts only, no patient data, one per person per day. |
| UI | • **P03 Inbox**: messages, faxes, results, refills, safety items and tasks. Scope it to me, me and my team, or everything. Shows SLA due and overdue, and supports assign, return to queue, move team, and close with reason. Includes a message drawer to match, close as handled, remove, or create a follow-up task.<br>• **P29 Tasks**: assigned to me, team queue, overdue, done. Create and edit tasks with patient, assignee, team, due date, priority and repeat.<br>• **P28 Documents & fax**: fax queue with PDF preview, suggestion, confirm patient, category, link to a lab order, file or remove. Also lists sent faxes and removed faxes.<br>• **P16 Labs** chart tab: order labs and print the requisition, add a result, provider review (abnormal flag and comment), and monitoring reminders.<br>• **Fax** action on each chart document, with a disclosure attestation.<br>• Today's Faxes to file, Results to review and Patient messages tiles now show live counts. |

## Run locally

```powershell
npm run setup -- --inbox-only   # Bots, policies, worker access; then sign out and back in
npm run worker                  # sends queued faxes (log adapter) and daily summaries
npm run fax:simulate            # three synthetic faxes: a lab result, a referral, a billing cover sheet
npm run dev
npm run test:phase6
npm run verify:phase6
```

17 October 2026 audit: [findings, corrections and release gates](phase-5-6-audit.md). Current evidence: 19 regression tests and 37 local API checks passed. Sandbox delivery is shown as **Logged (sandbox)**.

## Original evidence (16 October 2026)

| Check | Result |
|---|---|
| Phase 6 regression tests | 11 passed |
| Phase 6 checks against local Medplum (role logins, deployed Bots, worker code) | 32 passed |
| Phase 5 regression tests | 13 passed; the PDMP test now gives a reason when marking a check entered-in-error, as all tasks must |
| Phases 1–5 server checks; Phases 1, 3 and 4 regression tests | All passed |
| Typecheck and build | Passed |

## Your checklist (synthetic data only)

1. Run `npm run fax:simulate`. As front desk, open **Documents & fax**.
   - The lab fax suggests Maya Thornton with high confidence and lab report as the category.
   - Filing stays disabled until you tick the confirmation.
   - After filing, the provider's **Results to review** count goes up.
2. Remove the billing cover sheet. A reason is required. It then appears under **Removed**.
3. As provider, open Maya's **Labs** tab and review the result. The review task and the lab order complete, and the review can't be edited afterwards.
4. In **Labs**, use **Order labs** and print the requisition. Add a result linked to the order.
5. Send a text to the worker webhook from an unknown number (for example with the Phase 2 SMS test). It appears in **Inbox → Messages** as **Unmatched**. Match it with the confirmation tick, then close it as handled with a note.
6. In **Tasks**, create a weekly task and complete it. The next occurrence appears. Cancelling any task asks for a reason.
7. On a chart document, choose **Fax**. Number 000-000-0000 simulates a failure, which creates an urgent task. Other numbers show **Sent** under Documents & fax.
8. Compare the Today tiles with the lists behind them; the counts should match.

## Still required before real use

- **Fax vendor** contract and BAA (for example eFax Corporate, Documo or SRFax). Then:
  - replace the loopback-only webhook with the vendor's signature verification;
  - use the vendor's OCR text for suggestions;
  - add a real cover page.
- **AI document classification** (scope: "AI-suggested patient and category"). The current suggestions are rule-based and run locally. An OpenAI-based classifier would need the same BAA and a synthetic-only gate as the scribe.
- **Business-day SLAs** don't account for holidays yet.
- **Electronic lab ordering and results** (HL7 or Health Gorilla) remain Phase 9. Results are PDFs reviewed as a whole; individual values are not stored.

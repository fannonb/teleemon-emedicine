# Phase 3 implementation review

Reviewed 16 October 2026 against IMPLEMENTATION-PLAN.md (P21, P23, P24, P41), SYSTEM-DESIGN.md and the Phase 3 verification checklist.

**Original review result: changes required before Phase 3 sign-off.** The findings below preserve the original evidence. Remediation on 16 October 2026 addresses all five numbered findings: trusted-author validation, canonical narrative checks, revision-aware navigation saves, amendment/lifecycle validation and transactional signing with recovery for older partial completions. See phase-3.md for the expanded acceptance gate.

## Remediation verification — 16 October 2026

- `npm run typecheck` and `npm run build`: passed (existing main-bundle size warning remains).
- `npm run test:phase3`: 13 passed; `npm run verify:phase3`: 33 passed, 0 failed.
- `npm run test:phase1`: 8 passed; live Phase 1 gate: 38 passed; live Phase 2 gate: passed.
- Browser: typing Plan and immediately navigating to Notes to sign now saves before leaving; the new text survives reopening. Review & sign opens only after the latest text is stored.
- Browser: Complete visit successfully recovered a synthetic signed visit; the pending banner disappeared and the signed note stayed unchanged.
- Local Bots were deployed with `npm run setup -- --bots-only`. The local project's `transaction-bundles` feature was enabled with `--transactions-only`. Without this feature Medplum 5.2.4 can silently apply transaction bundles as independent writes; signing now refuses to proceed if the feature is absent.
- Live failure injection: a stale appointment version rolled back both the signature and encounter completion. Retrying normally committed all three records.
- A shared measures snapshot and narrative builder preserve the reviewed text without duplicating measure comments. The Bot binds the signer to Medplum's trusted pre-commit author and assigns signature time and the late flag.

The original findings below are retained as historical evidence. Export rendering in Word/Google Docs/PDF and the other non-numbered risks remain subject to their stated verification limits.

## Original review checks

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run build` | Passed; existing large main-bundle warning remains |
| `npm run verify:phase3` against local Medplum | 26 PASS, 0 FAIL |
| `npm run test:phase1` | 8 passed |
| Additional local API signing probe | Unauthorized signer attribution and inconsistent signed narrative accepted |
| Isolated note-rules handler probes | Unvalidated `amended` creation and cross-patient amendment accepted |
| Browser review as synthetic provider | Workspace and review screen load; smart phrase expands; normal autosave survives reload; leaving before autosave loses edits |

The initial server-script failure was a sandbox restriction on localhost access. The same script passed when localhost access was permitted. It was not a Medplum outage.

## Findings, ordered by priority

### 1. P1 — Authenticate the signer, rather than trusting the attester supplied in the request

Location: `bots/src/note-rules.ts:28–37`.

The Bot compares `Composition.attester.party` with the encounter's participant list, but does not compare it with the authenticated requester. A caller can put the provider's reference in the request. The access policy does not add an equivalent requester constraint.

**Confirmed against the running API:** signed in as `admin@teleemon.test`, created a final Composition on the synthetic Test Verification patient, and supplied the provider's attester reference. Medplum accepted it as `final`, although the requester's profile differed from the signer. Synthetic proof note: `Composition/b570c86f-671b-4ea4-93d0-127a56f7ddad`.

The existing administrator test uses the administrator's own attester reference, so it misses this bypass. Bind the legal attester to the trusted request identity and the encounter provider. Generate or verify attestation timestamps on the server. Add a test where the administrator submits the provider's identity.

### 2. P1 — Validate the content that is actually signed and exported

Location: `bots/src/note-rules.ts:50–62`; `apps/staff/src/pages/encounters/NotePage.tsx:38–39, 233`.

Signing validates `EXT.noteData` JSON. The paper preview and full/session exports use the independently supplied `Composition.section` narrative. There is no server-side equivalence check or canonical narrative generation.

**Confirmed against the running API:** the proof note above contains valid structured JSON but only a Plan narrative explicitly omitting the diagnosis and assessment. It was accepted as final. Consequently, the system can validate one representation while displaying/exporting a different one.

Generate the signed narrative from validated structured data on the server, or reject inconsistent content. Ensure the preview, signed record and exports share that canonical representation. Test valid JSON paired with a missing or contradictory narrative.

### 3. P1 — Prevent loss of edits during navigation and saves

Location: `apps/staff/src/pages/encounters/EncounterWorkspacePage.tsx:72–105, 129–132`.

**Confirmed in the browser:** changed the Plan on a disposable synthetic draft to `UNSAVED-NAVIGATION-REVIEW-MARKER`, immediately clicked Notes to sign, and reopened the visit. The Plan reverted to `Original persisted synthetic review plan.` No save or navigation warning intervened. `beforeunload` does not protect React Router navigation, and autosave runs only every ten seconds.

There is also a related source-level race: a completed save always clears `dirty`, including when newer edits arrived while that request was running. Review & sign can receive an older Composition when a save is already in progress.

Flush or block internal navigation while dirty; serialize saves; track a revision so an older request cannot mark newer edits saved; and have review await the latest save. Add coverage for navigating within the ten-second interval and typing during an in-flight save.

### 4. P1 — Close alternate signing and amendment validation paths

Location: `bots/src/note-rules.ts:25–26, 39–47`.

**Confirmed with isolated handler probes (not persisted):**

- A newly created `status: amended` Composition with no attester or structured content returns true because all non-final statuses skip validation. Yet `amended` is included in the locked statuses. The UI also recognizes only `final` as signed.
- An amendment whose patient differs from its signed target returns true. The Bot verifies only that the target is final, not that the target's patient and encounter match the amendment.

Constrain supported lifecycle transitions, reject unsupported direct `amended` creation, and bind amendments to the original patient and encounter. Cover these cases with direct API tests as well as handler tests.

### 5. P2 — Make signing and visit completion recoverable

Location: `apps/staff/src/pages/encounters/NotePage.tsx:104–105`; `apps/staff/src/fhir/visits.ts:174–178`.

Source review shows three separate writes: sign the note, finish the encounter, fulfill the appointment. If the second write fails, the note is already permanently locked while the page reports a signing error. The signed-note view has no completion retry. Appointment update errors are swallowed entirely, allowing success while the calendar remains booked or checked in.

Use a supported transactional approach or an idempotent server workflow with durable retries and visible completion status. Add a failure test for each write. This is a source-level failure-path finding; a network failure was not injected during this review.

## What is implemented well

The editor, structured MSE, risk checklist, diagnosis ordering, billing suggestions, templates and smart phrases form a usable documentation workflow. Shared core rules keep the editor and Bot aligned on required fields and psychotherapy add-on durations. Normal signed-note edits/deletes are blocked, front-desk Composition access is refused, addenda preserve the original, and late-entry flags work through the normal helpers. Export builders exclude private psychotherapy text and keep the patient copy narrower than the clinical note. The Word module is loaded only when needed.

The workspace has clear section grouping and a useful reference/billing column. Further visual polish should follow the reliability fixes: the MSE fill action uses a negative top margin, some clinical inputs lack accessible labels, and clinical pages retain internal P21/P23 labels in visible headings.

## Verification limits and remaining risks

- Existing Word checks inspect generated OOXML; this review did not open the exported document in Microsoft Word or Google Docs, or visually verify browser PDF pagination. Those acceptance items remain unconfirmed.
- The after-visit-summary release flow is implemented in source; portal access correctly remains Phase 7. This review did not release a document or verify future portal permissions.
- Private psychotherapy text is excluded from rendered exports, but is stored inside the same `EXT.noteData` Composition payload and uses the same access rules as the rest of the note. The UI's claim that it is kept separately should be reconciled with that storage/access model before clinical use.
- Signed exports obtain medications from the current chart, rather than a medication snapshot captured at signing. Confirm the intended visit-record semantics before relying on historical exports.
- Phase 1 and 2 live API suites were not rerun in this review. Phase 1 unit regression tests were rerun and passed.

## Test data and implementation changes

Only local synthetic records were used. The standard verification suite retains signed notes on Test Verification by design. The extra signature/content probe left one immutable synthetic signed proof note on that same patient. Disposable unsigned review resources are removed after browser verification. No application implementation was changed by this review.

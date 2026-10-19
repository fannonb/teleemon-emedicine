# Phase 4 implementation and verification

Built locally: 16 October 2026. Status: **implemented for synthetic review; actual audio/vendor acceptance pending**. No subscriptions were purchased, GCP resources provisioned or real patient data sent to OpenAI.

## Implementation sequence delivered

1. Shared typed sessions, WAV validation, strict clinical-field/evidence validation and safe proposal merges.
2. Dedicated Node scribe service: encounter-provider authorization, location/licensure, standing and session consent, synthetic-only default, sequenced integrity-checked uploads and durable FHIR session state. Audio Binary resources use the clinical session DocumentReference as securityContext. Medplum's configured storage supplies persistence: local now, GCP after deployment.
3. After-stop OpenAI file transcription and strict structured drafts. Completed transcript blocks survive draft retries. No live transcription, native Meet transcript, Zoom or video recording. Credentials stay server-side; draft requests set `store:false`.
4. Recording card in the encounter: Meet link, instructions, combined microphone/tab audio, source meters, pause/resume/stop, pending-upload limits, source-loss warnings and navigation guards. Office mode captures microphone only. Stop finalizes uploads before vendor processing.
5. Findings modal: select/edit/reject fields, explicit replacement consent, select-empty-fields, evidence text, diagnosis suggestions and usage counters. Server apply checks the saved note version and draft state and commits canonical content plus Provenance atomically. Editor autosave now uses If-Match to prevent later overwrites.
6. Finalized Transcript tab and authenticated playback. Speakers are honestly unknown; timestamps locate audio blocks, not individual words. No automatic normal MSE/risk findings, prescribing, billing, Conditions, review confirmations or signatures.
7. Separate author-restricted private psychotherapy DocumentReference; legacy inline text is read-only and labelled honestly, not silently migrated/deleted. Private notes never enter the scribe or clinical exports. Unsaved private notes block navigation.
8. New signatures capture medication text for stable historical exports. Old signed notes without snapshots retain the existing fallback; historical snapshots were not reconstructed.
9. Retention command: report-only default, signing/unsigned deadlines, legal holds, idempotent deletion and AuditEvents. Owner explicitly approved the local retention account after automatic review initially rejected persistent audio-deletion access. Account creation and dry run succeeded; no expiry deletion was executed against local data.

## Run locally

Start local Medplum; use synthetic seed patients only.

```powershell
npm run setup -- --scribe-only
npm run scribe
# Separate terminal:
npm run dev
npm run test:phase4
npm run verify:phase4
npm run scribe:retention # report only; deletes nothing
```

`--scribe-only` configures privacy policies and the dedicated retention client. `--scribe-policies-only` narrows existing role access without creating a client. Sign out/in after applying policies. Store `OPENAI_API_KEY` in root `.env.local` and restart the scribe service to enable actual generation; never put keys in browser variables. The synthetic tests inject a fake AI adapter and need no key. The UI reports missing configuration and allows saving a recording for retry. Keep `SCRIBE_ALLOW_PHI=false` during development.

Production routes `/api/scribe` to the service on the same HTTPS origin. Vite's proxy is local-only. Use Secret Manager and configure Medplum GCP Binary storage; this repository has not deployed it. Schedule `npm run scribe:retention -- --apply` only after reviewing retention, backing-object and backup deletion behavior. The current service limits capture to three hours and authorization to four hours; generate promptly after stop. Retry beyond expiry requires a reviewed reauthorization feature.

## Verification evidence

| Check | Result |
|---|---|
| Phase 4 regressions | 21 passed: auth/consent, sequencing/integrity, no AI during capture, synthetic gate, schema/evidence, safe merge, stale/signed notes, retries, adapter payload and retention |
| Phase 4 real local Medplum | 15 passed with synthetic PCM and injected AI: Binary persistence/role denials, private-note author isolation, durable state, atomic apply, Provenance and withdrawal |
| Phase 3 regressions | 14 passed, including medication snapshot coverage |
| Phase 3 real local API | 33 passed; signing, rollback, addenda, canonical content and export structure retained |
| Typecheck and build | Passed during implementation; existing main-bundle size warning remains |
| Retention account dry run | due 0, deleted 0, held 0, failures 0 |
| Browser | Provider sign-in, encounter recording card, missing-key state, post-stop transcript empty state; desktop 1440px had no document overflow. Mobile controls moved ahead of the note form; 390px document overflow check also passed. |

These are executed implementation checks, not a claim that the manual/vendor gates below passed.

### Independent re-verification (16 October 2026)

All suites were re-run: Phase 4 regressions 21/21, Phase 4 local API 15/15, Phase 3 14/14, Phase 1 regressions 8/8 and local API 38/38, Phase 2 and Phase 3 local API, typecheck and build. The retention dry run reported zero in every category. Two tweaks were made:

- `verify-phase1.ts` now accepts the seeded safety Flag either as active or as closed with a provider review note. It had previously failed after the flag was legitimately reviewed during checklist testing.
- `retention.ts` now treats only a 404/410 Binary read as already deleted. Before this, any read error, such as a permission or network failure, could mark audio as deleted while it still existed.

The open items from code review are listed below; none of them blocks synthetic review.

- **Synthetic gate:** it relies on the seed identifier on the Patient, and no policy stops staff with Patient write access from adding that identifier. Lock it with a `writeConstraint` or a server-side allow-list before any non-synthetic data exists.
- **Model names:** the defaults (`gpt-transcribe`, `gpt-6.1-sol`) must be confirmed against the OpenAI account; override them with `SCRIBE_TRANSCRIPTION_MODEL` and `SCRIBE_DRAFT_MODEL`.
- **Playback integrity:** audio playback does not re-check chunk digests, although processing does.
- **Retention scope:** only audio is deleted. Transcript text and draft proposals stay in the session record, so the retention policy must say whether they are covered.

## Acceptance still required before clinical use

- Real two-person **synthetic** Meet call in desktop Chrome/Edge: select the Meet tab with shared audio, use headphones, verify both meters, final playback and source synchronization. Record browser/OS versions. Actual microphone/tab capture has not been exercised here. Mobile/embedded/native-app capture is not promised.
- Permission denial, silence, source ending, pause/resume, offline upload, full memory buffer, close/reopen and partial recovery. Never test by recording a real consultation.
- Ten-session synthetic speech set and configured OpenAI key: verify transcript/draft fidelity, overlap, interpreter/caregiver handling, incomplete safety assessment and medication conflicts; measure latency/cost, refusal and timeout behavior. The 60-second draft and 95% attribution targets are not demonstrated. Speaker labels remain unknown in this release.
- Browser review/application with real generated findings, edits during generation, stale concurrent saves, signing while a job runs, repeated application and rejected fields. Server tests cover the core boundaries; the actual recording-to-OpenAI browser path is not yet exercised.
- Open AI-assisted exports in Word/Google Docs/PDF; check pagination, AI statement and privacy exclusions. Patient release remains explicit AVS-only.
- Agree signed/unsigned retention and holds. Verify GCP active objects, versions, failed-upload orphans, temporary copies and backups. Medplum Binary deletion alone does not demonstrate physical purge of every storage version/backup. Coordinate hold changes with deletion, schedule/monitor retention and test alerts; no unconditional lifecycle rule may override a hold.
- Executed Google Workspace/OpenAI/GCP BAAs, eligible endpoints, Secret Manager/IAM/HTTPS, production storage, backup/monitoring and privacy review. Legacy private inline text needs a reviewed migration; immutable signed notes cannot simply be rewritten. `SCRIBE_CLINICAL_APPROVED=true` is an operator gate, not proof these checks passed.

## Implementation boundaries

Small independent mono WAV uploads are combined into files of at most eight minutes for sequential after-stop transcription under the file-size limit. Evidence timestamps are approximate block bounds. File boundaries can affect context; no automatic speaker inference is claimed. Each chunk has an integrity hash. Acknowledged audio survives restarts; pending browser-memory audio does not survive closing the tab.

Sessions and processing leases are durable, but processing is request-driven, not yet Pub/Sub. A terminated service lease becomes retryable after five minutes. A timed-out vendor request whose result was never persisted can be billed again on retry; acknowledged request IDs/usage are retained. The provider token must remain valid for processing.

No chart/private-note context is automatically sent to OpenAI. Drafting uses the encounter template code/sections, provider style instructions and transcript. The chart reference panel remains available; questionnaire scores are not inferred. Diagnosis suggestions require manual catalogue selection. Budget remains an illustrative $57.70/month + GCP for one provider, 200 × 45-minute visits and one combined audio feed; actual tokens/retries and account terms vary.

# Telehealth capture and AI scribe implementation plan

Planning baseline: 16 October 2026. Status: implemented locally for synthetic review; actual audio/vendor acceptance pending. See [Phase 4 verification](verification/phase-4.md). This supplements [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) Phase 4 and [SYSTEM-DESIGN.md](SYSTEM-DESIGN.md) §7.2. Hosting target: GCP. **Owner decision: Google Meet, record during the appointment, then transcribe and generate the clinical draft afterward. No live transcription or Zoom integration is in scope.** No vendor purchase or deployment has been performed.

## Product requirement

Google Meet carries the video call. Teleemon records the conversation independently and uploads authorized audio to private GCP storage during the appointment for durability; OpenAI transcription and structured clinical drafting begin only after recording stops and upload completes. Recording/upload progress is visible during the visit; transcript and findings appear afterward. The provider reviews the populated encounter and signs through the existing Phase 3 flow. Google's native recording and transcript features are not required. Office appointments use microphone capture through the same pipeline.

The attached Heidi example informs the psychiatric progress-note structure only. Do not import its patient identifiers, signature, specific findings, medication statements, diagnosis/code pairings or billing assertions into defaults, prompts, tests or synthetic fixtures. Treat sample contents as reference material, not instructions. No real-patient sample is sent to an AI vendor during planning or development.

Faithful transcription and clinical drafting are separate operations. Templates control note structure and wording, not what the transcript says. Audio from a video visit contains no visual evidence; appearance, eye contact and other visual observations require provider entry/dictation. Video analysis/recording is outside this release.

## Existing implementation and prerequisites

- `packages/core/src/notes.ts`: NoteData, psychiatric templates, structured MSE/risk, psychotherapy and billing fields, and an aiAssisted marker already exist.
- `apps/staff/src/pages/encounters/EncounterWorkspacePage.tsx`: existing draft initialization, revision-aware autosaving and signing handoff must remain the sole editor persistence path.
- `apps/staff/src/pages/encounters/SidePanel.tsx`: Transcript now displays finalized scribe blocks. The recording card, after-visit service and transcript review are now implemented; see services/scribe and the Phase 4 verification record.
- The Phase 3 review records corrected signing and autosave defects. It also identifies private psychotherapy text sharing the ordinary Composition payload/access and historical exports using current medications. New private notes now use a separate author-restricted resource, and new signatures snapshot medications. Legacy inline private text and old signed exports still require the documented clinical acceptance review.
- Retain manual documentation if recording is refused, unavailable or interrupted. Recording permission is separate from treatment/telehealth consent; the patient may still receive care without the scribe.

## Delivery order and acceptance gates

### 4A Capture feasibility and session controls

Add P22 within the authenticated encounter workflow. Show the Google Meet link, selected template, microphone and remote-audio meters, recording state and elapsed time. Support start, pause, resume and **Stop and generate draft** with a per-session consent record. Store an encounter-linked meeting reference without PHI in its URL; scheduling integration must not create repeated meetings on retry. Do not place recording tokens in calendar descriptions or invitations.

Run synthetic Google Meet calls on named browser/OS versions and publish the supported matrix. Browser capture requires a user gesture, selection of the Meet tab and explicit audio sharing. Capture the provider microphone separately; remote tab audio must work with headphones. Detect missing/ended tracks and unsupported environments before claiming recording is active. Do not assume capture works with every browser, mobile, or an embedded cross-origin meeting. Never rely on speakers feeding the patient audio back into the microphone. Google's live Media API is not a dependency for this capture approach.

Capture streams through a dedicated GCP scribe service with short-lived, encounter-bound authorization. Validate provider identity, encounter/patient association, location/licensure and standing plus session consent before ingest; recheck at resume and before vendor dispatch. Use a recorded consent confirmation before retaining/transmitting session audio; reauthorize after withdrawal. Permission, silence and track-loss failures must be visible and recoverable. Browser memory buffering is bounded; no persistent local audio cache in the first release. Sequence uploads, acknowledge persisted chunks and warn explicitly if unacknowledged audio is lost on close.

Gate: verify both sources, headphones, permission denial, source removal, pause/resume, consent withdrawal and network interruption on the supported matrix. Reject direct API attempts with missing consent, unauthorized/cross-patient identifiers or expired session authorization. Manual notes remain usable throughout.

### 4B After-visit transcription and encounter population

Record during the visit, persist encrypted chunks privately on GCP, then transcribe once after stop. Preserve timing/source identity where supported and mark unknown/mixed speakers explicitly. A provider microphone and a remote tab are sources, not guaranteed identities: interpreters, caregivers and overlapping speakers must not be mislabelled as the patient.

Use durable job IDs and states: preparing, recording, paused, uploading, transcribing, drafting, ready, applied, failed, cancelled. Scope jobs to patient, encounter, session and revision. Idempotent retries must not duplicate audio, vendor work or draft application; retain vendor request IDs and usage. Recover a completed transcription without charging to transcribe it again when only drafting fails. Acknowledge capture separately from successful upload and transcription.

Version the template instructions and output schema; record model/configuration, source transcript version and selected chart context. Treat transcript/chart text as untrusted clinical data, never as system instructions. Distinguish current-session statements from historical chart context. Generate structured field proposals with evidence segment IDs, source type and explicit missing/uncertain/conflicting values. Schema validation does not prove clinical correctness: also validate code catalogues, evidence references and patient/encounter boundaries.

| Encounter field | Population rule |
|---|---|
| Chief complaint, interval history, psychiatric ROS, substance use | Draft supported facts; omit unassessed findings rather than defaulting to normal/denied. |
| MSE | Populate only supported spoken observations/reports; visual observations require provider input. |
| Risk | Extract explicit statements and supporting evidence; missing denial remains unknown. Overall risk and safety-plan completion require provider review; no automatic normal-fill. |
| Measures | Reference dated structured chart results; do not invent scores from conversation. |
| Assessment | Draft a grounded summary; distinguish patient report from provider assessment and uncertainty. |
| Diagnoses | Suggest validated catalogue entries; require acceptance before adding Conditions or changing the problem list. |
| Plan and follow-up | Extract decisions/instructions; do not execute prescriptions, lab orders or referrals. |
| Psychotherapy and billing | Suggest documented interventions/codes for review. Provider confirms separately measured/documented therapy and E/M time; never infer either from recording duration alone. |
| Confirmations and private notes | Do not auto-check medication review, safety-plan review or attestation. Never populate private psychotherapy notes automatically or send them as routine context. |

Expose proposed changes alongside the editable encounter, with per-field accept/edit/reject and an apply-to-empty-fields action. Preserve provider-authored text. Applying to an occupied field requires explicit review. Snapshot the base Composition version at generation and check it again server-side before applying; return a conflict rather than overwrite newer edits. Regeneration leaves the accepted draft intact until replacement is reviewed. An in-flight result cannot modify a signed note or cross into an addendum automatically.

The Transcript tab shows finalized text, timestamp links and authorized playback; there are no provisional live partials. Evidence links resolve to actual segments and their audio offsets where available. Keep extraction proposals separate from final chart facts. Persist accepted content through the existing draft saver and canonical narrative/signing flow with aiAssisted and Provenance. Reuse Word/print/AVS builders, including their privacy exclusions; no automatic patient release.

Gate: ten synthetic sessions cover psychiatric follow-up, evaluation, psychotherapy, office capture, interpreter/caregiver, overlapping speech, silence, incomplete risk assessment, medication conflict and interrupted capture. Verify source fidelity, no fabricated normal findings, accurate field mapping, valid evidence, conflict handling, retry behavior and unchanged signing locks. Initial performance target: a 30-minute session's draft ready within 60 seconds of stop under documented upload/network conditions; record upload, transcription and drafting time separately. Initial speaker target >=95% attribution accuracy on labelled utterances, with unknowns reported separately so abstention cannot inflate the result. These targets are not achieved claims.

### Scope boundary

Phase 4 consists of 4A and 4B. Live transcription, live transcript partials, realtime OpenAI sessions, Zoom/RTMS adapters, native Meet transcripts, video analysis and video recording are excluded. Adding any of these requires a new scope decision. Validate that no OpenAI transcription/draft request is dispatched while recording or paused; processing begins after an authorized session is stopped and its upload finalized.

## GCP data, privacy and operations

Use private Cloud Storage via the scribe service and FHIR references, with role/encounter-checked playback. OpenAI credentials remain server-side in Secret Manager. Do not log audio, note text, patient identifiers, meeting credentials or prompts. Audit consent, capture state, playback, generation, apply/reject, export and deletion using resource/job IDs. No browser persistent audio cache or public object URLs. Raw transcripts/audio are not automatically accessible to front desk, billing or the patient portal.

Agree retention separately for audio, transcript and legal holds before PHI use. The existing seven-days-after-signing audio period is a proposed configurable default, not legal advice. Specify maximum retention for never-signed/abandoned sessions. Deletion must cover FHIR Binary metadata, active objects, object versions, temporary chunks, derived copies and vendor retention behavior; assess backup lifecycle separately. Legal holds prevent scheduled deletion and any storage lifecycle backstop. Never apply an unconditional 30-day lifecycle rule that overrides a hold or signing-based policy.

Require executed applicable BAAs and eligible endpoints/configuration before PHI; zero data retention is one possible approved configuration, not a universal substitute for reviewing endpoint and contract terms. Do not upload the sample note or real consultations during synthetic development. User consent and vendor BAA coverage are separate checks. Minimum monitoring, scoped access, deletion and failure visibility ship in Phase 4, not deferred to Phase 9.

## Operating cost baseline

Illustrative USD public pricing checked 16 October 2026; recheck before contracting/launch. One provider, 200 visits/month, 45 minutes each = 9,000 meeting minutes. OpenAI draft assumes one generation with 12,000 input and 2,000 total billable output tokens at gpt-6.1-sol standard short-context pricing ($2/$10 per million). Estimated draft cost: $0.044/visit, $8.80/month. File transcription at $0.0045/minute costs $40.50/month. No live transcription or RTMS budget applies.

| Selected workflow expense | Monthly estimate |
|---|---:|
| Google Meet via Workspace Business Starter, one provider, flexible billing | $8.40 |
| OpenAI after-visit file transcription | $40.50 |
| OpenAI clinical draft generation | $8.80 |
| **Meeting + AI subtotal** | **$57.70** |
| GCP compute, audio storage, networking and monitoring | Additional, measured deployment estimate required |

These are meeting + AI usage estimates, not the total application bill. Add measured incremental GCP compute, storage, requests, networking, retries and monitoring; development, taxes, domain/email and the existing EHR platform are excluded. The earlier $25/month GCP allowance was an illustration, not a deployment quote. The target full GKE/Cloud SQL/Memorystore architecture needs its own estimate. An existing eligible meeting subscription may make the incremental meeting cost zero. Confirm BAA/account eligibility instead of assuming public price alone includes it.

The table assumes 45 billable audio minutes per visit: one combined recording billed once. Capture both sources independently for meters and reliability, then create a time-aligned combined recording for a single file-transcription pass as the planned cost baseline. Test synchronization, overlap and speaker fidelity in 4A; mixing must not imply guaranteed diarization. If separate full-duration source transcriptions are needed, they mean 90 audio minutes per visit: file+draft becomes $89.80/month and Meet+AI $98.20/month, before GCP. Surface this tradeoff before changing the baseline. Additional caregivers, provider licences, repeated drafts, context size, model reasoning, recording options and regional processing can change costs. Record actual vendor usage and cost per session and provide budget alerts/limits before clinical rollout.

Consumer Meet can host free one-to-one calls up to 24 hours; groups of three or more are limited to one hour. Consumer free plans are not the assumed clinical BAA setup. Workspace Standard/native transcription and paid voice-output models are unnecessary for this independent audio scribe design. Subscription tier and healthcare configuration must be verified before purchase; the owner selected Meet, not an unreviewed account purchase.

## Official references and decisions before launch

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [data controls](https://developers.openai.com/api/docs/guides/your-data).
- [Workspace edition pricing](https://knowledge.workspace.google.com/admin/getting-started/editions/business-editions), [Meet limits](https://support.google.com/meet/answer/13396001?hl=en), [Google BAA guidance](https://knowledge.workspace.google.com/admin/compliance/hipaa-compliance-with-google-workspace-and-cloud-identity), [Meet Media API availability](https://developers.google.com/workspace/meet/media-api/guides/get-started).
- [Browser capture constraints](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Google Meet and after-visit processing are accepted product decisions. Verify the supported Meet capture environment, combined-recording fidelity, models/endpoint eligibility, retained-audio duration/holds, private-note access model and measured GCP budget before PHI rollout. A failed capture test calls for a revised capture design, not an automatic vendor switch. This plan does not authorize an external purchase or production deployment.

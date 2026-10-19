# Patient onboarding plan (draft)

**Historical audit snapshot.** See [the implementation audit](verification/phase-7-audit.md) for current status. Standalone email-verified registration is now implemented, along with the previously added P0 fixes and staff onboarding review. The original gap table below is retained as planning history; it does not describe every current limitation.

Status: sprints 1 to 3 built and verified, 18 October 2026 (section 9). Sprint 4 and the AdvancedMD comparison (section 7) are not done. The AdvancedMD site refused page reads, and nothing was read from it.

## 1. Summary

- **Patients cannot sign up on their own.** A portal account exists only after an online booking (confirmed through an emailed link) or a staff invitation. This is deliberate (ADR-012): open sign-up would create duplicate records.
- **Three intake paths overlap.** Staff registration (P08) captures the most. Public booking captures the least. The portal wizard covers history, consents and payment, but misses details that staff registration asks for.
- **Three gaps need fixing before real patients use the portal (P0):** a minor's own record can be invited with full access; sex assigned at birth is not captured online, although the AUDIT-C result depends on it; insurance card photos cannot be uploaded in the portal.
- **Decisions needed** are in section 8, starting with the sign-up model and the age at which a teen gets their own sign-in.

## 2. How patients get in today

| Path | Who starts it | What it creates | Ends with |
|---|---|---|---|
| Staff registration (P08) | Front desk, in person or by phone | Patient, guardian RelatedPerson (minors), Coverage, insurance card images, in one transaction | Chart opened. Portal invitation is a separate step |
| Public online booking (X01) | Patient, unauthenticated | Patient, pending Appointment with a 60-minute hold, invitation record | Emailed link sets the password and confirms the visit. A possible duplicate creates a front-desk call-back Task and no record |
| Portal wizard (X02) | Patient or guardian, after sign-in | Intake QuestionnaireResponse, consents, draft Coverage, card on file | Submitted intake. Nothing yet triggers staff review |
| Staff invitation (P10) | Front desk, from the chart | Invitation record; sign-in created when the link is opened | Patient or guardian portal access |

## 3. Details to capture

Key: ✓ captured, ◐ partly, ✗ not captured. "Staff" is the registration form and chart tabs; "Booking" is public booking; "Portal" is the wizard.

| Group | Detail | Why it is needed | Staff | Booking | Portal | Gap |
|---|---|---|---|---|---|---|
| Identity | Legal name, date of birth | Identity, duplicate check, age rules | ✓ | ✓ | ◐ read only | — |
| Identity | Sex assigned at birth | AUDIT-C threshold, claims, reference ranges (required by the staff form) | ✓ required | ✗ | ✗ | **P0** |
| Identity | Preferred name | How staff and the patient are addressed | ✓ | ✗ | ✗ | P1 |
| Identity | Gender identity, pronouns | Name and pronoun use | ✓ optional | ✗ | ◐ pronouns only | P1 |
| Identity | Sexual orientation, race, ethnicity, marital status, employment | Optional; reporting | ✓ optional | ✗ | ✗ | P1 |
| Contact | Mobile phone | Reminders, call-back, identity | ✓ | ✓ | ✓ | — |
| Contact | Email | Portal sign-in and invitations | ✓ required | ✓ | ✓ | — |
| Contact | Home address and state | Licensure of the patient's location; claims | ✓ state required | ✗ | ✓ required | — |
| Contact | Preferred contact method and language | Outreach | ✓ | ✗ | ✗ | P1 |
| Contact | SMS reminder consent | Texts; opt-outs honoured by the worker | ✓ opt-out boxes | ✓ checkbox | ✓ profile switch | — |
| Safety | Emergency contact (name, relationship, phone) | Safety | ✓ required | ✗ | ✓ required | — |
| Guardian | Name, relationship, phone, email, legal authority | Who may consent and see records | ✓ required | refused for minors | proxy sign-in | — |
| Guardian | Age at which the minor signs in alone | State minor-consent and record rules | ✗ | ✗ | ✗ | **decision** |
| Insurance | Payer, member ID, group, subscriber relationship | Claims and eligibility (Phase 8) | ✓ | ✗ | ✓ draft | — |
| Insurance | Subscriber name and date of birth | Claims subscriber loop | ◐ name only | ✗ | ◐ name only | P2 |
| Insurance | Insurance card photos (front, back) | Desk verification | ✓ upload | ✗ | ✗ | **P0** |
| Insurance | Secondary insurance | Coordination of benefits | ✗ | ✗ | ✗ | P2 |
| Insurance | Self-pay election | Billing path | ✓ | ✗ | ✓ | — |
| Insurance | Good-faith estimate given and acknowledged | Self-pay requirement (No Surprises Act) | ✗ (text only) | ✗ | ✗ | P1 |
| Consents | Treatment, telehealth, recording (AI scribe), financial policy, privacy notice | Required before care | ✓ | ✗ | ✓ five, versioned | — |
| Consents | Controlled-substance agreement | Before any controlled prescribing | ✓ | ✗ | ✗ | P1 (with Phase 5 go-live) |
| Consents | Release of information | Sharing with named recipients | ✓ | ✗ | not at onboarding | — |
| Consents | 42 CFR Part 2 | Substance-use records | decision D2 | ✗ | ✗ | decision |
| Consents | Text version and hash of what was signed | Proof of what the patient saw | ✗ (policy text only) | ✗ | ✓ | P1 |
| Consents | Card-on-file authorization | Charging balances | ✗ | ✗ | ✓ | — |
| Clinical | Reason for visit, goals | Care planning | chart | ✗ | ✓ | — |
| Clinical | Medications, allergies, prior treatment, hospitalizations, medical conditions, primary care | Safety | ✓ chart | ✗ | ✓ | — |
| Clinical | Substance use, living situation, work or school, supports | Risk and care planning | chart | ✗ | ✓ | — |
| Clinical | Safety screen at first contact | Risk | ✗ | ✗ | PHQ-9 item 9 only | decision |
| Clinical | Baseline measures (PHQ-9, GAD-7, ASRS-A, AUDIT-C) | New evaluation | ✓ | ✗ | ✓ before visit | P0 (AUDIT-C depends on sex) |
| Pharmacy | Preferred pharmacy | E-prescribing | deferred to Phase 5 | ✗ | ◐ free text | P2 |
| Referral | Source, referring clinician, NPI | Referrals and reporting | ✓ | source fixed to "Website" | ✗ | — |
| Verification | Photo ID checked at the first visit | Practice policy | ✗ | ✗ | ✗ | decision |

## 4. Target journey

| # | Stage | Patient does | Staff does | Rule that enforces it | Status |
|---|---|---|---|---|---|
| 1 | Choose | Picks state, visit type and time | — | Booking rules in the portal service and the appointment Bot | Built |
| 2 | Confirm | Opens the emailed link, sets a password, sees next steps | — | Hold expiry; single-use link | Built; add a "what happens next" screen |
| 3 | About you | Completes personal and contact details; sets sex at birth once | Reviews at verification | Patient self-edit rules; sex at birth set once by the patient, changed by staff only | P0 (sex at birth); P1 (rest) |
| 4 | Insurance | Enters the plan, uploads card photos, or elects self-pay and acknowledges the estimate | Verifies card and plan | Coverage stays draft until staff verify it; upload policy | P0 (upload); P1 (estimate) |
| 5 | History and safety | Answers history; new evaluations also complete a safety screen | Reviews flagged answers | Crisis panel; safety task for flagged answers | Built; safety screen is a decision |
| 6 | Questionnaires | Completes the visit's measures | Reviews results with the patient | Measure-scoring Bot is authoritative | Built |
| 7 | Consents | E-signs each document | Checks the set is complete | Versioned, hashed Consent records | Built; controlled-substance consent in P1 |
| 8 | Payment | Saves a card on file | Checks | Card rule (decision) | Built; required for everyone today |
| 9 | Submit | Submits; answers lock | Gets a review Task | Locked QuestionnaireResponse; new onboarding-review Task | P1 (new) |
| 10 | Verify | — | Confirms identity, insurance details and duplicates; completes a checklist | Task cannot complete while required items are missing; status becomes verified | P1 (new) |
| 11 | Before the visit | Gets a reminder if intake is incomplete | Sees "intake incomplete" on Today | Reminder 24 hours before; no hard block unless decided | P1 (new) |
| 12 | Check-in | Confirms location; joins | Watches arrivals | Built | Built |
| 13 | Ongoing | Updates details; re-signs the privacy notice when it changes | Annual re-verification task | Consent end dates; yearly task | P2 (new) |

**Staff-first path.** A front-desk registration fills what it captures, so the portal should show only unanswered items. The wizard already pre-fills About from the record, but the insurance form reads only draft coverage, so staff-entered coverage is not pre-filled (P1, item 6).

**Minors.**
1. Staff register the minor. A guardian is required, and the guardian's legal authority is attested.
2. The guardian is invited as a RelatedPerson, with full or limited access set by the minor's state and age.
3. A full-access guardian completes stages 3 to 9 for the child and signs the consents.
4. A limited-access guardian sees scheduling and insurance only. The teen completes clinical intake and the treatment consent when they have their own sign-in, or with the clinician at the first visit.
5. A teen gets their own sign-in at an age set by counsel (decision). Until then, minors have guardian access only.

**Defect in the current build:** staff can send a portal invitation to a minor's own Patient record, and that creates full patient access. The invitation code does not check age (P0, item 1).

## 5. Gaps, by priority

**P0: before any real patient uses the portal**
1. A portal invitation can be sent to a minor's own Patient record, which creates full patient access. Fix: refuse Patient invitations for under-18s in the portal service, and hide the button in the chart for them.
2. Sex assigned at birth is not captured online, but the AUDIT-C positive threshold depends on it (3 for women, 4 for everyone else, including unknown). Fix: require it in the portal About step. For records that lack it, score AUDIT-C with the lower threshold (3) so screens are not missed, and flag the record. Clinical lead to confirm.
3. The portal has no insurance card upload. Fix: let a patient create an id-insurance DocumentReference for themselves and upload its file, with status preliminary, for staff to verify. This needs a patient policy change.

**P1: needed for complete onboarding**
4. Optional demographics and preferred name in the portal, each with "Prefer not to say".
5. Preferred contact method and language in the portal.
6. The insurance form pre-fills from active staff-entered coverage (today it reads drafts only).
7. A new onboarding-review Task on submission, with a checklist. Completing it sets the patient to verified; the server refuses completion while required items are missing.
8. Reminders 24 hours before the visit when intake is incomplete, and an "intake incomplete" flag on Today.
9. Good-faith estimate delivery and acknowledgement for self-pay.
10. Controlled-substance agreement in the portal, switched on with controlled prescribing.
11. Text and version hash for staff-entered consents, matching the portal.

**P2: later**
12. Secondary insurance, and subscriber date of birth.
13. Preferred pharmacy from the national directory (after the Phase 5 vendor).
14. Optional authenticator sign-in for patients.
15. Annual re-verification of demographics and insurance; consent expiry tasks.
16. Photo ID check workflow, if practice policy requires it.

## 6. Implementation sequence

Each sprint ends in a verification gate, as the earlier phases do: server checks added to a verify script, and a short checklist for you to click through.

- **Sprint 1: P0 fixes (items 1 to 3).** New checks in `verify-phase7`: minor invitation refused; sex at birth required; AUDIT-C fallback; card upload accepted only for the patient's own record and category.
- **Sprint 2: verification and status (items 6 to 8).** The onboarding-review Task, a checklist in the Inbox, a status on the chart header, intake reminders and the Today flag.
- **Sprint 3: completeness (items 4, 5 and 9 to 11).**
- **Sprint 4: ongoing and options (items 12 to 16).** Pharmacy directory after the Phase 5 vendor.

Effort is not estimated yet. Sizes follow once the decisions in section 8 are made.

## 7. AdvancedMD comparison: pending

The journey could not be observed. The site denied page reads (patientportal.advancedmd.com, practice 158995). I have not tried another route to read it.

Once the site is allowed in the Claude in Chrome extension, or screenshots of each step are saved to a folder I can read, I will step through the journey without entering personal data or submitting anything. I will record:
- the entry point for new and returning patients, and whether an account is created before booking;
- the order of steps, and the fields asked at each;
- how insurance and card photos are captured;
- consent screens, wording and versions;
- the confirmation and reminder channels;
- what happens to possible duplicates;
- anything the link asks for that this plan does not cover.

Sections 3 and 4 will then be updated with the differences.

## 8. Decisions needed

1. **Sign-up model.** Keep booking-first and staff invitations only (recommended until identity matching exists), or allow open sign-up that goes to a verification queue?
2. **Teen sign-in age.** At what age does a minor get their own sign-in (counsel)? Until decided, minors have guardian access only.
3. **Insurance card upload in the portal.** Recommended: yes.
4. **Card on file.** Required for everyone (as built), or only for self-pay and copays?
5. **Intake deadline.** Required before the visit, or a warning with completion at check-in? Recommended: warn, do not block.
6. **Sex-at-birth fallback for AUDIT-C when unknown.** Recommended: the lower threshold of 3, clinical lead to confirm.
7. **Safety screen at new-evaluation intake.** Which instrument?
8. **Photo ID check at the first visit.** Required by policy?
9. **Authenticator sign-in for patients.** Offer it, or require it?
10. **Optional demographics in the portal.** Collect them, with "Prefer not to say". Recommended.

## 9. Implemented (18 October 2026)

Sprints 1 to 3 are built and checked against local Medplum. Sprint 4 is not started.

**Sprint 1 (P0)**
- A portal invitation for a minor's own record is refused by the portal service and the `task-rules` Bot. The staff card hides the button and says why. Guardians are the route until the teen age is decided.
- Sex assigned at birth is captured in the portal's About you step, set once by the patient and corrected by staff. Patient-set gender follows it.
- AUDIT-C uses the lower threshold (3) when sex at birth is unknown, and the result says so. **Clinical lead to confirm.**
- Insurance card photos can be uploaded from the portal (own record, id-insurance, preliminary, images or PDF up to 10 MB). Staff mark them checked on the Insurance tab.

**Sprint 2 (verification and status)**
- Submitting new-patient forms opens one front-desk `onboarding-review` Task per patient. The Inbox sends it to the chart.
- The chart's onboarding card lists what is missing and offers "Mark verified". The `task-rules` Bot refuses completion while anything required is missing.
- Patients who have an unsubmitted new-patient visit within 26 hours get one reminder email (links and times only). The Today page flags new-patient visits with no forms.

**Sprint 3 (completeness)**
- Optional demographics (race, ethnicity, sexual orientation, marital status, work), gender identity, preferred name and preferred contact and language are in the portal, each with "Prefer not to say" where a choice is offered.
- Self-pay patients acknowledge a good-faith estimate per visit (recorded as a Consent with the exact text and its hash). **The wording is a placeholder for counsel.**
- The controlled-substance agreement is required only while a controlled medication is active.
- Staff-recorded consents with a portal version now record the same version and text hash.

**Defect found and fixed.** Policy lookups by name used prefix matching, so "Teleemon Proxy" also matched "Teleemon Proxy (limited)". A full-access guardian could receive limited access. Every name lookup for policies, bots and client applications now matches exactly. Two unreferenced duplicate policies left by earlier setups were removed.

**Not done (sprint 4 and open items)**
- Secondary insurance and subscriber date of birth; pharmacy directory after the Phase 5 vendor; optional authenticator sign-in for patients; annual re-verification tasks; photo ID workflow.
- Good-faith estimate and consent wording are placeholders for counsel.
- Teen sign-in age: deferred by the owner.
- AdvancedMD comparison (section 7): needs the site to be allowed in the browser extension.
- Open question: the portal currently has a self-sign-up page at `/register` and a `register` route in the portal service. This was added outside the approved booking-first decision. Needs confirming before real use.

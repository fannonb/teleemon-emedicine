# Phase 7 audit and registration completion

Reviewed 17 October 2026 against the implementation plan, PATIENT-ONBOARDING-PLAN.md, ADR-012, source code, deployed local Medplum and the portal in the browser.

## Assessment

The authenticated portal was substantially implemented: intake, insurance-card uploads, questionnaires, consents, messages, summaries, refills, check-in, profile and guardian access were present. However, account creation required booking first or a staff invitation. This followed the original invitation-only identity decision, but did not provide the independent sign-up journey requested by the owner.

The earlier onboarding audit was found at docs/PATIENT-ONBOARDING-PLAN.md. Several gaps listed there had already been addressed: sex at birth, card images, staff verification, intake reminders and estimate acknowledgement. Its remaining optional/policy-dependent items are not automatically considered delivered.

The AdvancedMD reference redirected to a CAPTCHA verification page. Its protected scheduling/sign-up journey was not inspected; this report does not claim field-for-field parity with that site.

## Corrections

- Added `/register`, linked from the portal landing and sign-in pages, independently of appointment selection. Reused the existing portal components and styling.
- Added server validation for legal name, actual calendar date of birth, email, phone and served state, with rate limiting and fresh proof-of-work verification. Minors use staff-arranged guardian access. SMS reminders start unchecked in registration and booking.
- Registration creates a patient record and emails a hashed, single-use activation invitation. It creates neither an appointment nor sign-in membership before verification.
- Possible duplicates get the same public response and a staff identity-review task. Unauthenticated input cannot attach access to an existing chart or overwrite its email.
- Activation now explains the next steps and directs the patient through sign-in into intake. Existing-account activation correctly preserves the existing password.
- Invitation consumption and held-visit confirmation now commit atomically. A conflict leaves a retryable link instead of consuming it before confirmation succeeds.
- Old invitations to minors' own records now reliably refuse activation before checking the minor's email.
- Booking success copy no longer promises a held time/activation link for requests awaiting duplicate review.
- Refreshed local portal policies and Bots. The first audit run found stale proxy policies; redeployment restored the expected full-proxy document access. Restarted the local API with the corrected code.

## Patient journey

1. Open http://localhost:3200/ and choose **Create patient account**, or visit http://localhost:3200/register.
2. Enter registration details and request verification. No appointment is booked.
3. Open the single-use email link, choose a password and sign in.
4. Complete the existing save-and-resume intake: personal and emergency-contact details, insurance/self-pay, card images, health history, questionnaires when due, consents, payment setup and submission.
5. Staff receive the onboarding review; verification is blocked until required checks pass.
6. Book from the portal and finish appointment-specific questionnaires/estimate acknowledgement. Booking first remains available.

**Port 3200 is the patient app. Port 3100 is the staff app**, whose sign-in page is not the patient registration entry point.

## Evidence

| Check | Result |
|---|---|
| Phase 7 regression tests | 24 passed |
| Local deployed API verification | 119 passed, 0 failed: registration, activation, patient isolation, guardian limits, booking, check-in, uploads, messages, refills, intake review and estimates |
| Earlier regression suites | Phases 1, 3, 4, 5 and 6 passed |
| Type checking | Passed for scripts, shared package, Bots, services and both apps |
| Production builds | Portal and staff passed; existing bundle-size warnings remain |
| Browser | Landing → registration, adult eligibility, SMS unchecked, synthetic submission and next-step screen observed. Demo patient sign-in confirmed Home, Visits, Messages, Summaries, Refills and the seven-step intake wizard. API checks verify new-account activation/sign-in; no new password was entered through browser automation. |

[Registration browser evidence](phase7-registration-browser.jpg) contains synthetic example data only. The disposable browser registration was removed after verification.

## Remaining release gates and deferred scope

- Email uses the development log, not delivery to real inboxes. Configure an appropriate email vendor and Medplum password recovery before real use. An invitation is not a password-reset implementation for an existing account.
- Payments remain sandbox/Stripe test mode. Final consent wording, state-specific minor-confidentiality rules and proxy ages need practice/counsel approval; existing age values are placeholders.
- Separate privileged activation/proxy account administration into an internal workload before production, per ADR-012. Production GCP deployment, security and BAAs are separate release gates; this audit is not HIPAA certification.
- Secondary insurance, subscriber date of birth, annual reverification, national pharmacy directory, photo-ID workflow, Part 2 policy and independent teen/adult-proxy access remain deferred or require practice decisions.
- Live email/vendor retry and delivery reconciliation, multi-instance rate limiting and comprehensive browser/accessibility testing remain release work. This is a local synthetic gate.

Automatic approval review rejected uploading source files to Superdesign. No source upload occurred; implementation continued locally with existing components.

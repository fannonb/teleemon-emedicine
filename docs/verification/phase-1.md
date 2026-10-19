# Phase 1 verification: patients and chart

Status: **ready for review** · built 15 October 2026 · review fixes verified 16 October 2026 · synthetic data only

## Before you start

1. The Medplum stack is running (`..\Start-Medplum.ps1`). Its local config now has `saveAuditEvents` and `preCommitSubscriptionsEnabled` switched on.
2. From `teleemon/`: `npm run setup`, `npm run seed`, then `npm run dev`. All three are safe to re-run.
3. Open http://localhost:3100. Every account uses the password `Teleemon-Local-2026`:

| Login | Role |
|---|---|
| `admin@teleemon.test` | Administrator |
| `provider@teleemon.test` | Provider (Jordan Ellis) |
| `frontdesk@teleemon.test` | Front desk (Riley Chen) |
| `biller@teleemon.test` | Biller (Sam Okonkwo) |

The old `admin@example.com` account is the Medplum super admin. It is deliberately not a member of the practice project, so it can't sign in to the staff app.

## A. Server-side enforcement (no UI involved)

Run `npm run verify:phase1`. Expected: **all checks PASS, 0 FAIL (the script prints the current count)**. This is the design check from IMPLEMENTATION-PLAN.md: each rule is refused by the server even when the UI is bypassed.

## B. Screens

| # | Check | Expected | Pass? |
|---|---|---|---|
| 0 | Open Find patient without entering a search | First 10 patients appear, ordered by last name; total count and pagination are visible when more than 10 patients exist | |
| 0a | Go to page 2, then search for a full name from another page; clear the search | Search covers the whole directory and resets to page 1; clearing restores the first 10 patients | |
| 1 | Sign in as **provider** → Find patient → type `thor` | Maya Thornton, with chart number, DOB, age, phone, WA badge and next visit | |
| 2 | Search `04/12/1991`, then `425-555-0101`, then `TM-1001`, then member ID `XEH0148213` | Each finds Maya; the hint under the box names the search type | |
| 3 | Open Maya's chart | Sticky header: name, pronouns, age, DOB, chart number, **Penicillin** allergy in red, insurer, next visit; tabs below | |
| 4 | Overview | ADHD and GAD diagnoses; **Lisdexamfetamine** with a red C-II badge; PHQ-9, GAD-7 and ASRS sparklines with change arrows; timeline of visits and measures; all consents on file; controlled-substance agreement date | |
| 5 | Open **Priya Raman** | Red **Positive safety screen** badge in the header; Overview lists a missing recording consent | |
| 6 | Priya → Measures | Red banner; PHQ-9 trend 18 → 16 → 13 with severity bands. **Mark reviewed** with a note: the banner clears and the header badge disappears | |
| 7 | Measures → Enter PHQ-9 for Maya with item 9 = "Several days" | A red warning appears before saving; after saving, a safety flag and an urgent task appear (Today → Alerts) | |
| 8 | Problems → Add diagnosis → search `bipolar` | Grouped list of billable codes; adding one already on the list is refused; an SUD code shows the Part 2 note | |
| 9 | Meds & allergies → Add medication `Lithium carbonate` | Monitoring notice; after saving, "Lab monitoring due" shows a task | |
| 10 | Consents → Record a release of information, then revoke it | Shows as active, then inactive; both appear in History | |
| 11 | Documents → Upload a PDF as "Outside records" → Open | The file opens in a new tab; the category chip count increases | |
| 12 | Demographics → change the phone number → Save | "Change history" shows "Phone or email" with your name and the time | |
| 13 | Messages → add an internal note | Yellow "Internal: not visible to patient" bubble | |
| 14 | Patients → **New patient** with DOB 2012-05-01 | A guardian section appears and is required; the checklist on the right updates as you fill the form | |
| 15 | New patient: first name `Mia`, last name `Thornton`, DOB `04/12/1991` | A yellow "This may be an existing patient" panel links to Maya; saving is refused by the server with a plain-English reason | |
| 16 | Register a genuinely new adult | Opens the new chart with a chart number like `TM-1A2B3C4D` | |
| 17 | Open **Omar Haddad** | A "Restricted chart" dialog asks for a reason before the chart shows | |
| 18 | Sign in as **front desk**, open Maya | Tabs show no Problems or Measures; Overview's clinical sections say "isn't available for your role"; Meds & allergies still works (intake updates) | |
| 19 | Sign in as **biller**, open Maya | Only Overview, Demographics, Insurance, Documents, Encounters and Account; medications are refused by the server | |
| 20 | Sign in as **admin** → Settings → Users, roles & security | Four people with roles and MFA status. Change front desk to Biller and back: the change takes effect on that user's next sign-in | |
| 21 | Grace Kim → Messages | Orange notice that she opted out of text messages | |

## C. Design conformance

- The Phase 1 row of SYSTEM-DESIGN.md §12 is delivered: role AccessPolicies, the first pre-commit Bot, audit events on, plus the dedicated practice project (ADR-013).
- ADR-003 (server-side enforcement) and ADR-011 (audit) are marked Accepted.
- **Hosting choice: GCP (ADR-009, accepted 16 October 2026).** Remote staging is not provisioned. The deployment plan uses Terraform/Helm and Google Cloud services; see [GCP-DEPLOYMENT.md](../GCP-DEPLOYMENT.md). A GCP project, billing and DNS are needed to deploy; a Google Cloud BAA and covered-service review are required before PHI.

## Known limits (by design for Phase 1)

- Restricted charts: every role must give a reason, and the reason is audited. Server-side hiding of a restricted patient's *other* records (compartment labelling) arrives with compliance hardening in Phase 9.
- The diagnosis catalogue is a curated, psychiatry-focused list (about 70 codes). The full, versioned ICD-10-CM release comes with P40 in Phase 8.
- Medications are recorded as text. RxNorm codes come with e-prescribing in Phase 5.
- Messages to patients are queued and delivered once the portal exists (Phase 7). SMS sending starts in Phase 2.

## Sign-off

Reviewer: ____________ Date: ________ Result: ☐ accepted ☐ changes requested
Notes:

## Review fixes (16 October 2026)

- Chart-to-chart navigation remounts patient state; restricted reasons are never cached in browser storage. Test Maya → global search → Omar, then return to Maya without a restriction prompt.
- Search input stays in memory and legacy `?q=` parameters are removed.
- Guardian, diagnosis and completed-measure validation run before server commit; medication monitoring runs from a server subscription.
- Safety score/Flag/Task writes are transactional and retryable. A safety review closes only tasks for the reviewed questionnaire.
- ROI and restriction records can be revoked. Part 2 enforcement is explicitly marked unavailable.
- Header and branding align; planned navigation collapses under Coming later; tablet registration keeps its actions visible.
- `npm run test:phase1` exercises retry and validation regressions; `npm run verify:phase1` exercises the live synthetic server.

Verification results: **38 live API checks passed, 8 targeted regression tests passed**. Typecheck and production build passed. Browser checks confirmed private search URLs, Maya → Omar reason enforcement, return to Maya without a restriction prompt, ROI recording/revocation with both history events, and header/registration layouts at 1440, 1024 and 390 px. No browser console errors were observed during these checks.

For an already configured local project, `npm run setup -- --bots-only` updates only Bots, their resource policies and subscriptions. `npm run seed -- --guardians-only` repairs only the synthetic minor's guardian snapshot on localhost; it does not re-seed users or roles.

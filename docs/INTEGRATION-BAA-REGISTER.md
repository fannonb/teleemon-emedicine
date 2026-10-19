# Teleemon: integration and BAA action register

Reviewed 19 October 2026. Use alongside the [app completion roadmap](APP-READINESS-AND-IMPLEMENTATION-ROADMAP.md). User confirmed this deployment serves **only the owner's own practice**.

## Who signs, and what is currently verified

The practice's legal entity should contract with vendors, with an authorized representative accepting each applicable BAA. Use that legal name even if Teleemon.com is its trading name. There is no additional clinic-customer SaaS BAA layer in the stated own-practice model. An independent developer, support firm or billing contractor with PHI access may nevertheless be a business associate; workforce arrangements require a separate classification review. HHS describes the business-associate relationship and contract obligations in its [guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html).

**Executed agreements are not evidenced by this repository review.** Every applicable row below remains “not verified” until the practice supplies agreement/account evidence for review. This does not assert that the practice has never signed an agreement outside the repo. Vendor availability, a checkbox, an API key, a DPA, PCI compliance or a SOC 2 report is not evidence of an executed BAA.

## Integration action matrix

| ID / integration | App status | Agreement action before the relevant PHI use | Implementation still required |
| --- | --- | --- | --- |
| B01 — Google Cloud | Deployment guidance; local services/storage, no accepted GCP deployment | Accept the applicable Google Cloud BAA for the practice account; confirm every selected service is covered. Contact the account manager/support for the applicable acceptance route. [Google Cloud requirements](https://cloud.google.com/security/compliance/hipaa-compliance) | Provision and secure environments, databases, private Binary/object storage, secrets, backups, logs and recovery; verify service scope against the deployed inventory |
| B02 — Google Workspace / Meet / Calendar | Meet sandbox/default links and optional Calendar/Meet adapter | Workspace super administrator reviews/accepts the applicable BAA in Admin console → Account settings → Legal and compliance. Preserve acceptance evidence and verify the actual Workspace account and included services. [Workspace instructions](https://knowledge.workspace.google.com/admin/compliance/hipaa-compliance-with-google-workspace-and-cloud-identity) | Admin/API permissions, real conference creation, meeting access/security, browser audio capture and calendar content minimization |
| B03 — OpenAI API scribe | Synthetic path plus audio-transcription/Responses adapter | Obtain an executed OpenAI Business Associate and Healthcare Addendum for the API organization; qualify the exact models, endpoints and approved retention controls. Project settings must match the approved configuration. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) | Qualify `/v1/audio/transcriptions` and `/v1/responses` separately; verify supported models, feature limits, storage settings and audio/draft deletion. Complete clinician review and durable processing |
| B04 — Stedi or replacement clearinghouse | Mock/local path; Stedi adapter requires completion/qualification | Stedi's paid production upgrade includes MFA and BAA acceptance; preserve agreement and correct account evidence. A replacement needs its own contract review. [Stedi account setup](https://www.stedi.com/docs/healthcare/account-settings) | Verify API schemas, implement retrieval, complete payer enrollments, and qualify claim/acknowledgement/remittance reconciliation |
| B05 — Twilio SMS, if retained | Log default; credential-based SMS path | Contact Twilio sales/account representative for the BAA and covered product/account. Twilio currently requires Security Edition or Enterprise Edition for BAA signing. [Twilio HIPAA terms](https://www.twilio.com/en-us/hipaa) | SMS registration/consent/opt-out, minimal templates, authenticated callbacks, retry/reconciliation; obtain the actual qualifying-plan quote |
| B06 — Transactional email, vendor undecided | Portal invitations/reset/notices and worker email log only | Select a BAA-capable email API/SMTP product and retain the executed agreement. Paubox API is one candidate advertising a BAA on every plan; selection and agreement still need verification. [Paubox API](https://www.paubox.com/products/paubox-email-api) | Implement the adapter, domain authentication, delivery/bounce callbacks, secure links, retries and suppression handling |
| B07 — eRx/EPCS and PDMP, vendor undecided | Vendor-neutral UI/rules and mock transmission | Obtain the chosen API product's service agreement and applicable BAA, including subcontractor/network scope. Request written scope and onboarding from the selected vendor; no specific vendor's executed terms were verified | Real prescribing adapter and pharmacy responses, EPCS onboarding/identity/MFA, PDMP permissions, prescriber credentials and applicable state workflows |
| B08 — Fax, vendor undecided | Log adapter plus webhook/simulator | Select a fax API provider; execute the applicable BAA for the product/account and verify inbound/outbound storage, retention and subprocessors | Actual transmission, receipts, webhook authentication, retry/deduplication and document routing |
| B09 — Lab intermediary / aggregator | Manual orders and uploaded results only | If an intermediary processes PHI on the practice's behalf, request its product-specific BAA and interface contract. Health Gorilla or another candidate must confirm the exact service scope; no selected agreement is verified | Catalogue, order submission/acknowledgement, result transport, patient matching, analytes, corrections, critical results and interface acceptance |
| B10 — Direct Labcorp / Quest clinical exchange | No direct electronic interface | A BAA is generally not required solely for a provider's disclosure to a clinical lab for treatment. Still arrange laboratory account, interface/data-exchange terms and secure connectivity; additional non-treatment services require separate review. [HHS treatment exception](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html) | Real lab enrollment, mapping, results lifecycle and clinician acceptance; a lab name in the UI is not connectivity |
| B11 — Stripe / payment processor | Test-only integration; production path unaccepted | Ordinary consumer payment processing may fall outside the BA relationship. Review the precise product/data flow; do not assume a BAA is available or that a DPA is a substitute. Keep clinical records/details out of the processor. [HHS financial transaction exception](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html) | Deliberate production-mode implementation, data minimization, PCI responsibilities, webhook replay protection, refunds and financial reconciliation |
| B12 — Self-hosted Medplum / Metabase | Medplum local; analytics configuration only | Installing software without giving its vendor PHI access does not by itself create a vendor PHI-processing relationship. Hosting/support arrangements must be assessed. Hosted services or vendor support handling PHI need applicable agreements; self-hosting does not remove the GCP BAA requirement | Deployed Medplum policies, read-only analytics replica, restricted support access, audit and recovery |
| B13 — External support, billing, migration, monitoring or backup services | Scope/providers not finalized | Assess every third party that creates, receives, maintains or transmits PHI on the practice's behalf, including subcontractors. Use applicable BAAs before access; classify workforce separately | Least privilege, bounded support/migration access, PHI-safe telemetry, access revocation and deletion/return evidence |

Google Cloud infrastructure and Google Workspace are **separate product/account scopes to verify**. Do not assume accepting terms in one account proves coverage for another. Google's [covered-services list](https://docs.cloud.google.com/docs/security/compliance/hipaa) lists Meet and Calendar; the practice must retain the applicable acceptance evidence for its actual services. Free personal Meet access alone establishes none of that. Third-party add-ons are not automatically covered by the Workspace agreement.

The chosen workflow does not require Google's transcript or native meeting recording: Meet carries the call, while the app captures audio and generates afterward. A paid meeting plan does not itself prove browser audio access or OpenAI coverage.

**Do not use SendGrid for PHI workflows.** Twilio states SendGrid is not HIPAA eligible and it cannot sign a BAA for SendGrid; encrypting an email body or adding a secure download link does not change that product eligibility. A Twilio SMS BAA does not extend to SendGrid. [SendGrid statement](https://www.twilio.com/docs/sendgrid/ui/account-and-settings/hipaa-compliant)

The OpenAI endpoint table distinguishes transcription from Responses and other features. Do not assume one blanket retention setting covers all endpoints/models, or equate “not used for training” with “no retention.” Obtain the agreement and account-specific approval before enabling PHI. Audio recording consent and the clinician's review/signature remain separate requirements.

## Evidence to collect for each applicable row

The practice administrator should maintain the signed documents in a restricted contract repository, with only a reference and approval metadata in the app. Do not commit agreements containing sensitive business information, API credentials, patient data or private keys to source control.

| Field | What to retain |
| --- | --- |
| Legal parties and signer | Practice legal name, vendor entity, authorized signer and acceptance authority |
| Agreement evidence | Executed BAA/addendum and service agreement, version, effective date, acceptance receipt or admin-console evidence |
| Covered scope | Exact product/SKU, account/organization/project identifiers, environments, API endpoints/features and relevant subprocessors |
| Data handling | Approved uses, regions/transfers where relevant, retention, return/deletion, backup handling, support access and incident/breach notification obligations |
| Operational entitlement | API access, sandbox/production separation, enrollment/certification requirements, support terms, fees and limits |
| Approval | Practice reviewer, review date, approved purpose, expiry/renewal if applicable, revocation/termination state and next review date |
| Qualification evidence | Synthetic integration results, failure/retry tests, permission review and documented authorization before any PHI dispatch |

For a vendor that does not require a BAA for a narrowly defined function, retain the reviewed rationale and constraints. Do not mark that row “BAA signed”; use “not applicable — approved scope” with a reviewer and evidence.

## Enforcement implementation to add

P44 currently provides evidence/attestation, not a complete network-dispatch approval gate. Add one shared policy consumed by all vendor callers, including scribe and portal, with explicit synthetic versus PHI modes. For integrations requiring a BAA, PHI dispatch must fail closed if the correct account/product agreement and approval are absent, revoked or no longer valid. Exceptions such as payment-only processing need a reviewed scope policy rather than a fictitious BAA.

Show distinct status fields: adapter mode, credentials configured, connectivity tested, contract reviewed, eligible data scope, and clinical/operational acceptance. Never label a mock adapter “ready” merely because an environment selector exists. Record approval and revocation events without exposing secrets.

## HIPAA and practice readiness beyond signing

BAAs do not make the app or practice compliant by themselves. The practice needs a documented risk analysis and remediation, assigned privacy/security responsibility, workforce training, access management, device/workspace safeguards, incident response and contingency/recovery procedures. See [HHS risk-analysis guidance](https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html) and [Security Rule guidance](https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html).

For this implementation, close server-side restricted-chart controls, verify audit/release/proxy permissions, approve notice/consent and recording language, decide record/audio/transcript retention, and assess state law and Part 2 applicability with counsel. Penetration testing and the planned parallel run are project acceptance gates; they are not a substitute for the practice's ongoing obligations. Full recovery targets must be demonstrated, not inferred from a small ledger fixture.

## Suggested procurement order

1. Confirm practice legal entity, signer and account ownership. Collect any agreements already executed outside the app.
2. Complete GCP, applicable Workspace and OpenAI reviews for the intended infrastructure/telehealth/scribe path.
3. Select transactional email and qualify SMS; these support portal access and routine operations.
4. Select prescribing/PDMP, fax, lab connectivity and clearinghouse products; obtain API entitlements and implementation/enrollment details alongside contracts.
5. Review payment-only scope and all support/analytics/migration vendors. Test all connections synthetically, then complete the separately approved PHI/release process.

Vendor request text the owner can adapt; this document does not send it:

> We operate Teleemon.com for our own clinical practice. Please confirm your exact API product's BAA availability, eligible plan and acceptance process; covered endpoints/features and subcontractors; permitted data and retention/deletion controls; API/sandbox access; implementation and enrollment requirements; incident notification terms; and all recurring, setup and usage fees. We will retain the executed agreement and account-specific approval before enabling PHI workflows.

This register is a technical/procurement aid. Final agreement applicability and practice policies require review of the actual contracts and data flows. No agreement was signed, vendor activated or deployment performed as part of this review.

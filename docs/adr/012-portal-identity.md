# ADR-012: Patient portal identity and access

Status: **Accepted** (Phase 7, 17 October 2026). Minor-proxy ages are placeholders pending counsel.

## Context

Patients and their parents or guardians need to book, check in, message, read summaries and request refills. The scope requires that a returning patient books quickly on a phone, an out-of-state patient cannot book, a minor's proxy sees only what state law allows, and the join button stays hidden until the patient confirms their location. Medplum is used unmodified (ADR-001), and every rule needs a server-side enforcement point (ADR-003).

Medplum 5.2.4 facts that shaped the design:

- Self-registration (`/auth/newpatient`) always creates a new Patient. It cannot attach a sign-in to the Patient that staff or the booking page already created.
- Only a project administrator can create a sign-in for an existing profile (`/admin/projects/:id/invite` with `membership.profile`). The invite can set a password and skip Medplum's own email.
- AccessPolicies can be parameterized: `%patient` is the patient profile for a Patient sign-in, or a membership parameter for a RelatedPerson.
- `hiddenFields` hide whole fields only. You cannot hide one extension, such as the telehealth link, and keep the rest. Hidden fields are also blanked on writes.
- The project setting `mfaRequired` applies to every user, patients included.

## Decision

1. **A separate public ClientApplication** ("Teleemon patient portal") with PKCE, a 30-minute access token and a 12-hour refresh token. It has no project membership, so its secret cannot be used for client-credentials sign-in. Patients are project-scoped Medplum users. The portal service refuses staff profiles, and the portal app signs them out.
2. **Patients sign in as their own Patient profile**, on `Teleemon Patient`. Proxies sign in as a RelatedPerson, with the patient as a membership parameter. They get `Teleemon Proxy` (full) or `Teleemon Proxy (limited)`, chosen by `proxyLevel` in `@teleemon/core` from the patient's age and home state.
   - Limited proxies see demographics, appointments and coverage only.
   - Adults have no proxies yet; that needs a signed authorization.
   - The portal service re-evaluates proxy policies every hour and ends proxy access at 18.
3. **Reads go to Medplum directly** under compartment criteria (`Patient?_id=%patient.id`, `Appointment?patient=%patient`, and so on). Released documents are after-visit summaries only. Appointment extensions and comments are hidden, which keeps the telehealth link out of the patient's reads.
4. **Writes that carry rules go through `services/portal`**: booking, cancelling, check-in, the join link, e-signatures and card on file. The pre-commit Bots apply the same rules again, so a direct API call gets the same answer. Patients' direct writes are limited by policy, then checked by Bots:
   - contact details on their own Patient, checked by the Patient Bot;
   - portal messages, create-only, checked by the message Bot;
   - refill requests, create-only, checked by the Task Bot;
   - intake answers, which are locked once completed (policy writeConstraint);
   - draft insurance, draft only (policy writeConstraint).
5. **Email-verified activation.** Staff invitations, public booking and independent adult registration (`/register`) issue activation links. The link is random, single-use and expires after 72 hours; only its SHA-256 is stored on a Basic resource. Submitting activation sets the password and creates the sign-in. Independent registration does not book a visit. Possible duplicates go to staff review and are never auto-linked to unauthenticated requests. This extends the original invitation/booking-only decision at the owner's request; minor self-registration remains unavailable.
6. **Two portal service clients.** `Teleemon portal service` is least privilege and handles every request. `Teleemon portal accounts` is a project administrator, restricted by policy to reading Patient, RelatedPerson and AccessPolicy. It is used only by activation and the proxy review.
7. **Public booking** is the only unauthenticated surface. It offers free start times only, uses a self-hosted proof-of-work check (no third-party captcha or tracker), limits requests per address, and holds the time as `pending` until the email link is opened. A booking that matches an existing record creates no record and goes to the front desk; the caller always sees "check your email".

## Consequences

- No Medplum change. Rules live in `@teleemon/core` (shared by the app, service and Bots), the policies in `scripts/config/portal.ts`, and the service in `services/portal`.
- The accounts client is an administrator credential. **Production gate:** run activation and proxy review as a separate internal workload with its own Secret Manager secret, never on the public ingress. Medplum's invite endpoint accepts a `membership.admin` field; the service never sets it, and code review must keep it that way.
- Turning on project-wide MFA forces patients to use an authenticator app; the portal supports enrollment. For production, prefer per-user `mfaRequired` on staff invites.
- Password reset needs an email vendor: Medplum's reset flow emails its own link. Until then, staff send a new invitation.
- Proxy ages (WA 13, CA 12, CO 12, RI 14; unknown state 12) are placeholders pending counsel (SYSTEM-DESIGN.md §13, question 1).

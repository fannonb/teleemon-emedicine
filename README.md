# Teleemon Care Platform

Practice-owned EHR, scheduling, e-prescribing, AI scribe, billing and patient portal for Teleemon Behavioral Health & Wellness, built on [Medplum](https://www.medplum.com) (self-hosted).

- Plan and phase gates: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)
- Telehealth and AI scribe delivery plan, capture options and costs: [docs/TELEHEALTH-SCRIBE-PLAN.md](docs/TELEHEALTH-SCRIBE-PLAN.md)
- System design and decisions (ADRs): [docs/SYSTEM-DESIGN.md](docs/SYSTEM-DESIGN.md)
- Design system: [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md)
- Phase verification checklists: [docs/verification/](docs/verification/)

## Run locally

Prerequisite: the local Medplum server is running (`..\Start-Medplum.ps1`), with the API at http://localhost:8103.

```powershell
npm install
npm run setup          # practice project, roles, Bots, measure forms (safe to re-run); add --mfa to enforce MFA
npm run seed           # synthetic practice, patients, chart history, today's schedule and role logins
npm run dev            # staff app at http://localhost:3100
npm run verify:phase1  # proves the server enforces roles and rules (prints the current check count)
npm run worker         # reminder scheduling and delivery, inbound SMS replies (log transport until a vendor is set)
npm run verify:phase2  # booking, licensure and reminder rules against the server
npm run verify:phase3  # visit start, signing, locking, addenda and exports against the server
npm run test:phase3    # signing boundaries, draft-save races and atomic-completion regressions
npm run scribe        # after-visit capture/transcription service, port 3111
npm run test:phase4    # synthetic scribe and retention regressions
npm run verify:phase4 # local Medplum gate with injected AI; no paid requests
npm run scribe:retention # report-only audio retention pass
npm run portal         # portal service (public booking, invitations, check-in), port 3120
npm run dev:portal     # patient portal and public booking at http://localhost:3200
npm run portal:demo    # synthetic portal sign-ins for the Phase 7 checklist
npm run verify:phase7  # portal policies, Bots and service against the server
npm run ledger:schema  # proves the ledger schema invariants in a throwaway database (add -- --apply for the local ledger)
npm run ledger         # ledger service (money, A/R, reconciliation), port 3130
npm run test:ledger    # ledger service against a throwaway database
npm run test:phase8    # billing rules, Bots, worker and portal bill-pay regressions
npm run verify:phase8  # claim to cash against the server: mock payer, throwaway ledger, every hard rule
npm run test:phase9    # reports, audit, migration and operations regressions
npm run verify:phase9  # audit immutability, attestations, integration health, migration replay, financial reports
npm run migration:validate -- <file.json>  # offline AdvancedMD bridge-file check; never imports
npm run recovery:rehearse                  # synthetic ledger dump/restore; tooling check, not production RPO/RTO
```

Local logins (password `Teleemon-Local-2026`): `admin@`, `provider@`, `frontdesk@` and `biller@teleemon.test`. Portal demo logins (password `Synthetic-portal-2026!`): `maya.thornton@example.com` (patient) and `emily.bennett@example.com` (guardian, limited access). Portal setup and checklist: [docs/verification/phase-7.md](docs/verification/phase-7.md).

Only synthetic data belongs in development and staging.

Phase 4 setup, configuration and remaining acceptance gates: [docs/verification/phase-4.md](docs/verification/phase-4.md). Run the scribe service alongside the staff app; configure its server-only `OPENAI_API_KEY` in root `.env.local` for actual transcription. Generation is always after recording stops.

Hosting target: **Google Cloud Platform (GCP)**. See [docs/GCP-DEPLOYMENT.md](docs/GCP-DEPLOYMENT.md). Cloud infrastructure has not been provisioned.

Phase 3 signing requires the Medplum `transaction-bundles` project feature. Setup enables it; an existing local project can use `npm run setup -- --transactions-only` with the configured Medplum super-admin login, then sign in again. This prevents Medplum from silently applying transaction requests as independent writes.

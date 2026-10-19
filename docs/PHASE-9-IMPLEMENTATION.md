# Phase 9 implementation plan

18 October 2026. Scope: local implementation and synthetic verification only. **No go-live, production cutover or real-patient migration is authorized.** A broader integration-gap audit follows implementation.

## Delivery sequence

1. Confirm the detailed requirements against the existing system design, scope and route inventory; reuse existing authentication, restricted-chart rules, audit records and append-only ledger.
2. Implement P37 standard reports with defined filters, permission checks, completeness indicators and exports. Financial figures must derive from and reconcile to the ledger. Provide a read-only analytics deployment configuration without exposing the operational database or enabling external access.
3. Implement P45 audit search, alerts and compliance tracking, and P44 integration health. Record chart access, preserve audit immutability, restrict sensitive results and distinguish observed health from unconfigured integrations. A checked box is not evidence of an external approval or completed security test.
4. Implement P06 waitlist and recalls using the existing scheduling and messaging rules. Lab integration is conditional on a real interface being available; do not invent vendor connectivity.
5. Implement an AdvancedMD migration staging/validation workflow with explicit format contracts, counts, errors and idempotent handling. Use synthetic fixtures; do not import real patient exports or cut over.
6. Add a recovery rehearsal, training and parallel-run runbooks, and a release checklist. Measure recovery checks where locally possible; do not claim a penetration test, 2–4 week parallel run, or production RPO/RTO acceptance without evidence.
7. Verify meaningful negative cases and regression behavior, build/typecheck, exercise the local UI and document results and deferred external acceptance activities.

## Acceptance

- Required screens are usable within existing staff roles; unauthorized users cannot obtain their underlying data through direct requests.
- Financial reports reconcile to the ledger; incomplete data is explicit.
- Chart access creates auditable records and application users cannot modify/delete them.
- Synthetic migration counts match accepted source records and failures are actionable.
- Restore tooling records measured results and compares them with the RPO 15-minute/RTO 4-hour objectives.
- No production deployment, vendor enrollment, real-patient import, live outbound messages or cutover occurs.

Implementation details, verification evidence and the click-through checklist: [verification/phase-9.md](verification/phase-9.md).

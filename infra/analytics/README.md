# Analytics sandbox configuration

These files are **examples only**. Phase 9 does not create a replica, grant database roles,
start Metabase, or send clinical or financial data to an analytics service. The in-app report
catalogue reads operational records through the staff member's FHIR access policy and financial
records through the biller-authorized ledger endpoint.

## Local Metabase shell

`compose.yaml` provides a local-only Metabase service and a separate PostgreSQL database for
Metabase's own metadata. Select reviewed, pinned image tags and provide
`METABASE_APP_DB_PASSWORD` through an ignored local environment file or secret manager before
starting it. The default bind is `127.0.0.1:3030`.

The reporting data source is a **separate, dedicated analytics replica**. Add it to Metabase only
after the replica and reviewed views exist. Do not point Metabase at the operational FHIR database
or the ledger primary. `replica-reader.sql.example` shows the minimum read-only grants for a
dedicated database role; run a reviewed, environment-specific version only on that replica.

## Data and access boundaries

- Expose only approved `analytics` views. Keep FHIR source tables, ledger tables, credentials,
  connection strings and raw audio/transcript data out of Metabase.
- Prefer aggregate or de-identified views. If a report needs identifiable records, document the
  minimum necessary fields, restrict collection/row access, disable public sharing, review query
  history and cached-result retention, and log exports.
- Before any PHI reaches Metabase or its metadata database, complete the vendor and hosting review,
  confirm applicable BAA terms, access-control and audit requirements, encryption, backup and
  retention settings, incident response, and a restore test. This sample config does not establish
  HIPAA compliance.
- A read-only SQL role is defense in depth; it does not replace network isolation, replica-only
  credentials, encryption in transit, identity controls, or monitoring replication lag.

No report data is seeded by these examples. Verify each view against source totals and expected
date semantics before an administrator makes it available to staff.

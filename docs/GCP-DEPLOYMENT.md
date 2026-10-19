# Google Cloud deployment plan

Platform decision accepted by the owner on 16 October 2026. This replaces the previous AWS proposal. **No cloud infrastructure has been provisioned.** Local development remains unchanged.

## Deployment shape

Use [Medplum's upstream GCP deployment](https://www.medplum.com/docs/self-hosting/install-on-gcp): Terraform for infrastructure and Helm for the unmodified Medplum application. Pin and validate the Medplum image, chart and Terraform revision together. The upstream GCP path requires operational configuration; this repository does not yet contain a deployable `infra/` stack.

| Component | GCP target | Implementation notes |
|---|---|---|
| Medplum API and Teleemon services | Google Kubernetes Engine (GKE) | Separate workloads/service accounts; `vmcontext` Bots; readiness/liveness probes; controlled rolling releases |
| FHIR and ledger databases | Cloud SQL for PostgreSQL | Private connectivity; separate ledger credentials; backups and PITR; regional availability for production |
| Cache and subscription queues internal to Medplum | Memorystore for Redis | Private connectivity; preserve upstream Medplum Redis requirements |
| Patient binaries, documents and audio | Private Cloud Storage buckets | Use Medplum's GCP storage configuration and authenticated reads; no public patient buckets or shared CDN cache |
| Static staff/portal assets | Cloud Storage + Cloud CDN + HTTPS Load Balancer | Only static application assets are public/cacheable; restrict allowed API origins to actual app domains |
| Public edge protection | Cloud Armor and Google-managed TLS | Rate-limit auth/booking; private databases and cache |
| Integration jobs | Pub/Sub subscriptions and dead-letter topics | Worker-side idempotency, bounded retries and failure Tasks; at-least-once delivery is expected |
| Runtime configuration and credentials | Secret Manager + Workload Identity | No downloaded service-account keys in images, repositories or browser bundles |
| Operational logs and alerts | Cloud Logging, Cloud Monitoring and Cloud Audit Logs | Strip patient names, search terms and clinical text before logging; enable required data-access logs explicitly |
| Immutable audit export (Phase 9) | Separate Cloud Storage bucket with Bucket Lock | Review retention duration before locking; test exports and access restrictions first |
| Outbound email | SMTP provider to be selected | GCP hosting does not provide a configured application mail relay; review contract and data handling before use |

Staging and production must use separate GCP projects, credentials, buckets and databases. Staging uses synthetic data and vendor sandboxes. Production must not use the synthetic passwords, setup service client or seed script.

## Work required before remote staging

1. Select project IDs, US region, billing account and DNS names; establish least-privilege operator access.
2. Add reviewed Terraform modules and Helm values under `infra/`, based on the pinned upstream deployment. Run a Terraform plan before applying it.
3. Configure Medplum URLs, exact CORS origins, GCP binary storage, Redis/database connectivity, Secret Manager and the `vmcontext` runtime. Enable audit events and pre-commit subscriptions at server and project level.
4. Build/deploy the staff app and Bots, load synthetic data, and run the Phase 1 API and browser regression checks in staging.
5. Test backup restore, binary access, MFA, audit capture and rollback. RPO 15 minutes and RTO 4 hours remain targets until measured in a restore exercise.

Before processing PHI, verify the [Google Cloud BAA and covered services](https://cloud.google.com/security/compliance/hipaa-compliance), region/data boundaries, vendor contracts and application controls. A GCP platform choice alone does not establish production readiness.

## Operational references

- [Cloud SQL point-in-time recovery](https://cloud.google.com/sql/docs/postgres/backup-recovery/pitr)
- [Cloud Storage Bucket Lock](https://cloud.google.com/storage/docs/bucket-lock)
- [Pub/Sub delivery semantics](https://cloud.google.com/pubsub/docs/subscriber)

AI transcription remains behind the service adapter. No AWS transcription fallback is planned; any alternative requires its own capability, retention and contract review before implementation.

## Phase 4 scribe deployment and costing

See [TELEHEALTH-SCRIBE-PLAN.md](TELEHEALTH-SCRIBE-PLAN.md) for Google Meet capture and after-visit processing only. Google Meet hosts the call; Teleemon's GCP service handles authorized audio ingest, OpenAI calls, job state, private storage and retention. Google Meet is selected; verify capture support on the supported browser/OS matrix. Upload audio during recording for durability; dispatch OpenAI transcription and drafting only after stop and upload finalization. No realtime transcription service or Zoom adapter is planned. Provision scoped service identity, private audio storage, upload limits, durable/idempotent jobs, consent revocation handling, usage metrics and visible failures with Phase 4.

Budget meeting subscriptions and OpenAI separately from incremental GCP costs and from the full EHR deployment. The earlier $25/month scribe allowance is illustrative, not a quote for this GKE/Cloud SQL/Memorystore architecture. Estimate actual compute, storage duration/versions, requests, networking and monitoring for staging/production before provisioning. Audio deletion policies and any lifecycle backstop must respect legal holds; retain transcript policy separately. No cloud provisioning or purchase is authorized by updating this plan.

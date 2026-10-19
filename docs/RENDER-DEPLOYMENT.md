# Render demo deployment

Prepared 19 October 2026 for a client demonstration using synthetic data only. This is not a production release. Live integrations remain disabled.

## Status and account prerequisites

- Official Render CLI v2.30.0 is installed at `.render.local/bin/render.exe`.
- CLI configuration is intentionally isolated in `.render.local/config`; the existing `*.local` ignore rule excludes both the binary and credentials from Git.
- Provider and patient production builds passed locally on 19 October 2026. Bundle-size warnings are informational.
- The local repository currently has no remote. Render needs access to a Git repository containing the source, or a published container image. No source has been uploaded by this deployment attempt.
- CLI device authorization and workspace selection are required before remote validation or provisioning. No Render resources have been created by this attempt.

In PowerShell from the repository root:

```powershell
$env:RENDER_CLI_CONFIG_DIR = [IO.Path]::GetFullPath('.render.local/config')
$env:RENDER_CLI_DISABLE_ANALYTICS = '1'
& ./.render.local/bin/render.exe login -o text
& ./.render.local/bin/render.exe workspaces -o json
# Select the intended workspace using the documented CLI prompt:
& ./.render.local/bin/render.exe workspace set
& ./.render.local/bin/render.exe blueprints validate render.yaml -o text
```

Authorization happens in the browser; never paste an API key or account password into chat. JSON returned by account/service commands can contain sensitive configuration: inspect locally and share only the fields needed for status.

## Cost boundary: the existing Blueprint is paid

**Do not apply `render.yaml` expecting a free deployment.** It currently provisions:

| Resource | Configured plan / storage |
| --- | --- |
| Medplum FHIR API | `1c-2g`, plus 10 GB persistent disk |
| Staff gateway, patient gateway, portal API, ledger, scribe | Five `0.5c-512mb` web services |
| Background worker | `0.5c-512mb` cron, every minute |
| Redis-compatible Key Value | `256mb`, persistent mode |
| Medplum and ledger databases | Two `0.5c-1g` PostgreSQL instances |

Obtain the owner's approval of the current Render estimate before creating these resources. Do not let API/CLI defaults silently select paid plans. The current CLI can create services and databases individually; `blueprints validate` validates YAML but does not apply a Blueprint. Use the Dashboard Blueprint flow for applying this file, or explicit reviewed CLI creation commands and environment wiring for each resource.

The free tier is not a drop-in equivalent: it allows one free PostgreSQL database per workspace, no free persistent disks or cron jobs, and free web services cannot receive private-network traffic. Merely changing `plan` to `free` would break this design. See [Render free limits](https://render.com/docs/free), [CLI](https://render.com/docs/cli), and [compute plan IDs](https://render.com/docs/compute-plans).

A strictly free alternative is Render-hosted frontends connected to the existing local backend through a separately configured tunnel. That remains dependent on this computer and requires HTTPS API routes, CORS, trusted proxy and authentication callback testing. It is a different deployment topology and should be selected explicitly. No tunnel has been exposed as part of this preparation.

## Existing configuration and startup order

1. Publish source to the approved Git repository, excluding local credentials, `.render.local`, `.env.local`, generated secrets and synthetic export files containing login credentials. Retain package lockfiles and Render configuration.
2. After account/workspace and cost approval, create the two databases and Key Value service, then deploy Medplum using `render/medplum/Dockerfile`. Attach the configured Binary disk and confirm `/healthcheck`.
3. Reserve/create both app gateways to establish their actual public HTTPS hostnames. Never assume a requested name equals its assigned hostname.
4. Set Medplum's allowed origins and app base URL to the actual app URLs. The bootstrap super-admin must use a generated secret, not a development default.
5. Bootstrap the remote synthetic Medplum project and Bots from an **isolated deployment checkout and isolated environment files**. `scripts/setup.ts` writes root and app-local environment files; running it directly in the active local checkout could overwrite working local identifiers or reuse local project credentials. Do not run it with the current local `.env.local` against the remote server.
6. Configure the generated project and service-client values on the correct remote services. Keep secrets server-side. The patient OAuth redirect must use its final HTTPS URL. `npm run render:env` prints secrets and must not be captured in shared logs/chat or committed.
7. Apply the ledger schema with `render/ledger-migrate.mjs`, then start ledger, portal API and scribe. Configure their allowed origins, internal authentication and actual upstream addresses. Keep OpenAI credentials absent and PHI/clinical approval flags false for the synthetic scribe path.
8. Build and serve each frontend through `render/gateway.mjs`. These are gateways, not static-only deployments: they proxy `/api/portal`, `/api/ledger` and `/api/scribe`. Plain static hosting without replacement API routing will not demonstrate the full app. Medplum URL/project/client settings and `VITE_PORTAL_URL` are compiled by Vite: after bootstrap values are entered, **rebuild/redeploy both frontend services**. A runtime restart alone does not change their built configuration. Repeat the rebuild and OAuth redirect review if hostnames change.
9. Configure the worker's remote service client and synthetic/log adapters; qualify its scheduled run. The `--once` cron exits before starting the worker's webhook HTTP server, so this topology does not provide inbound worker webhooks. Do not present those integrations as working. Do not supply live SMS, prescribing, clearinghouse, payment or Meet credentials for the demo.
10. Seed the remote demo deliberately, then rehearse both roles using its assigned URLs.

## Presentation acceptance

- Provider and patient sign-in work through HTTPS with the intended redirects.
- Patient list/search and chart open; appointment booking and check-in persist across reloads.
- Encounter draft/review works; the synthetic scribe is identified as synthetic.
- Patient/provider authorization stays separate; no server-side secrets appear in built frontend files.
- Financial screens use sandbox/mock data and reconcile with the remote ledger.
- A representative uploaded document survives a restart if persistent storage is part of the selected topology.
- Verify actual upstream connectivity, not only frontend `/healthz` responses.
- Open the workflows before the meeting and keep the currently working local apps as a backup.

## Outstanding inputs

The deployment cannot finish until the Render CLI is authorized, the intended workspace and accessible Git repository are known, and either the paid full-stack configuration or a specific free hybrid topology is selected. Do not report the app as deployed until its public URLs and representative end-to-end workflows have been verified.

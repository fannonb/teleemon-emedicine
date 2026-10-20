# Temporary demo uptime

The `Demo uptime` GitHub Actions workflow checks both hosted `/medplum/healthcheck` endpoints every five minutes. It requires valid JSON confirming API, PostgreSQL and Redis health; an HTML login page or a redirect cannot pass. Cold starts receive up to three attempts with 90-second request timeouts. Results appear in the workflow run summary; failures mark the run failed and use the account's existing Actions notification preferences.

The workflow runs on GitHub-hosted runners, independently of the operator's computer. Scheduled Actions are best effort: they can be delayed, and public-repository schedules are disabled after 60 days without repository activity. This is temporary demo support, not an availability guarantee.

## Configuration

Repository: `fannonb/teleemon-emedicine`.

| Repository variable | Meaning |
| --- | --- |
| `DEMO_UPTIME_ENABLED` | `true` enables the scheduled monitor. Set `false` to disable all monitor jobs. |
| `DEMO_UPTIME_UNTIL` | Required UTC ISO timestamp. After this time, no health requests or backend recovery run. |
| `DEMO_CODESPACE_RECOVERY_ENABLED` | `true` enables recovery and hourly maintenance of the existing Codespace. |
| `DEMO_CODESPACES_QUOTA_CONFIRMED` | Set `true` only after confirming available Codespaces quota and a zero-paid-overage spending control if only included usage is authorized. |

Monitor-only mode needs no additional secret. Backend recovery requires the encrypted repository Actions secret `DEMO_CODESPACES_TOKEN`. Prefer a short-lived, dedicated credential with the Codespaces access required by GitHub CLI. The built-in `GITHUB_TOKEN` does not manage a personal Codespace. Never commit a token or place it in a repository variable. Copying an existing personal token into Actions requires the owner's explicit approval; anyone able to modify trusted workflows could arrange to use that secret. The monitor does not need Render credentials, a database password, a private SSH key, or the gateway token.

The deployment credential must also be allowed to create/update workflow files. OAuth tokens require the `workflow` scope; repository access by itself is insufficient.

## Recovery behavior

On a failed health probe, on manual dispatch, and hourly while enabled, recovery:

1. Checks only `teleemon-synthetic-client-demo-5vxj76x9pjrhvp6v` and resumes it if shut down.
2. Waits for availability and connects using GitHub CLI's runner-generated SSH key.
3. Checks the existing backend; if its gateway is down and no bootstrap is running, launches the existing bootstrap. Backend logs and secrets remain private in the Codespace.
4. Restores public visibility for approved port `3400` only.
5. Rechecks both public Render API endpoints.

It never creates a Codespace or paid service, deletes data, forwards another port, or changes spending limits. Hourly SSH maintenance is intended to refresh activity during the temporary demo window; the 12-hour Codespace lifetime still applies, and recovery can involve downtime. Expired credentials, insufficient quota, a GitHub outage, or regional tunnel faults may still require an operator. The existing `HYBRID_TUNNEL_CONNECT_HOST` setting remains in place.

## Cost controls

Keeping both Render gateways active consumes two instance-hours per clock hour from the workspace's shared 750-hour monthly allowance. Codespaces compute and storage consume the owner's included allowance; existing billing settings determine whether overages stop usage or incur charges. Do not set `DEMO_CODESPACES_QUOTA_CONFIRMED=true` without checking those settings. This workflow does not enforce GitHub's billing budget itself.

Keep the initial monitoring window short and extend it deliberately. Disable recovery first if Codespaces allowance is low. For continuous availability, move the backend to an always-on deployment.

## Validation

Run `node --test render/demo-uptime.test.mjs render/gateway-hybrid.test.mjs render/hybrid-backend.test.mjs`, then `node render/monitor-demo.mjs`. After pushing the workflow, set the variables, trigger `gh workflow run demo-uptime.yml`, and verify its completed run and summary. Do not claim backend recovery is deployed until a run containing the recovery step succeeds.

For a manual recovery or controlled restart rehearsal, use `gh workflow run demo-uptime.yml -f recover_first=true`. This resumes the backend before probing, avoiding the initial cold-start retries while the Codespace is known to be shut down. Scheduled runs continue to probe before attempting recovery.

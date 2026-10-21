# Temporary demo uptime

The Codespace's independent watchdog checks both hosted `/medplum/healthcheck` endpoints every two minutes while the Codespace is running. The `Demo uptime` GitHub Actions workflow is also configured for five-minute checks and hourly maintenance, but its recurring delivery is best effort. The checks require valid JSON confirming API, PostgreSQL and Redis health; an HTML login page or a redirect cannot pass. Cold starts receive bounded retries. Workflow results appear in the run summary; failures mark the run failed and use the account's existing Actions notification preferences.

The workflow runs on GitHub-hosted runners, independently of the operator's computer. Scheduled Actions are best effort: they can be delayed, and public-repository schedules are disabled after 60 days without repository activity. This is temporary demo support, not an availability guarantee.

**Audit correction, 20 October:** the initial verification exercised only `workflow_dispatch`. During the following hour, the active workflow received no `schedule` runs at all, and both Render gateways restarted around 12:06 UTC. Successful manual executions did not verify recurring delivery. The independent Codespace timer was added because GitHub cron cannot be relied upon to keep a service below Render's 15-minute idle threshold. The GitHub schedule was simplified and re-registered, but must not be described as verified until an actual `schedule` event completes.

## Independent Codespace timer

`render/codespaces/ensure-monitor.mjs` launches a single `uptime-watchdog.mjs` process. The bootstrap and recovery scripts invoke the launcher, so the monitor resumes with the backend. Its expiry configuration and last 60 observations are stored under `~/.teleemon-codespaces/uptime/`, with private filesystem permissions. Configuration and status writes use atomic replacement. No additional credentials are needed.

To inspect actual timer delivery in the Codespace, read `~/.teleemon-codespaces/uptime/state.json`. Check that `ticks` increases, successive `startedAt` timestamps are approximately two minutes apart, and both site results are healthy. A stale state file is not evidence of an active monitor.

To stop this independent timer, run `node render/codespaces/ensure-monitor.mjs --disable` inside the Codespace. It exits at its next tick. Setting only the GitHub variable `DEMO_UPTIME_ENABLED=false` does **not** stop this separate process. To re-enable or change expiry, set `DEMO_UPTIME_UNTIL` to the approved timestamp and run the launcher again.

This timer keeps Render warm while the Codespace runs; it cannot restart a stopped Codespace. An external scheduler such as cron-job.org is needed for checks and recovery dispatch that remain independent of both Codespaces and GitHub's cron delivery. HTTP health probes also do not extend a user's application login session.

## External cron-job.org checks

The external jobs `Teleemon staff API health` and `Teleemon patient API health` probe each Render site's `/medplum/healthcheck` every five minutes (`*/5 * * * *`, timezone `Africa/Nairobi`). Both are enabled with response history saved and expire on 27 October 2026 at 23:59 Nairobi time. Failure notifications are configured after three failures, with recovery and automatic-disable notifications enabled through the account's existing channels. Redirects are not treated as success.

These HTTP jobs keep the public gateways active and report outages; they do not dispatch backend recovery or restart a stopped Codespace. The existing recovery workflow remains responsible for backend recovery. Job definitions are recorded in `render/cron-job-demo-jobs.json`; manage live jobs in the cron-job.org console: staff job `8687584`, patient job `8687595`.

Both external test runs returned HTTP 200 on 20 October, with JSON confirming `ok`, PostgreSQL and Redis health. Actual automatic delivery was also verified: both jobs executed successfully at 18:15:02 Nairobi time on 20 October 2026 (staff 2.39 seconds, patient 3.15 seconds), and the console listed the next executions at 18:20. This verifies the first scheduled delivery; it is not an availability guarantee.

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

**Recovery failure, 21 October:** run `39553041859` resumed the Codespace, then failed before restoring port 3400. Inspection found the Codespace available and its backend healthy after running the existing recovery script, but port 3400 remained private. The existing logs do not identify the failed CLI operation. The recovery fix adds bounded retries for status/resume API calls, SSH startup and port restoration, and reports the failed stage without printing raw CLI errors. Local regression tests cover transient relay/port/API failures and exhausted SSH retries. Deployment and live verification require restoration of the gateway's approved public visibility.

## Cost controls

Keeping both Render gateways active consumes two instance-hours per clock hour from the workspace's shared 750-hour monthly allowance. Codespaces compute and storage consume the owner's included allowance; existing billing settings determine whether overages stop usage or incur charges. Do not set `DEMO_CODESPACES_QUOTA_CONFIRMED=true` without checking those settings. This workflow does not enforce GitHub's billing budget itself.

Keep the initial monitoring window short and extend it deliberately. Disable recovery first if Codespaces allowance is low. For continuous availability, move the backend to an always-on deployment.

## Validation

Run `node --test render/demo-uptime.test.mjs render/gateway-hybrid.test.mjs render/hybrid-backend.test.mjs`, then `node render/monitor-demo.mjs`. After pushing the workflow, set the variables, trigger `gh workflow run demo-uptime.yml`, and verify its completed run and summary. Do not claim backend recovery is deployed until a run containing the recovery step succeeds.

For a manual recovery or controlled restart rehearsal, use `gh workflow run demo-uptime.yml -f recover_first=true`. This resumes the backend before probing, avoiding the initial cold-start retries while the Codespace is known to be shut down. Scheduled runs continue to probe before attempting recovery.

# Temporary hosted monitoring verification — 20 October 2026

## Deployed configuration

- Workflow: `.github/workflows/demo-uptime.yml`, on the repository's `main` branch.
- API health monitoring: every five minutes, with an additional hourly maintenance run. GitHub scheduling is best effort.
- Temporary window: through `2026-10-27T20:59:59Z` (23:59:59 on 27 October in Africa/Nairobi). No health requests or recovery execute after expiry.
- `DEMO_UPTIME_ENABLED`, `DEMO_CODESPACE_RECOVERY_ENABLED`, and `DEMO_CODESPACES_QUOTA_CONFIRMED`: `true`.
- The owner explicitly approved encrypting the existing GitHub CLI credential as `DEMO_CODESPACES_TOKEN` and confirmed that paid Codespaces overages are blocked. No credential value is recorded here.
- No Render credentials, private SSH keys, database passwords, or gateway token were copied into Actions.

## Completed live runs

1. [Monitor-only verification](https://github.com/fannonb/teleemon-emedicine/actions/runs/39412837755): success; both API/PostgreSQL/Redis health checks passed.
2. [Hosted maintenance verification](https://github.com/fannonb/teleemon-emedicine/actions/runs/39412986757): success; the runner connected to the existing Codespace, checked its backend and restored the approved public port, then verified both public APIs.
3. [Actual shutdown and recovery rehearsal](https://github.com/fannonb/teleemon-emedicine/actions/runs/39413211583): success. The Codespace was cleanly stopped. The hosted runner requested its resume, waited for startup, checked its services, restored public visibility for port 3400 and verified both public API/database health endpoints. The recovery step ran from 11:11:51 to 11:13:11 UTC, approximately 80 seconds. Existing persistent databases were retained.

Five initial monitor/recovery tests and seven gateway tests passed; the added shutdown-transition regression test also passed. The final local monitor confirmed both public APIs healthy after the rehearsal.

## Limits and controls

GitHub's 12-hour Codespace lifetime still applies. Hourly maintenance and automatic recovery reduce manual intervention but do not guarantee uninterrupted availability. Scheduler delays, quota exhaustion, expired credentials and tunnel faults can cause downtime. The monitor marks failed checks as failed Actions runs and uses the account's existing notification preferences.

To pause monitoring, set `DEMO_UPTIME_ENABLED=false`. To pause only recovery, set `DEMO_CODESPACE_RECOVERY_ENABLED=false`. The stored Actions secret remains encrypted after the operating window expires; delete `DEMO_CODESPACES_TOKEN` when temporary recovery is no longer needed. The original GitHub CLI authorization is not revoked by deleting this repository secret.

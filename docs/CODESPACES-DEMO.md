# GitHub Codespaces backend for the synthetic Render demo

This configuration runs the demo backend in GitHub Codespaces and keeps the provider and patient frontends on Render. It uses synthetic fixtures and mock integrations only. Do not use patient data or production credentials.

## What runs where

- Render continues to serve the provider and patient apps.
- Codespaces runs Medplum 5.2.4, its PostgreSQL database, Redis, the ledger database, portal API, ledger API, scribe API and worker.
- Only Codespaces port `3400` is public. It reaches the existing Render hybrid gateway through a thin listener. The gateway still requires `HYBRID_DEMO_TOKEN` and applies its existing API route allowlist.
- Medplum, Redis and database ports are not forwarded publicly. Persistent Docker volumes keep the synthetic demo fixtures across ordinary Codespace restarts.

## Prepare the GitHub repository

1. Confirm the repository is `fannonb/teleemon-emedicine` and that the latest configuration is on the branch used to create the Codespace.
2. In **Repository Settings → Secrets and variables → Codespaces**, add `HYBRID_DEMO_TOKEN`. Use the same random value already configured in the Render provider and patient services. It must be at least 32 characters. Never paste it into a source file or terminal command that gets recorded.
3. Create a Codespace on the demo branch using a **2-core Linux machine**. The devcontainer installs Node 22, Docker-in-Docker and the project dependencies. Allow its first build to finish.
4. In the Codespaces **Ports** panel, confirm port `3400` has visibility **Public**. No other port should be forwarded.

The automatic startup creates a random Medplum administrator password and database passwords in ignored, owner-readable `.env.local` files in the Codespace. It initializes the Teleemon project, applies Bots and policies, creates synthetic users, seeds synthetic patients and visits, applies the ledger schema, and starts the services. It does not print generated administrator/database passwords or the shared gateway token. Seeded demo logins use the synthetic passwords already listed in the repository README and phase 7 checklist.

## Connect the Render frontends

After Codespaces exposes port `3400`, copy its **public HTTPS origin** (the `https://<codespace>-3400.app.github.dev` address) and set the same origin on both Render gateway services:

- `MEDPLUM_API_URL`
- `PORTAL_API_URL`
- `LEDGER_API_URL`
- `SCRIBE_API_URL`

Keep `HYBRID_DEMO_TOKEN` set to the same secret on each Render service and in the Codespaces secret. These variables are server-side gateway configuration; do not add the token to any `VITE_*` setting or browser code. Keep each frontend's existing public `MEDPLUM_BASE_URL`, client ID, project ID and portal URL values. The Medplum server is configured with the provider app's public `/medplum/` URL and the bootstrap script connects to its private loopback port for initialization.

The Codespaces public URL can change if the Codespace is deleted and recreated. If it changes, update all four Render API URL settings again. A stopped Codespace makes the backend unavailable; resume it and wait for the startup message before opening the Render apps.

## Manual recovery commands

Run these from a Codespaces terminal at the repository root. The automatic startup normally performs them:

```sh
npm ci --include=dev
npm run bots:build
node render/codespaces/start.mjs
```

The first startup sequence is: Docker Compose infrastructure, Medplum health check, `npm run setup`, `npm run seed`, `npm run portal:demo`, ledger schema migration, then the service processes. Docker service logs can be read with:

```sh
docker compose --project-name teleemon-codespaces --env-file .env.local -f render/codespaces/docker-compose.yml logs --tail=100
```

Node service logs are under `~/.teleemon-codespaces/logs/`. To stop the infrastructure, use:

```sh
docker compose --project-name teleemon-codespaces --env-file .env.local -f render/codespaces/docker-compose.yml down
```

Do not add `--volumes` unless you intentionally want to erase the synthetic demo database and uploaded demo binaries.

## Free quota and operating limits

GitHub Codespaces has a monthly included compute/storage allowance based on the account plan. A two-core Codespace consumes compute quota while it runs; stop it after the presentation. Confirm the account's remaining Codespaces quota before the demo. Free quota, public-port policy and availability are GitHub account settings and are not guaranteed by this repository configuration.

This setup is a temporary demo environment, not a production deployment. The public gateway is protected by the shared token, but the app has not passed production security, availability, BAA or clinical acceptance gates. Use synthetic data only.

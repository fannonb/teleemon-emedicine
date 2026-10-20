# Render demo access recovery — 20 October 2026

## Cause and repair

Both Render frontends served HTML, but their shared Codespaces API backend was shut down. Resuming the Codespace restarted the existing services and retained the databases. Port 3400 reverted to private visibility; the user explicitly approved restoring its public visibility. The gateway continues to require its existing shared token.

Render still received empty 404 responses from `tunnels-prod-rel-usw2-v3-cluster`. Direct requests through UK ingress and another US ingress worked. Restarting both Render gateways, redeploying their existing builds, refreshing port visibility, and cleanly restarting the Codespace did not resolve that regional ingress failure.

Commit `8685c92867de053677deb9f1dd237ce92230b7f4` adds the optional `HYBRID_TUNNEL_CONNECT_HOST` setting. Both Render services now use `v3-uks1.cluster.rel.tunnels.api.visualstudio.com` for their tunnel connections. The gateway preserves the original Codespaces HTTP Host and TLS server name; normal certificate validation and shared-token authorization remain enabled.

## Verification

- Staff deployment `dep-dbbka4mq1p3s73ct6un0`: live.
- Patient deployment `dep-dbbka4rncjis7391ha40`: live.
- Staff `/signin` and patient `/`: HTTP 200.
- Both pages' referenced JavaScript and CSS assets: HTTP 200 with the expected content types.
- Both sites' `/medplum/healthcheck`: HTTP 200, including healthy PostgreSQL and Redis.
- Both sites' `/medplum/.well-known/openid-configuration`: HTTP 200, with the staff HTTPS `/medplum/` issuer.
- Anonymous direct backend `/medplum/healthcheck`: HTTP 401.
- Both sign-in pages render in the browser.
- Seven existing and added gateway regression tests pass.
- After explicit user approval, the existing synthetic patient login reaches `/home`, with the next visit and portal navigation displayed.
- After explicit user approval, the existing synthetic staff administrator login reaches `/today`, with the schedule and work queues displayed.

## Remaining availability limits

The Codespace has a 240-minute idle timeout. GitHub resets public ports to private after a restart, so an operator must resume the Codespace and restore port 3400 visibility before use. The regional ingress should be rechecked after restarts. This is a synthetic demo configuration; continuous availability requires an always-on backend deployment.

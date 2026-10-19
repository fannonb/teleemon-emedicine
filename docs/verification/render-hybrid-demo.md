# Render hybrid demo verification

19 October 2026. Synthetic data only; not a production release.

## Deployment

- Source pushed to `https://github.com/fannonb/teleemon-emedicine`, branch `main`.
- Provider service `srv-dbb3tu2gjjms73ctvn40`: https://teleemon-staff-demo.onrender.com
- Patient service `srv-dbb3ttm7bikc73cvclt0`: https://teleemon-patient-demo.onrender.com
- Render CLI reports both deployments live and both services on `free` compute. No paid Blueprint resources were created.
- Backend services and existing databases run locally; the remote gateways use a token-protected HTTPS tunnel. Original local Medplum configuration is preserved; an ignored demo overlay supplies public URLs.

## Verified

- Both production frontend builds passed; corrected nonexistent Node pin to `22.23.3`.
- Six proxy tests pass: HTTPS-only origin validation, request path preservation, authorization header handling, token enforcement, loopback route validation, and Medplum path allowlist.
- Direct tunnel requests without the shared token return 401; `/medplum/admin` returns 404.
- Both remote frontend `/healthz` and proxied Medplum `/healthcheck` return 200. OAuth discovery reports the public HTTPS issuer and token endpoints.
- Existing synthetic practice administrator login reaches the hosted Today dashboard, patient directory/pagination and calendar.
- Existing synthetic patient login reaches the hosted home page and visit page, displaying the existing appointment and check-in state.
- The existing Maya encounter opens with its documentation form, chart context and signing controls; no note was signed or clinical text changed during this check. Patient billing loads its existing zero balance and empty statement list.
- Patient OAuth client includes the new exact HTTPS origin callback and retains its existing local callback.
- Worker starts with SMS/email/fax log delivery, eRx/clearinghouse mocks and sandbox meeting links.

## Limits

This verification does not establish live vendor delivery, complete regression acceptance, real video capture or production security readiness. Free gateways may sleep; the backend depends on this computer and tunnel staying online. A restarted quick tunnel can change hostname and require updating Render server-side upstream URLs. No real patient data should be used in this demo.

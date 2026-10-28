# API HNQ

API HNQ is a loopback-only OpenAI-compatible gateway for the local Cockpit API. It supports `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`. JSON and Cockpit SSE bytes are proxied without adapting prompts, tool calls, or response content.

Public client and agent integration documentation is served as Markdown at `https://apihnq.hnquan.com/api.md`; its source is [`docs/api.md`](docs/api.md).

## Configuration and security

Node 24.7–24.x is required. The application does **not** load `.env`; set configuration in the process or service environment. `API_HNQ_SECRETS_FILE` is mandatory and points outside this repository to an ACL-restricted JSON file:

```json
{
  "upstreamApiKey": "Cockpit key",
  "sessionSecret": "random base64url value with at least 32 characters"
}
```

All other supported variables, limits, and defaults are documented in `.env.example`. The listener is restricted to `127.0.0.1`, `::1`, or `localhost`; the upstream is a fixed HTTP(S) URL ending in `/v1`, has no credentials/query/fragment, and redirects are refused. No Cloudflare credential belongs in this application.

`/healthz` and `/readyz` intentionally expose only `{ "ok": true }`. They do not reveal upstream state, paths, keys, or database details. Client limits are in-memory and reset when this one-process gateway restarts.

## Local build and admin bootstrap

```powershell
npm install
npm run build
$env:API_HNQ_SECRETS_FILE = 'C:\safe\secrets.json'
$env:API_HNQ_DATABASE_PATH = 'C:\safe\api-hnq.sqlite'
npm run admin:bootstrap -- admin
npm start
```

`admin:bootstrap` prompts without echo when used interactively. Non-interactive automation may provide the password on standard input; never put it in a command-line argument. There is no default administrator or password. The first client key is displayed only when created in `/admin`.

Admin sessions are server-side, eight hours long, HttpOnly/SameSite cookies, and only work while the user is enabled. `GET /admin/api/session` returns `{user, csrfToken}` so a page reload can retain the session; the CSRF token is HMAC-derived from the session cookie and does not need browser storage. State-changing admin calls require that token and the configured Origin. Login attempts are bounded per IP/username (8 per 15 minutes) and unknown users execute the same Argon2 work as known users.

## Data, usage, and recovery

SQLite uses WAL, foreign keys, transactional checksum-validated migrations, and online backup. Do not edit an applied migration; add a new numbered migration. Current request retention is 30 days and audit retention is 90 days, evaluated hourly using ISO-aware SQLite `julianday` comparisons.

```powershell
npm run db:backup -- C:\safe\api-hnq-backup.sqlite
# Stop the gateway first, then verify and restore a backup atomically:
npm run db:restore -- C:\safe\api-hnq-backup.sqlite
```

Restore validates SQLite integrity before replacing the target. Roll back an application release by stopping the gateway, starting the prior compatible build, and retaining the backup made before deployment. If a future schema is not backward-compatible, stop writers and restore that verified backup; writes since that backup are lost. Do not copy a live WAL database file directly.

The database stores hashes, key/session metadata, request metadata, numeric upstream usage, and audits. It never stores Authorization, cookies, prompts, completions, or arbitrary SSE data. `GET /admin/api/usage` returns daily per-key/per-model totals with `null` totals when unavailable and `unknownUsage` counts; it never infers missing usage as zero. The admin Usage tab also tracks cached input tokens, cache rate, and reasoning tokens when Cockpit reports them. Those metrics begin with requests made after this release; historic gateway records cannot be backfilled safely.

## Cockpit model catalog

Open **Admin → Available Cockpit models** and choose **Sync from Cockpit** to save the current `/v1/models` inventory. The catalog records model IDs and safe metadata only; unavailable models are retained as historical entries rather than deleted. It is used as a picker when creating restricted API keys, while manual IDs remain supported.

The additive migration also creates disabled `model_mappings` records for a later alias feature. Syncing does not rewrite requests, change the output of `/v1/models`, or activate any mapping. Public model IDs continue to pass directly to Cockpit until a dedicated mapping release is configured.

## Timeouts and proxy behavior

TCP connect, response-header wait, stream idle, total request time, body size, upstream non-stream body size, RPM, and concurrency all have separate fail-closed limits. `POST /v1/chat/completions` and `POST /v1/responses` accept JSON bodies up to 16 MiB by default (`API_HNQ_BODY_LIMIT`); admin and all other routes remain capped at 1 MiB. Client close aborts the upstream request and releases the concurrency slot. A broken SSE stream is closed after headers rather than sending a second JSON response. Upstream 3xx/401/403/5xx and error bodies are sanitized; redirect targets and raw upstream errors are not exposed or logged.

## Windows operation

Build before starting the supervisor. The repository supplies [Start-ApiHnq.ps1](deploy/Start-ApiHnq.ps1) for the current user; it does not modify Cloudflare or any shared system service.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\Start-ApiHnq.ps1 -Mode Start -SecretsFile C:\safe\secrets.json -DatabasePath C:\safe\api-hnq.sqlite -BodyLimit 16777216
.\deploy\Start-ApiHnq.ps1 -Mode Status
.\deploy\Start-ApiHnq.ps1 -Mode Stop
# Optional start-on-login registration under HKCU, no administrator needed:
.\deploy\Start-ApiHnq.ps1 -Mode Install -SecretsFile C:\safe\secrets.json -DatabasePath C:\safe\api-hnq.sqlite
```

The supervisor has a PID duplicate guard, hidden child, health status, bounded restart backoff, and rotating logs beneath `%LOCALAPPDATA%\ApiHnq`. Its short Registry Run entry launches a private startup trampoline there, avoiding the Windows 260-character Run-command limit; neither contains a secret value. It preserves the existing shared `cloudflared` service/tunnel. See [Windows runbook](deploy/windows.md) for rollout and rollback.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm audit
```

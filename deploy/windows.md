# Windows runbook

The existing Cloudflare Tunnel route `apihnq.hnquan.com -> 127.0.0.1:8787` and its shared system service are out of scope for this project. Do not install, stop, reconfigure, or remove that service, its tunnel, DNS, or unrelated ingress routes.

## Preflight and rollout

1. Keep `secrets.json` outside the repository and grant only the current service user read access. It contains exactly `upstreamApiKey` and `sessionSecret`.
2. Build and run the test gates. Start a local smoke instance on a non-public alternate port first.
3. Make an online SQLite backup with `npm run db:backup -- <path>` and retain the previous compatible build.
4. Confirm the production configuration binds only to loopback and `API_HNQ_PUBLIC_ORIGIN` is the public HTTPS origin.
5. Start the current-user supervisor only after review approval. It starts `dist/server.js`, checks `/healthz`, and does not touch Cloudflare. Its `-BodyLimit` parameter defaults to 16 MiB for public generation requests; admin and login stay capped at 1 MiB.

The supervisor state and rotated logs are under `%LOCALAPPDATA%\ApiHnq`. It provides `Start`, `Stop`, `Status`, `Install`, and `Uninstall` modes. `Install` uses the current user's `HKCU\...\Run` entry, so it needs no administrator rights and starts at user login. The Run value is deliberately short and launches an `%LOCALAPPDATA%\ApiHnq\startup.ps1` trampoline, avoiding the 260-character Registry Run limit. The trampoline contains paths only; no secret value is stored in the registry or script.

## Status and incident response

`Start-ApiHnq.ps1 -Mode Status` emits compact JSON with supervisor/app PIDs and a local health result. A failed health check means the app must be investigated locally; the public tunnel remains untouched. The child restarts with 1–30 second exponential backoff. `Stop` ends the supervisor and child, then removes stale PID files.

If a release fails, stop only the gateway supervisor, restore the prior compatible build, and start it again. If schema compatibility requires database rollback, keep writers stopped, run `npm run db:restore -- <verified backup>`, then start the prior build. Data written after the backup is lost. Never restore by copying the live database/WAL files and never delete the shared Cloudflare tunnel as part of rollback.

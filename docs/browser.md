# Managed Real Browser (`la-browser`)

`la-browser` is a single managed Docker container running Playwright Chromium on Xvfb with `x11vnc` and `noVNC`, all bound strictly to `127.0.0.1` inside the container (never published on host ports or Tailscale).

## Building the image (~1.5 GB)

Only build after owner approval:

```bash
docker build -t la-browser:latest deploy/browser
```

Set `LA_BROWSER_IMAGE=la-browser:latest` (default). To roll back to the legacy throwaway headless Chromium path at any time, set:

```bash
LA_BROWSER=headless
```

## Memory & Idle Lifecycle

- Acquires a **2 GB** lease from `MemoryBudget` before starting.
- Stops automatically after **15 minutes** idle (`LA_BROWSER_IDLE_MS`), releasing the 2 GB lease.
- Persistent profiles live on disk under `data/browser/<persona>` (one isolated profile per persona; cookies are never shared across personas).

## Safety Rules

- Private/loopback IP addresses are blocked unless `LA_BROWSER_ALLOW_PRIVATE=1`.
- Members do not have browser access (owner-only).
- The agent never types into password fields (asks the owner to take over or use `request_secret`).
- Any submit/click on payment, checkout, billing, or purchase/buy pages requires explicit owner approval (`high` risk tier).
- Vault secret values are redacted from extracted page text and logs.

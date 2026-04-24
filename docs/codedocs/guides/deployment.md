---
title: "Deployment"
description: "Deploy the starter with Docker and Caddy, understand the reverse-proxy layout, and map the repo's Fly.io configuration to production concerns."
---

This guide focuses on the deployment assets that actually exist in the repository: `deploy/Dockerfile`, `deploy/Caddyfile`, `deploy/start.sh`, and `fly.toml`. The backend is still `server.ts`; deployment simply wraps it with a reverse proxy and a built frontend.

## Problem

A live-transcription starter usually needs more than a bare Bun process in production. You need:

- a public HTTP port for static frontend assets,
- a reverse proxy that can handle WebSocket upgrades,
- some rate limiting around token issuance and API access,
- a container entrypoint that starts both the backend and the proxy cleanly.

## Solution

The repo solves this with a three-stage Docker build and a Caddy front door:

- Stage 1 builds a custom Caddy binary with the rate-limit module.
- Stage 2 builds the frontend assets.
- Stage 3 runs Bun for the backend and Caddy for public traffic.

<Steps>
<Step>
### Understand the runtime split

`deploy/start.sh` is the runtime contract:

```sh
eval "$BACKEND_CMD" &
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

Bun starts in the background on port `8081`, and Caddy stays in the foreground on port `8080`.

</Step>
<Step>
### Review the reverse proxy behavior

`deploy/Caddyfile` handles four traffic classes:

```text
/ and /index.html  -> frontend/dist with templates enabled
/api/session       -> reverse_proxy localhost:8081 with 5 req/min per IP
/api/*             -> reverse_proxy localhost:8081 with 120 req/min per IP
/health            -> reverse_proxy localhost:8081
everything else    -> static frontend files
```

This matters because your deployment health checks and your browser clients both hit Caddy, not Bun directly.

</Step>
<Step>
### Build the container

From the repository root:

```bash
docker build -f deploy/Dockerfile -t bun-live-transcription .
```

The Dockerfile copies `package.json`, `bun.lock*`, `server.ts`, `deepgram.toml`, and the built frontend into the runtime image, then exposes port `8080`.

</Step>
<Step>
### Run it with production environment variables

```bash
docker run --rm \
  -p 8080:8080 \
  -e DEEPGRAM_API_KEY=your_real_key \
  -e SESSION_SECRET=replace_this \
  bun-live-transcription
```

From the outside, clients connect to `http://localhost:8080`, while Caddy proxies API traffic to the Bun backend on `8081`.

</Step>
</Steps>

## Complete Deployment Example

This script builds and runs the production container locally:

```bash
#!/usr/bin/env bash
set -euo pipefail

docker build -f deploy/Dockerfile -t bun-live-transcription .

docker run --rm \
  --name bun-live-transcription \
  -p 8080:8080 \
  -e DEEPGRAM_API_KEY="$DEEPGRAM_API_KEY" \
  -e SESSION_SECRET="production-secret-for-jwt-signing" \
  bun-live-transcription
```

Once it is running, validate the reverse-proxied endpoints:

```bash
curl -s http://localhost:8080/health
curl -s http://localhost:8080/api/metadata
curl -s http://localhost:8080/api/session
```

## Fly.io Notes

`fly.toml` confirms the expected public shape:

- app name: `deepgram-bun-live-transcription`
- internal port: `8080`
- HTTPS forced
- machine auto-stop and auto-start enabled

That aligns with the Caddy-first topology. Fly sends traffic to the reverse proxy, and Caddy decides whether to serve static assets or proxy to Bun.

## Operational Considerations

- Set `SESSION_SECRET` explicitly in production. The random fallback in `server.ts` is only appropriate for local use.
- Protect `DEEPGRAM_API_KEY` as a secret; it is injected into the upstream Deepgram URL by the server and must never move into browser code.
- Expect `/api/session` to be stricter than `/api/*` because the Caddy config rate-limits it to `5` requests per minute per IP.
- If you deploy behind another proxy, verify that WebSocket upgrades and `Sec-WebSocket-Protocol` headers are preserved end-to-end.

The deployment files are intentionally uncomplicated, which is consistent with the rest of the repo. If you need multi-service orchestration, central logging, or per-tenant auth, extend from this base rather than replacing it blindly.

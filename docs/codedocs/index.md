---
title: "Getting Started"
description: "Start a Bun-based Deepgram live transcription server, issue session tokens, and proxy real-time audio to Deepgram over WebSockets."
---

This project is a Bun starter that issues short-lived JWT session tokens and proxies a browser WebSocket stream to Deepgram's live speech-to-text API.

## The Problem

- Browser clients need a safe way to connect to Deepgram without exposing a long-lived `DEEPGRAM_API_KEY` in frontend code.
- Live transcription requires a low-latency path for binary audio upstream and JSON transcripts downstream, which is awkward to stitch together from scratch.
- Teams often need a starter that works locally, deploys cleanly, and keeps frontend and backend responsibilities separate.
- Real-time audio pipelines fail in subtle ways when model, language, encoding, and sample rate settings drift out of sync.

## The Solution

`bun-live-transcription` keeps the browser-facing contract small:

1. Call `GET /api/session` to receive a JWT.
2. Open `WS /api/live-transcription` with the `access_token.<jwt>` subprotocol.
3. Stream raw audio frames to the Bun server.
4. Receive Deepgram transcription messages back on the same socket.

```typescript
const session = await fetch("http://localhost:8081/api/session").then((res) =>
  res.json() as Promise<{ token: string }>
);

const params = new URLSearchParams({
  model: "nova-3",
  language: "en",
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
});

const socket = new WebSocket(
  `ws://localhost:8081/api/live-transcription?${params.toString()}`,
  [`access_token.${session.token}`]
);

socket.onmessage = (event) => {
  console.log("Transcript event:", event.data);
};
```

The server implementation in `server.ts` does the rest: it validates the JWT, builds a Deepgram `/v1/listen` URL, opens an upstream `WebSocket`, forwards audio frames to Deepgram, and streams Deepgram responses back to the client without reshaping them.

## Installation

" "bun"]}>
<Tab value="npm">

```bash
npm install
```

</Tab>
<Tab value="pnpm">

```bash
pnpm install
```

</Tab>
<Tab value="yarn">

```bash
yarn install
```

</Tab>
<Tab value="bun">

```bash
bun install
```

</Tab>
</Tabs>

For this repository, Bun is the runtime that matters. The backend entry point is `server.ts`, and the recommended bootstrap flow from the source repo is still:

```bash
make init
cp sample.env .env
# set DEEPGRAM_API_KEY in .env
make start
```

## Quick Start

The smallest useful validation is to boot the backend, inspect metadata, and mint a session token before you connect a browser client.

```bash
# .env must contain DEEPGRAM_API_KEY=...
bun run server.ts
```

Expected startup output:

```text
======================================================================
Backend API Server running at http://localhost:8081

GET  /api/session
WS   /api/live-transcription (auth required)
GET  /api/metadata
GET  /health
======================================================================
```

Then verify the HTTP side:

```bash
curl -s http://localhost:8081/api/metadata
curl -s http://localhost:8081/api/session
```

Expected responses:

```json
{
  "title": "Bun Live Transcription",
  "description": "Get started using Deepgram's Live Transcription with this Bun demo app",
  "useCase": "live-transcription",
  "language": "typescript",
  "framework": "bun"
}
```

```json
{
  "token": "<jwt>"
}
```

Once you have a token, a browser or Node client can open `ws://localhost:8081/api/live-transcription` and start sending `linear16` audio at `16000` Hz.

## Key Features

- Bun-native backend with no extra HTTP framework and no TypeScript build step.
- JWT session endpoint that protects the WebSocket upgrade path.
- Transparent WebSocket proxying between the client and Deepgram.
- Runtime query-parameter mapping for model, language, encoding, sample rate, channels, and formatting options.
- Metadata endpoint backed by `deepgram.toml`.
- Graceful shutdown that closes active sockets before stopping the server.
- Production deployment assets for Caddy, Docker, and Fly.io.

<Cards>
  <Card title="Architecture" href="/docs/architecture">See how the Bun server, JWT gate, and Deepgram socket fit together internally.</Card>
  <Card title="Core Concepts" href="/docs/websocket-proxy">Learn the key abstractions: session auth, proxy lifecycle, and transcription options.</Card>
  <Card title="API Reference" href="/docs/api-reference/http-endpoints">Reference the HTTP routes, WebSocket contract, helper functions, and wire formats.</Card>
</Cards>

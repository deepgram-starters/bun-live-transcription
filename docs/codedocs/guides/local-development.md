---
title: "Local Development"
description: "Run the Bun backend locally, wire in your environment variables, and validate the HTTP and WebSocket flows before touching deployment."
---

This guide covers the shortest path to a working local backend. It assumes you want to validate the Bun server in this repository, not build a separate package from it.

## Problem

You need a repeatable way to bootstrap the starter, supply `DEEPGRAM_API_KEY`, and confirm that the JWT and metadata endpoints work before you connect a real audio source.

## Solution

Use the repo's existing workflow:

- `make init` for dependencies and submodules
- `cp sample.env .env` for environment setup
- `bun run server.ts` or `make start` to launch the backend
- `curl` to test `/api/metadata`, `/api/session`, and `/health`

<Steps>
<Step>
### Install dependencies

The repo recommends `make init`, which wraps submodule initialization and dependency installation for both the backend and the frontend submodule.

```bash
cd /workspace/home/bun-live-transcription
make init
```

If you only need the backend for documentation or API work, `bun install` is enough:

```bash
bun install
```

</Step>
<Step>
### Create the environment file

Copy the sample file and set your Deepgram API key. `server.ts` exits immediately if `DEEPGRAM_API_KEY` is missing.

```bash
cp sample.env .env
```

Then edit `.env`:

```dotenv
DEEPGRAM_API_KEY=your_real_key
PORT=8081
HOST=0.0.0.0
SESSION_SECRET=replace_this_in_production
```

</Step>
<Step>
### Start the backend

Run the Bun entry point directly:

```bash
bun run server.ts
```

Or start the full development stack:

```bash
make start
```

The backend listens on `http://localhost:8081` by default.

</Step>
<Step>
### Validate the HTTP endpoints

Check that the server is healthy, serving metadata, and minting session tokens:

```bash
curl -s http://localhost:8081/health
curl -s http://localhost:8081/api/metadata
curl -s http://localhost:8081/api/session
```

Expected outputs:

```json
{"status":"ok"}
```

```json
{
  "title": "Bun Live Transcription",
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

</Step>
<Step>
### Smoke-test the WebSocket contract

Once `/api/session` works, use that token to open the authenticated socket from a browser or a script:

```typescript
const { token } = await fetch("http://localhost:8081/api/session").then((res) =>
  res.json() as Promise<{ token: string }>
);

const ws = new WebSocket(
  "ws://localhost:8081/api/live-transcription?encoding=linear16&sample_rate=16000&channels=1",
  [`access_token.${token}`]
);

ws.onopen = () => console.log("socket ready");
ws.onmessage = (event) => console.log(event.data);
```

</Step>
</Steps>

## Runnable Example

This Node-style script shows the whole local flow except microphone capture:

```typescript
const session = await fetch("http://localhost:8081/api/session").then((res) =>
  res.json() as Promise<{ token: string }>
);

const ws = new WebSocket(
  "ws://localhost:8081/api/live-transcription?model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1",
  [`access_token.${session.token}`]
);

ws.onopen = () => {
  console.log("connected");
  // send PCM frames here
};

ws.onmessage = (event) => {
  console.log("transcript payload", String(event.data));
};
```

## Troubleshooting

- If the process exits on startup, check that `.env` contains `DEEPGRAM_API_KEY`.
- If `make start` fails because `frontend/` is empty, initialize submodules first with `make init`. In the current checkout used for this documentation task, the frontend and contracts submodules were not populated.
- If the WebSocket upgrade returns `401`, inspect the client subprotocol and ensure it includes `access_token.<jwt>`.
- If the WebSocket opens but transcripts do not arrive, verify that your audio stream really matches the `encoding`, `sample_rate`, and `channels` query parameters.

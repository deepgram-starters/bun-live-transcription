---
title: "Live Transcription WebSocket"
description: "Reference the authenticated WebSocket endpoint, supported query parameters, message flow, and close behavior."
---

`/api/live-transcription` is the main runtime interface of the project. It is implemented in the `fetch(req, server)` upgrade branch plus the `websocket` lifecycle handlers in `server.ts`.

## Endpoint

```text
WS /api/live-transcription
```

### Authentication

The request must include a `Sec-WebSocket-Protocol` value containing:

```text
access_token.<jwt>
```

The JWT is obtained from `GET /api/session`.

### Upgrade Contract

If the token is missing or invalid, the server returns:

```text
401 Unauthorized
```

If the token is valid, Bun upgrades the connection and stores the following per-socket data:

```typescript
interface WsData {
  queryParams: URLSearchParams;
  deepgramWs: WebSocket | null;
}
```

## Supported Query Parameters

These values are consumed by:

```typescript
function buildDeepgramUrl(queryParams: URLSearchParams): string
```

### Defaulted Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | `string` | `"nova-3"` | Deepgram transcription model. |
| `language` | `string` | `"en"` | BCP-47 style language code. |
| `encoding` | `string` | `"linear16"` | Audio encoding expected by Deepgram. |
| `sample_rate` | `string` | `"16000"` | Sample rate for the audio stream. |
| `channels` | `string` | `"1"` | Channel count for the audio stream. |
| `smart_format` | `string` | `"true"` | Enables Deepgram smart formatting by default. |

### Optional Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `punctuate` | `string` | — | Adds automatic punctuation when provided. |
| `diarize` | `string` | — | Enables speaker diarization when provided. |
| `filler_words` | `string` | — | Controls filler-word output when provided. |

## Message Flow

### Client To Server

The server expects binary or textual WebSocket messages that should be forwarded directly to Deepgram. In the intended use case, these are audio frames.

Implementation:

```typescript
message(ws, message) {
  const deepgramWs = ws.data.deepgramWs;
  if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
    deepgramWs.send(message);
  }
}
```

### Server To Client

Every message received from the upstream Deepgram socket is forwarded unchanged to the client:

```typescript
deepgramWs.addEventListener("message", (event) => {
  ws.send(event.data as string | Buffer);
});
```

That means clients should be prepared to parse Deepgram-native JSON strings for transcript events.

## Close And Error Behavior

| Event | Behavior |
|------|------|
| Invalid token | HTTP `401` before upgrade |
| Upstream Deepgram error | Client socket closes with code `1011` and reason `"Deepgram connection error"` |
| Upstream Deepgram close | Client socket closes with Deepgram's code and reason |
| Client close | Upstream Deepgram socket closes with code `1000` and reason `"Client disconnected"` |

## Basic Example

```typescript
const { token } = await fetch("http://localhost:8081/api/session").then((res) =>
  res.json() as Promise<{ token: string }>
);

const params = new URLSearchParams({
  model: "nova-3",
  language: "en",
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
});

const ws = new WebSocket(
  `ws://localhost:8081/api/live-transcription?${params.toString()}`,
  [`access_token.${token}`]
);

ws.onmessage = (event) => {
  console.log("deepgram payload", String(event.data));
};
```

## Advanced Example

```typescript
async function connectForSpanishDiarizedTranscription() {
  const { token } = await fetch("http://localhost:8081/api/session").then(
    (res) => res.json() as Promise<{ token: string }>
  );

  const params = new URLSearchParams({
    model: "nova-3",
    language: "es",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
  });

  const ws = new WebSocket(
    `ws://localhost:8081/api/live-transcription?${params.toString()}`,
    [`access_token.${token}`]
  );

  ws.onopen = () => console.log("ready for audio");
  ws.onclose = (event) => console.log(event.code, event.reason);
  return ws;
}
```

## Related Implementation

- Authentication: `validateWsToken(protocols: string | null): string | null`
- Upstream URL building: `buildDeepgramUrl(queryParams: URLSearchParams): string`
- Cleanup: `function gracefulShutdown(signal: string): void`

All three live in `server.ts`, and together they define the effective transport contract of this starter.

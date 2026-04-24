---
title: "Types And Wire Formats"
description: "Review the only source-declared TypeScript interface and the runtime JSON shapes exposed by the server."
---

This repository does not export TypeScript types from its entry point. The package is started as an application with `bun run server.ts`, not imported as a library. Still, there is one declared interface in source and several stable wire-format shapes you need when integrating with the HTTP and WebSocket endpoints.

## Source-Declared Type

The only declared TypeScript interface in `server.ts` is `WsData`:

```typescript
interface WsData {
  queryParams: URLSearchParams;
  deepgramWs: WebSocket | null;
}
```

### Field Reference

| Field | Type | Meaning |
|------|------|------|
| `queryParams` | `URLSearchParams` | The query string captured during the Bun WebSocket upgrade. These values drive `buildDeepgramUrl(queryParams)`. |
| `deepgramWs` | `WebSocket \| null` | The upstream Deepgram socket associated with the client connection. It is `null` until `websocket.open(ws)` establishes the upstream connection. |

This type matters because `Bun.serve<WsData>({...})` uses it as the per-connection data model for the WebSocket server.

## Runtime JSON Shapes

The following shapes are not declared as interfaces in source, but they are stable outputs of the server handlers and therefore part of the integration contract.

### Session Response

Produced by `handleGetSession()`:

```typescript
type SessionResponse = {
  token: string;
}
```

Example:

```json
{
  "token": "<jwt>"
}
```

Use this when constructing the required `access_token.<jwt>` WebSocket subprotocol.

### Health Response

Produced by `handleHealth()`:

```typescript
type HealthResponse = {
  status: "ok";
}
```

Example:

```json
{
  "status": "ok"
}
```

### Metadata Response

Produced by `handleMetadata()` from the `[meta]` section of `deepgram.toml`:

```typescript
type MetadataResponse = {
  title: string;
  description: string;
  author: string;
  repository: string;
  useCase: string;
  language: string;
  framework: string;
  sdk: string;
  tags: string[];
}
```

Example:

```json
{
  "title": "Bun Live Transcription",
  "description": "Get started using Deepgram's Live Transcription with this Bun demo app",
  "author": "Deepgram DX Team <devrel@deepgram.com> (https://developers.deepgram.com)",
  "repository": "https://github.com/deepgram-starters/bun-live-transcription",
  "useCase": "live-transcription",
  "language": "typescript",
  "framework": "bun",
  "sdk": "N/A",
  "tags": [
    "live-transcription",
    "live-stt",
    "real-time-transcription",
    "real-time-asr",
    "streaming-transcription",
    "live-speech-to-text",
    "typescript",
    "bun"
  ]
}
```

### Error Response

Used by `handleMetadata()` and the route fallback:

```typescript
type ErrorResponse = {
  error: string;
  message: string;
}
```

Examples:

```json
{
  "error": "INTERNAL_SERVER_ERROR",
  "message": "Failed to read metadata from deepgram.toml"
}
```

```json
{
  "error": "Not Found",
  "message": "Endpoint not found"
}
```

## WebSocket Message Shape

The server does not define a TypeScript message interface for WebSocket traffic because it forwards frames transparently:

- client to server: raw audio frames or other messages,
- server to client: raw Deepgram WebSocket payloads.

For client code, the useful working type is:

```typescript
type LiveTranscriptionMessage = string | ArrayBuffer | Uint8Array;
```

That is not a source-declared alias, but it matches how the transport behaves in `message(ws, message)` and in the Deepgram `"message"` event listener.

## Practical Usage Example

You can type the public HTTP interface in your own application even though the starter does not export these definitions:

```typescript
type SessionResponse = { token: string };
type HealthResponse = { status: "ok" };

const session = await fetch("http://localhost:8081/api/session").then(
  (res) => res.json() as Promise<SessionResponse>
);

const health = await fetch("http://localhost:8081/health").then(
  (res) => res.json() as Promise<HealthResponse>
);
```

That is the right integration pattern for this repo: define local consumer types around the network contract, and modify `server.ts` only if the contract itself needs to change.

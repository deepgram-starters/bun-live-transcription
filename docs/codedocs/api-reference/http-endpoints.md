---
title: "HTTP Endpoints"
description: "Reference the Bun server's JSON and health routes, including signatures, response shapes, and implementation details."
---

The repository does not export a reusable TypeScript API. Its public API is the HTTP interface implemented in `server.ts`. This page covers the three GET endpoints exposed by `fetch(req, server)`.

## Module

- Runtime entry point: `server.ts`
- Programmatic import path: none; start the server with `bun run server.ts`

## Route Summary

| Route | Method | Auth | Handler | Source |
|------|------|------|------|------|
| `/api/session` | `GET` | None | `handleGetSession()` | `server.ts` |
| `/api/metadata` | `GET` | None | `handleMetadata()` | `server.ts` |
| `/health` | `GET` | None | `handleHealth()` | `server.ts` |
| `*` | `OPTIONS` | None | `handlePreflight()` | `server.ts` |

## `handleGetSession`

```typescript
function handleGetSession(): Response
```

Issues a signed JWT session token using `SESSION_SECRET` and the constant `JWT_EXPIRY = "1h"`.

### Parameters

This function accepts no parameters directly. It closes over module-level state:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `SESSION_SECRET` | `string` | random 32-byte hex string if unset | Signing secret for JWT issuance and later WebSocket validation. |
| `JWT_EXPIRY` | `string` | `"1h"` | JWT expiry passed to `jsonwebtoken.sign`. |

### Return Type

```typescript
Response
```

The JSON body is:

```json
{
  "token": "<jwt>"
}
```

### Example

```bash
curl -s http://localhost:8081/api/session
```

```typescript
const { token } = await fetch("http://localhost:8081/api/session").then(
  (res) => res.json() as Promise<{ token: string }>
);
```

## `handleMetadata`

```typescript
function handleMetadata(): Response
```

Reads `deepgram.toml`, parses it with `@iarna/toml`, and returns the `[meta]` section.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `deepgram.toml` path | `string` | `join(import.meta.dir, "deepgram.toml")` | Runtime location of the starter metadata file. |

### Return Type

```typescript
Response
```

Success response:

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
  "tags": ["live-transcription", "live-stt", "real-time-transcription"]
}
```

Failure responses:

```json
{
  "error": "INTERNAL_SERVER_ERROR",
  "message": "Missing [meta] section in deepgram.toml"
}
```

```json
{
  "error": "INTERNAL_SERVER_ERROR",
  "message": "Failed to read metadata from deepgram.toml"
}
```

### Example

```bash
curl -s http://localhost:8081/api/metadata
```

```typescript
const metadata = await fetch("http://localhost:8081/api/metadata").then((res) =>
  res.json()
);
console.log(metadata.framework); // "bun"
```

## `handleHealth`

```typescript
function handleHealth(): Response
```

Returns a small liveness payload used by local checks and reverse proxies such as Caddy and Fly.io.

### Parameters

This function accepts no parameters.

### Return Type

```typescript
Response
```

```json
{
  "status": "ok"
}
```

### Example

```bash
curl -s http://localhost:8081/health
```

## `handlePreflight`

```typescript
function handlePreflight(): Response
```

Returns a `204` response with permissive CORS headers for preflight requests.

### Return Type

```typescript
Response
```

Headers come from:

```typescript
function getCorsHeaders(): Record<string, string>
```

which returns:

```typescript
{
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}
```

## Common Patterns

The HTTP endpoints are usually used together:

```typescript
const [health, metadata, session] = await Promise.all([
  fetch("http://localhost:8081/health").then((res) => res.json()),
  fetch("http://localhost:8081/api/metadata").then((res) => res.json()),
  fetch("http://localhost:8081/api/session").then((res) => res.json()),
]);

console.log({ health, metadata, session });
```

That pattern gives a client enough information to confirm the service is alive, inspect the starter metadata, and authenticate a WebSocket session.

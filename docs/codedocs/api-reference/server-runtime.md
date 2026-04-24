---
title: "Server Runtime"
description: "Reference the configuration constants, helper functions, lifecycle hooks, and shutdown behavior inside server.ts."
---

This page documents the internal module API of `server.ts`. These functions are not exported as a reusable package surface, but they are the implementation seams you will edit if you customize the starter.

## Module

- File: `server.ts`
- Entry point: `package.json#main`
- Programmatic exports: none

## Configuration

### `CONFIG`

```typescript
const CONFIG: {
  deepgramApiKey: string;
  deepgramSttUrl: string;
  port: number;
  host: string;
}
```

### Parameters

| Property | Type | Default | Description |
|-----------|------|---------|-------------|
| `deepgramApiKey` | `string` | required | Loaded from `process.env.DEEPGRAM_API_KEY`. Startup fails if missing. |
| `deepgramSttUrl` | `string` | `"wss://api.deepgram.com/v1/listen"` | Upstream Deepgram live transcription endpoint. |
| `port` | `number` | `8081` | Bun HTTP/WebSocket port. |
| `host` | `string` | `"0.0.0.0"` | Bun bind address. |

### Related Constants

```typescript
const SESSION_SECRET: string
const JWT_EXPIRY = "1h"
const activeConnections = new Set<{ close(): void }>()
```

## Helper Functions

### `validateWsToken`

```typescript
function validateWsToken(protocols: string | null): string | null
```

Scans a comma-separated WebSocket subprotocol list for a value beginning with `access_token.`, verifies the JWT, and returns the matched protocol string if valid.

### `getCorsHeaders`

```typescript
function getCorsHeaders(): Record<string, string>
```

Returns:

```typescript
{
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}
```

### `buildDeepgramUrl`

```typescript
function buildDeepgramUrl(queryParams: URLSearchParams): string
```

Builds the upstream Deepgram WebSocket URL from client-provided params plus the server-side API key.

### Route Handlers

```typescript
function handleGetSession(): Response
function handleMetadata(): Response
function handlePreflight(): Response
function handleHealth(): Response
```

These are described in [HTTP Endpoints](/docs/api-reference/http-endpoints), but they remain part of the module-level runtime surface here.

### `gracefulShutdown`

```typescript
function gracefulShutdown(signal: string): void
```

Closes tracked client sockets, stops the Bun server, logs shutdown progress, and exits the process.

## WebSocket Lifecycle Hooks

These hooks are defined inline inside `Bun.serve<WsData>({...})`:

```typescript
websocket: {
  open(ws) { ... },
  message(ws, message) { ... },
  close(ws, code, reason) { ... },
}
```

### `open(ws)`

- Adds the client socket to `activeConnections`
- Builds the Deepgram URL from `ws.data.queryParams`
- Opens `ws.data.deepgramWs`
- Registers upstream `open`, `message`, `error`, and `close` listeners

### `message(ws, message)`

- Checks whether `ws.data.deepgramWs` exists and is open
- Forwards the raw message upstream unchanged

### `close(ws, code, reason)`

- Removes the client socket from `activeConnections`
- Closes the upstream Deepgram socket if it is still open

## Process-Level Hooks

The module registers four process handlers:

```typescript
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  gracefulShutdown("UNHANDLED_REJECTION");
});
```

These hooks are important if you adapt the starter for containerized deployment or platform-managed restarts.

## Example Customization

The most common module-level customization is to support an additional Deepgram parameter:

```typescript
function buildDeepgramUrl(queryParams: URLSearchParams): string {
  const deepgramUrl = new URL(CONFIG.deepgramSttUrl);
  deepgramUrl.searchParams.set("token", CONFIG.deepgramApiKey);

  // existing defaults omitted for brevity

  const interimResults = queryParams.get("interim_results");
  if (interimResults !== null) {
    deepgramUrl.searchParams.set("interim_results", interimResults);
  }

  return deepgramUrl.toString();
}
```

Another common change is to tighten CORS:

```typescript
function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "https://your-app.example",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
```

Both modifications stay localized because the runtime helpers are already separated by concern.

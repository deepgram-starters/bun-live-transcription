/**
 * Bun Live Transcription Starter - Backend Server
 *
 * Simple WebSocket proxy to Deepgram's Live Transcription API using Bun's
 * built-in HTTP and WebSocket server. Forwards all messages (JSON and binary)
 * bidirectionally between client and Deepgram.
 *
 * Key Features:
 * - WebSocket endpoint: /api/live-transcription (via Bun.serve websocket handler)
 * - Bidirectional audio/transcription streaming
 * - JWT session auth for API protection
 * - Native TypeScript support (no build step)
 * - No external web framework needed
 *
 * Routes:
 *   GET  /api/session              - Issue JWT session token
 *   GET  /api/metadata             - Project metadata from deepgram.toml
 *   WS   /api/live-transcription   - WebSocket proxy to Deepgram STT (auth required)
 */

import jwt from "jsonwebtoken";
import TOML from "@iarna/toml";
import { readFileSync } from "fs";
import { join } from "path";
import crypto from "crypto";
import { DeepgramClient } from "@deepgram/sdk";

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Validate required environment variables before starting
 */
if (!process.env.DEEPGRAM_API_KEY) {
  console.error("\nERROR: Deepgram API key not found!\n");
  console.error("Please set your API key using one of these methods:\n");
  console.error("1. Create a .env file (recommended):");
  console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
  console.error("2. Environment variable:");
  console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
  console.error("Get your API key at: https://console.deepgram.com\n");
  process.exit(1);
}

/**
 * Server configuration - These can be overridden via environment variables
 */
const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
  port: parseInt(process.env.PORT || "8081"),
  host: process.env.HOST || "0.0.0.0",
};

const RESERVED_CLOSE_CODES = [1004, 1005, 1006, 1015];

function getSafeCloseCode(code: number | undefined): number {
  return typeof code === "number" && code >= 1000 && code <= 4999 && !RESERVED_CLOSE_CODES.includes(code)
    ? code
    : 1000;
}

// A single SDK client is reused across connections; auth is resolved from the
// API key here, so the browser never sees it. The SDK manages the Deepgram
// WebSocket, auth, and message (de)serialization.
//
// DEEPGRAM_BASE_URL (e.g. a staging host) overrides the default production
// endpoint. The listen websocket uses `environment.production`, so we set that
// alongside the REST `base`.
const baseUrl = process.env.DEEPGRAM_BASE_URL;
const deepgram = new DeepgramClient({
  apiKey: CONFIG.deepgramApiKey,
  ...(baseUrl
    ? {
        environment: {
          base: baseUrl
            .replace(/^wss:\/\//, "https://")
            .replace(/^ws:\/\//, "http://"),
          production: baseUrl,
          agent: baseUrl,
          agentRest: baseUrl
            .replace(/^wss:\/\//, "https://")
            .replace(/^ws:\/\//, "http://"),
        },
      }
    : {}),
});
if (baseUrl) {
  console.log(`Using custom Deepgram base URL: ${baseUrl}`);
}

// ============================================================================
// SESSION AUTH - JWT tokens for production security
// ============================================================================

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const JWT_EXPIRY = "1h";

/**
 * Validates JWT from WebSocket subprotocol: access_token.<jwt>
 * Returns the full subprotocol string if valid, null if invalid.
 */
function validateWsToken(protocols: string | null): string | null {
  if (!protocols) return null;
  const list = protocols.split(",").map((s) => s.trim());
  const tokenProto = list.find((p) => p.startsWith("access_token."));
  if (!tokenProto) return null;
  const token = tokenProto.slice("access_token.".length);
  try {
    jwt.verify(token, SESSION_SECRET);
    return tokenProto;
  } catch {
    return null;
  }
}

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses.
 * Bun uses the CORS pattern (backend=8081, frontend=8080).
 */
function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build the Deepgram live-transcription options object from client query
 * parameters. These are passed straight to
 * `deepgram.listen.v1.createConnection(...)`; the SDK turns them into the
 * /v1/listen websocket query string and handles auth.
 */
function buildDeepgramOptions(
  queryParams: URLSearchParams
): Record<string, string> {
  // Required parameters with defaults
  const options: Record<string, string> = {
    model: queryParams.get("model") || "nova-3",
    language: queryParams.get("language") || "en",
    encoding: queryParams.get("encoding") || "linear16",
    sample_rate: queryParams.get("sample_rate") || "16000",
    channels: queryParams.get("channels") || "1",
    smart_format: queryParams.get("smart_format") || "true",
  };

  // Optional parameters - only set if explicitly provided by client
  const punctuate = queryParams.get("punctuate");
  const diarize = queryParams.get("diarize");
  const fillerWords = queryParams.get("filler_words");

  if (punctuate !== null) options.punctuate = punctuate;
  if (diarize !== null) options.diarize = diarize;
  if (fillerWords !== null) options.filler_words = fillerWords;

  return options;
}

/**
 * Route a control message (KeepAlive / Finalize / CloseStream) from the browser
 * to the matching SDK method on the Deepgram connection.
 */
function dispatchControl(dgConn: any, msg: any): void {
  try {
    switch (msg?.type) {
      case "KeepAlive":
        dgConn.sendKeepAlive({ type: "KeepAlive" });
        break;
      case "Finalize":
        dgConn.sendFinalize({ type: "Finalize" });
        break;
      case "CloseStream":
        dgConn.sendCloseStream({ type: "CloseStream" });
        break;
      default:
        console.warn("Ignoring unknown client control message type:", msg?.type);
    }
  } catch (error) {
    console.error("Failed to forward control message to Deepgram:", error);
  }
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/session - Issues a signed JWT session token.
 */
function handleGetSession(): Response {
  const token = jwt.sign(
    { iat: Math.floor(Date.now() / 1000) },
    SESSION_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  return Response.json({ token }, { headers: getCorsHeaders() });
}

/**
 * GET /api/metadata - Returns metadata about this starter application
 */
function handleMetadata(): Response {
  try {
    const tomlPath = join(import.meta.dir, "deepgram.toml");
    const tomlContent = readFileSync(tomlPath, "utf-8");
    const config = TOML.parse(tomlContent);

    if (!config.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(config.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

/**
 * GET /health
 * Simple health check endpoint.
 * @returns JSON response with { status: "ok" }
 */
function handleHealth(): Response {
  return Response.json({ status: "ok" }, { headers: getCorsHeaders() });
}

// ============================================================================
// WEBSOCKET CONNECTION TRACKING
// ============================================================================

/** Track all active client WebSocket connections for graceful shutdown */
const activeConnections = new Set<{ close(): void }>();

// ============================================================================
// TYPES - Bun WebSocket data stored per-connection
// ============================================================================

/**
 * Data attached to each Bun WebSocket connection via ws.data.
 * Bun stores arbitrary data per-connection through the upgrade() call.
 */
interface WsData {
  queryParams: URLSearchParams;
  // The SDK live-transcription connection for this client (created on open).
  dgConn: any;
  // Whether the Deepgram socket is open and ready to receive media/control.
  dgReady: boolean;
  // Browser messages received before Deepgram is ready, flushed on open.
  pending: Array<{ binary: true; data: any } | { binary: false; msg: any }>;
}

// ============================================================================
// SERVER - Bun.serve with integrated WebSocket handler
// ============================================================================

const server = Bun.serve<WsData>({
  port: CONFIG.port,
  hostname: CONFIG.host,

  /**
   * HTTP request handler - routes HTTP requests and upgrades WebSocket connections.
   * Bun combines fetch() and websocket handler in a single Bun.serve() call.
   */
  fetch(req, server) {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return handlePreflight();
    }

    // --- HTTP Routes ---

    if (req.method === "GET" && url.pathname === "/api/session") {
      return handleGetSession();
    }

    if (req.method === "GET" && url.pathname === "/api/metadata") {
      return handleMetadata();
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return handleHealth();
    }

    // --- WebSocket Upgrade ---

    if (url.pathname === "/api/live-transcription") {
      // Validate JWT from access_token.<jwt> subprotocol
      const protocols = req.headers.get("sec-websocket-protocol");
      const validProto = validateWsToken(protocols);

      if (!validProto) {
        console.log("WebSocket auth failed: invalid or missing token");
        return new Response("Unauthorized", {
          status: 401,
          headers: getCorsHeaders(),
        });
      }

      // Upgrade the connection to WebSocket
      const upgraded = server.upgrade(req, {
        data: {
          queryParams: url.searchParams,
          dgConn: null,
          dgReady: false,
          pending: [],
        },
        headers: {
          "Sec-WebSocket-Protocol": validProto,
        },
      });

      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Return undefined - Bun handles the upgrade response
      return undefined;
    }

    // 404 for all other routes
    return Response.json(
      { error: "Not Found", message: "Endpoint not found" },
      { status: 404, headers: getCorsHeaders() }
    );
  },

  /**
   * WebSocket handler - Bun's built-in WebSocket server.
   * Unlike Node's `ws` library, Bun uses an object with open/message/close handlers
   * attached to the server, not per-connection event emitters.
   */
  websocket: {
    /**
     * Called when a client WebSocket connection is established.
     * Connects to Deepgram and sets up bidirectional message forwarding.
     */
    async open(ws) {
      console.log("Client connected to /api/live-transcription");
      activeConnections.add(ws);

      // Build Deepgram options from client query parameters
      const params = ws.data.queryParams;
      const options = buildDeepgramOptions(params);

      console.log(
        `Connecting to Deepgram STT: model=${options.model}, language=${options.language}, encoding=${options.encoding}, sample_rate=${options.sample_rate}, channels=${options.channels}`
      );

      // Create the Deepgram STT connection object (not yet connected). The SDK
      // manages the websocket and auth from the API key.
      let dgConn: any;
      try {
        dgConn = await deepgram.listen.v1.createConnection(options as any);
      } catch (error) {
        console.error("Failed to create Deepgram connection:", error);
        try {
          ws.close(1011, "Failed to reach Deepgram");
        } catch {
          // Client may already be closed
        }
        activeConnections.delete(ws);
        return;
      }
      ws.data.dgConn = dgConn;

      let deepgramMessageCount = 0;

      // Deepgram -> browser. Listen messages are JSON (Results / Metadata /...).
      // The SDK delivers parsed JSON objects; forward as-is if it ever hands
      // back a raw string to avoid double-encoding.
      dgConn.on("message", (data: any) => {
        deepgramMessageCount++;
        if (deepgramMessageCount % 10 === 0) {
          console.log(
            `<- Deepgram message #${deepgramMessageCount} (type: ${data && data.type})`
          );
        }
        try {
          ws.send(typeof data === "string" ? data : JSON.stringify(data));
        } catch {
          // Client may have disconnected
        }
      });

      dgConn.on("open", () => {
        console.log("Connected to Deepgram STT API");
      });

      dgConn.on("error", (error: any) => {
        console.error("Deepgram socket error:", error);
        try {
          ws.close(1011, "Deepgram connection error");
        } catch {
          // Client may already be closed
        }
      });

      dgConn.on("close", (event: { code?: number; reason?: string }) => {
        console.log(`Deepgram connection closed: ${event?.code ?? 1000} ${event?.reason ?? ""}`);
        try {
          ws.close(getSafeCloseCode(event?.code), event?.reason || undefined);
        } catch {
          // Client may already be closed
        }
      });

      // Open the Deepgram connection and flush anything buffered before open.
      try {
        dgConn.connect();
        await dgConn.waitForOpen();
        ws.data.dgReady = true;
        for (const item of ws.data.pending) {
          if (item.binary) {
            try {
              dgConn.sendMedia(item.data);
            } catch (error) {
              console.error("Failed to send buffered audio to Deepgram:", error);
            }
          } else {
            dispatchControl(dgConn, item.msg);
          }
        }
        ws.data.pending = [];
      } catch (error) {
        console.error("Deepgram connection did not open:", error);
        try {
          ws.close(1011, "Deepgram connection failed to open");
        } catch {
          // Client may already be closed
        }
      }
    },

    /**
     * Called when the client sends a message. Binary frames are PCM audio;
     * text frames are JSON control messages (KeepAlive / Finalize / CloseStream).
     */
    message(ws, message) {
      const dgConn = ws.data.dgConn;

      // Binary audio frame.
      if (typeof message !== "string") {
        if (!ws.data.dgReady || !dgConn) {
          ws.data.pending.push({ binary: true, data: message });
          return;
        }
        try {
          dgConn.sendMedia(message);
        } catch (error) {
          console.error("Failed to send audio to Deepgram:", error);
        }
        return;
      }

      // Text frame — a JSON control message.
      let msg: any;
      try {
        msg = JSON.parse(message);
      } catch {
        console.warn("Ignoring non-JSON text message from client");
        return;
      }
      if (!ws.data.dgReady || !dgConn) {
        ws.data.pending.push({ binary: false, msg });
        return;
      }
      dispatchControl(dgConn, msg);
    },

    /**
     * Called when the client WebSocket connection closes.
     * Cleans up the Deepgram connection.
     */
    close(ws, code, reason) {
      console.log(`Client disconnected: ${code} ${reason}`);
      activeConnections.delete(ws);

      try {
        ws.data.dgConn?.close();
      } catch {
        // already closed
      }
    },
  },
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Graceful shutdown handler - closes all active WebSocket connections
 * and stops the server from accepting new connections.
 */
function gracefulShutdown(signal: string) {
  console.log(`\n${signal} signal received: starting graceful shutdown...`);

  // Close all active WebSocket connections
  console.log(
    `Closing ${activeConnections.size} active WebSocket connection(s)...`
  );
  activeConnections.forEach((ws) => {
    try {
      ws.close();
    } catch (error) {
      console.error("Error closing WebSocket:", error);
    }
  });

  // Stop the server
  server.stop();
  console.log("Server stopped");
  console.log("Shutdown complete");
  process.exit(0);
}

// Handle shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  gracefulShutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  gracefulShutdown("UNHANDLED_REJECTION");
});

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`Backend API Server running at http://localhost:${CONFIG.port}`);
console.log("");
console.log("GET  /api/session");
console.log("WS   /api/live-transcription (auth required)");
console.log("GET  /api/metadata");
console.log("GET  /health");
console.log("=".repeat(70) + "\n");

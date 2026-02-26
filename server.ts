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
  deepgramSttUrl: "wss://api.deepgram.com/v1/listen",
  port: parseInt(process.env.PORT || "8081"),
  host: process.env.HOST || "0.0.0.0",
};

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
 * Build Deepgram WebSocket URL with query parameters from client request.
 * Passes through transcription options to Deepgram's /v1/listen endpoint.
 *
 * Includes the API key as a query parameter since Bun's native WebSocket
 * does not support custom headers in the constructor.
 */
function buildDeepgramUrl(queryParams: URLSearchParams): string {
  const deepgramUrl = new URL(CONFIG.deepgramSttUrl);

  // Authentication via query parameter (Bun WebSocket lacks custom headers support)
  deepgramUrl.searchParams.set("token", CONFIG.deepgramApiKey);

  // Required parameters with defaults
  deepgramUrl.searchParams.set("model", queryParams.get("model") || "nova-3");
  deepgramUrl.searchParams.set("language", queryParams.get("language") || "en");
  deepgramUrl.searchParams.set("encoding", queryParams.get("encoding") || "linear16");
  deepgramUrl.searchParams.set("sample_rate", queryParams.get("sample_rate") || "16000");
  deepgramUrl.searchParams.set("channels", queryParams.get("channels") || "1");
  deepgramUrl.searchParams.set("smart_format", queryParams.get("smart_format") || "true");

  // Optional parameters - only set if explicitly provided by client
  const punctuate = queryParams.get("punctuate");
  const diarize = queryParams.get("diarize");
  const fillerWords = queryParams.get("filler_words");

  if (punctuate !== null) deepgramUrl.searchParams.set("punctuate", punctuate);
  if (diarize !== null) deepgramUrl.searchParams.set("diarize", diarize);
  if (fillerWords !== null) deepgramUrl.searchParams.set("filler_words", fillerWords);

  return deepgramUrl.toString();
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
  deepgramWs: WebSocket | null;
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
          deepgramWs: null,
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
    open(ws) {
      console.log("Client connected to /api/live-transcription");
      activeConnections.add(ws);

      // Build Deepgram URL from client query parameters
      const params = ws.data.queryParams;
      const deepgramUrl = buildDeepgramUrl(params);

      const model = params.get("model") || "nova-3";
      const language = params.get("language") || "en";
      const encoding = params.get("encoding") || "linear16";
      const sampleRate = params.get("sample_rate") || "16000";
      const channels = params.get("channels") || "1";

      console.log(
        `Connecting to Deepgram STT: model=${model}, language=${language}, encoding=${encoding}, sample_rate=${sampleRate}, channels=${channels}`
      );

      // Connect to Deepgram using native WebSocket
      // Bun's global WebSocket does not support custom headers, so we authenticate
      // via the `token` query parameter included in buildDeepgramUrl()
      const deepgramWs = new WebSocket(deepgramUrl);
      ws.data.deepgramWs = deepgramWs;

      let deepgramMessageCount = 0;

      // Handle Deepgram connection open
      deepgramWs.addEventListener("open", () => {
        console.log("Connected to Deepgram STT API");
      });

      // Forward Deepgram messages to client (transcription results)
      deepgramWs.addEventListener("message", (event) => {
        deepgramMessageCount++;
        if (deepgramMessageCount % 10 === 0) {
          console.log(
            `<- Deepgram message #${deepgramMessageCount} (size: ${typeof event.data === "string" ? event.data.length : "binary"})`
          );
        }
        try {
          ws.send(event.data as string | Buffer);
        } catch {
          // Client may have disconnected
        }
      });

      // Handle Deepgram errors
      deepgramWs.addEventListener("error", (event) => {
        console.error("Deepgram WebSocket error:", event);
        try {
          ws.close(1011, "Deepgram connection error");
        } catch {
          // Client may already be closed
        }
      });

      // Handle Deepgram connection close
      deepgramWs.addEventListener("close", (event) => {
        console.log(
          `Deepgram connection closed: ${event.code} ${event.reason}`
        );
        try {
          ws.close(event.code, event.reason);
        } catch {
          // Client may already be closed
        }
      });
    },

    /**
     * Called when the client sends a message (audio data or control messages).
     * Forwards to Deepgram transparently without modification.
     */
    message(ws, message) {
      const deepgramWs = ws.data.deepgramWs;
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(message);
      }
    },

    /**
     * Called when the client WebSocket connection closes.
     * Cleans up the Deepgram connection.
     */
    close(ws, code, reason) {
      console.log(`Client disconnected: ${code} ${reason}`);
      activeConnections.delete(ws);

      const deepgramWs = ws.data.deepgramWs;
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close(1000, "Client disconnected");
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

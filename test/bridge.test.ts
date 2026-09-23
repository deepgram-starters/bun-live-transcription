import { expect, test } from "bun:test";
import net from "node:net";

const appRoot = new URL("..", import.meta.url).pathname;
const STARTUP_TIMEOUT = 10_000;
const TEST_TIMEOUT = 45_000;

async function getAvailablePort(): Promise<number> {
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}

async function waitFor<T>(description: string, check: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + STARTUP_TIMEOUT;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`${description} within ${STARTUP_TIMEOUT}ms`);
}

async function startApp(upstreamUrl: string) {
  const port = await getAvailablePort();
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: upstreamUrl, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor("app to become healthy", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
  return { app, port };
}

async function stopApp(app: ReturnType<typeof Bun.spawn>): Promise<void> {
  app.kill();
  await app.exited;
}

test("caps frames buffered before the transcription socket opens", async () => {
  const upstream = net.createServer(() => {});
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const { app, port } = await startApp(`ws://127.0.0.1:${upstreamPort}`);

  try {
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };
    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-transcription`, [`access_token.${session.token}`]);
      const timeout = setTimeout(() => reject(new Error("pending queue was not capped")), STARTUP_TIMEOUT);
      socket.addEventListener("open", () => {
        for (let index = 0; index <= 128; index += 1) socket.send(JSON.stringify({ type: "KeepAlive" }));
      });
      socket.addEventListener("close", (event) => { clearTimeout(timeout); resolve(event.code); });
      socket.addEventListener("error", () => reject(new Error("browser socket failed")));
    });
    expect(closeCode).toBe(1009);
  } finally {
    await stopApp(app);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, { timeout: TEST_TIMEOUT });

test("forwards interim-results defaults and overrides to Deepgram", async () => {
  const upstreamUrls: URL[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      upstreamUrls.push(new URL(request.url));
      if (server.upgrade(request)) return;
      return new Response("Expected WebSocket upgrade", { status: 400 });
    },
    websocket: {
      open() {},
    },
  });
  const { app, port } = await startApp(`ws://127.0.0.1:${upstream.port}`);

  try {
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };

    const connect = async (query: string) => {
      const initialRequestCount = upstreamUrls.length;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-transcription${query}`, [`access_token.${session.token}`]);
      try {
        return await waitFor("Deepgram connection to open", () => upstreamUrls.slice(initialRequestCount)[0]);
      } finally {
        socket.close();
      }
    };

    expect((await connect("")).searchParams.get("interim_results")).toBe("false");
    expect((await connect("?interim_results=false")).searchParams.get("interim_results")).toBe("false");
    expect((await connect("?interim_results=true")).searchParams.get("interim_results")).toBe("true");
  } finally {
    await stopApp(app);
    upstream.stop(true);
  }
}, { timeout: TEST_TIMEOUT });

test("reports a rejected Deepgram connection before closing the browser socket", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("Unauthorized", { status: 401 });
    },
  });
  const { app, port } = await startApp(`ws://127.0.0.1:${upstream.port}`);

  try {
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };
    const { errorFrame, closeCode } = await new Promise<{ errorFrame: unknown; closeCode: number }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-transcription`, [`access_token.${session.token}`]);
      const timeout = setTimeout(() => reject(new Error("connection failure was not reported")), STARTUP_TIMEOUT);
      let errorFrame: unknown;
      socket.addEventListener("message", (event) => {
        try {
          errorFrame = JSON.parse(event.data);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout);
        if (errorFrame === undefined) {
          reject(new Error("connection failure closed before reporting an error frame"));
          return;
        }
        resolve({ errorFrame, closeCode: event.code });
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("browser socket failed"));
      });
    });
    expect(closeCode).toBe(1011);
    expect(errorFrame).toEqual({
      type: "Error",
      error: {
        type: "connection",
        code: "CONNECTION_FAILED",
        message: "Deepgram rejected the connection",
      },
    });
  } finally {
    await stopApp(app);
    upstream.stop(true);
  }
}, { timeout: TEST_TIMEOUT });

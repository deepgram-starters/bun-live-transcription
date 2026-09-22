import { expect, test } from "bun:test";
import net from "node:net";

const appRoot = new URL("..", import.meta.url).pathname;

test("caps frames buffered before the transcription socket opens", async () => {
  const upstream = net.createServer(() => {});
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const port = 18304;
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };
    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-transcription`, [`access_token.${session.token}`]);
      const timeout = setTimeout(() => reject(new Error("pending queue was not capped")), 5_000);
      socket.addEventListener("open", () => {
        for (let index = 0; index <= 128; index += 1) socket.send(JSON.stringify({ type: "KeepAlive" }));
      });
      socket.addEventListener("close", (event) => { clearTimeout(timeout); resolve(event.code); });
      socket.addEventListener("error", () => reject(new Error("browser socket failed")));
    });
    expect(closeCode).toBe(1009);
  } finally {
    app.kill();
    await app.exited;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("forwards interim-results defaults to Deepgram", async () => {
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
  const upstreamPort = upstream.port;
  const port = 18305;
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };

    const connect = async (query: string, requestCount: number) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-transcription${query}`, [`access_token.${session.token}`]);
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (upstreamUrls.length >= requestCount) return upstreamUrls[requestCount - 1]!;
          await Bun.sleep(50);
        }
        throw new Error("Deepgram connection was not opened");
      } finally {
        socket.close();
      }
    };

    expect((await connect("", 1)).searchParams.get("interim_results")).toBe("false");
    expect((await connect("?interim_results=false", 2)).searchParams.get("interim_results")).toBe("false");
  } finally {
    app.kill();
    await app.exited;
    upstream.stop(true);
  }
});

test("reports a rejected Deepgram connection before closing the browser socket", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response("Unauthorized", { status: 401 });
    },
  });
  const port = 18306;
  const app = Bun.spawn(["bun", "server.ts"], {
    cwd: appRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: "test-key", DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstream.port}`, PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await Bun.sleep(50);
    }
    const session = await (await fetch(`http://127.0.0.1:${port}/api/session`)).json() as { token: string };
    const errorFrame = await new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live-transcription`, [`access_token.${session.token}`]);
      const timeout = setTimeout(() => reject(new Error("connection failure was not reported")), 5_000);
      socket.addEventListener("message", (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data));
      });
      socket.addEventListener("error", () => reject(new Error("browser socket failed")));
    });
    expect(errorFrame).toEqual({
      type: "Error",
      code: "CONNECTION_FAILED",
      description: "Deepgram rejected the connection",
    });
  } finally {
    app.kill();
    await app.exited;
    upstream.stop(true);
  }
});

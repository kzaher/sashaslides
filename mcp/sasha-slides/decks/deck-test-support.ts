/**
 * Test support for the deck server's tests (never imported by production code): a manual clock
 * with timers, a loopback HTTP server composed like `http-server.ts` (the account portal, then the
 * deck router, then 404; the deck upgrade on the same port), a minimal HTTP client that sends
 * exactly the headers a test names (Origin and Cookie included), a `ws` client that records frames
 * and close codes, and the account portal's session cookie minted the way the portal mints it.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, request as outgoingRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { ServerMessage } from "../engine/src/contracts/collaboration.ts";
import type { AccountPortal } from "../http/account-portal";
import type { DeckServer } from "./deck-stack";
import type { DeckTimers } from "./deck-registry";

export type ManualTimers = DeckTimers &
  Readonly<{
    now: () => number;
    /** Moves the clock, running every timer that falls due, in order (timers they schedule included). */
    advance: (milliseconds: number) => void;
    /** How many timers are waiting. */
    pending: () => number;
  }>;

export function manualTimers(start: number): ManualTimers {
  let time = start;
  let nextId = 0;
  const waiting = new Map<number, Readonly<{ at: number; run: () => void }>>();
  return {
    now: () => time,
    schedule: ({ delayMilliseconds, run }) => {
      nextId += 1;
      const id = nextId;
      waiting.set(id, { at: time + delayMilliseconds, run });
      return { [Symbol.dispose]: () => void waiting.delete(id) };
    },
    advance: (milliseconds) => {
      const target = time + milliseconds;
      for (;;) {
        const due = [...waiting.entries()].filter(([, timer]) => timer.at <= target).sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        waiting.delete(id);
        time = Math.max(time, timer.at);
        timer.run();
      }
      time = target;
    },
    pending: () => waiting.size,
  };
}

/** Lets promise chains started by timers finish (each flush is a few awaits deep). */
export async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export type LoopbackServer = AsyncDisposable & Readonly<{ baseUrl: string; port: number; server: Server }>;

/** The connector's composition for decks, on 127.0.0.1 and a free port. */
export async function startLoopbackServer(options: Readonly<{ portal: AccountPortal | null; decks: DeckServer }>): Promise<LoopbackServer> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    void (async () => {
      if (options.portal !== null && (await options.portal.handleRequest({ request, response, url }))) return;
      if (await options.decks.router.handleRequest({ request, response, url })) return;
      response.writeHead(404).end();
    })();
  });
  server.on("upgrade", (request, socket, head: Buffer) => {
    void options.decks.sockets.handleUpgrade({ request, socket, head }).then((handled) => {
      if (!handled) socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // `listen` on a TCP port always reports an AddressInfo (not a pipe name).
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    port,
    server,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type Answer = Readonly<{ status: number; headers: IncomingHttpHeaders; body: Buffer; value: () => unknown }>;

/** One request with exactly these headers; the body is sent as is. */
export function send(
  options: Readonly<{ baseUrl: string; method: string; path: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array | string }>,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path, options.baseUrl);
    const outgoing = outgoingRequest(url, { method: options.method, headers: { ...(options.headers ?? {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, value: () => JSON.parse(body.toString("utf-8")) });
      });
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

/** The full `Set-Cookie` line for `name`, attributes included. */
export function setCookieLine(headers: IncomingHttpHeaders, name: string): string | null {
  return (headers["set-cookie"] ?? []).find((cookie) => cookie.startsWith(`${name}=`)) ?? null;
}

/** The account portal's session cookie for `accountId`, minted exactly as account-portal.ts mints it. */
export function accountSessionCookie(options: Readonly<{ secret: string; accountId: string; now: number }>): string {
  const payload = Buffer.from(JSON.stringify({ accountId: options.accountId, exp: options.now + 15 * 60 * 1000, csrf: randomBytes(16).toString("base64url") }), "utf-8").toString("base64url");
  const mac = createHmac("sha256", options.secret).update(payload).digest("base64url");
  return `sasha_account=${payload}.${mac}`;
}

export type RecordingSocket = Readonly<{
  socket: WebSocket;
  protocol: () => string;
  messages: () => readonly ServerMessage[];
  binaryFrames: () => readonly Buffer[];
  closeCode: () => number | null;
  /** Resolves once `condition` holds, polling every 10 ms for at most `timeoutMilliseconds`. */
  until: (condition: () => boolean, timeoutMilliseconds?: number) => Promise<void>;
  opened: Promise<void>;
  closed: Promise<number>;
}>;

export function connectSocket(
  options: Readonly<{ port: number; path: string; origin: string; cookie?: string; protocols?: readonly string[] }>,
): RecordingSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${String(options.port)}${options.path}`, [...(options.protocols ?? ["sasha-deck.1"])], {
    origin: options.origin,
    headers: options.cookie === undefined ? {} : { cookie: options.cookie },
  });
  const messages: ServerMessage[] = [];
  const binaryFrames: Buffer[] = [];
  let closeCode: number | null = null;
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    // The server's text frames are `ServerMessage` JSON (collaboration.ts).
    if (!isBinary) messages.push(JSON.parse(data.toString("utf-8")) as ServerMessage);
    else binaryFrames.push(data);
  });
  socket.on("error", () => undefined);
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) => reject(new Error(`handshake refused with ${String(response.statusCode)}`)));
    socket.once("error", reject);
  });
  const closed = new Promise<number>((resolve) =>
    socket.once("close", (code: number) => {
      closeCode = code;
      resolve(code);
    }),
  );
  opened.catch(() => undefined);
  return {
    socket,
    protocol: () => socket.protocol,
    messages: () => messages,
    binaryFrames: () => binaryFrames,
    closeCode: () => closeCode,
    until: async (condition, timeoutMilliseconds = 2_000) => {
      const deadline = Date.now() + timeoutMilliseconds;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error("the condition did not hold in time");
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
    opened,
    closed,
  };
}

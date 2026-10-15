/**
 * The deck's WebSocket (SPEC.md 21.3, 21.4): `GET /deck-api/sync/<id>?discussionAfter=<n>` upgraded
 * with `ws` on the connector's own port, then handed to the deck's room as a `RoomConnectionPort`.
 *
 * Key decisions:
 *
 *  - REFUSED BEFORE THE HANDSHAKE ONLY FOR A FOREIGN ORIGIN (cross-site WebSocket hijacking: a page
 *    elsewhere could otherwise ride the visitor's cookie) or a malformed address. Everything else --
 *    signed out, not a member, too many connections, an old protocol -- completes the handshake and
 *    closes with its application code (collaboration.ts `CLOSE_CODE_BY_REASON`), because a browser
 *    shows a script no reason for a failed handshake, and the reason decides whether it retries.
 *  - THE SUBPROTOCOL. `sasha-deck.1` is echoed; the bearer travels as a second offered protocol
 *    `sasha-bearer.<token>` (a browser socket cannot send an Authorization header) and is NEVER
 *    echoed. A client offering only another `sasha-deck.<n>` is closed `protocolVersionUnsupported`.
 *  - HEARTBEATS. Every 15 seconds: a `heartbeat` text frame and a WebSocket ping. A connection that
 *    did not answer the previous ping is terminated, and one whose session expired since the upgrade
 *    is closed `unauthenticated`, so the client refreshes its session and reconnects.
 *  - FRAMES THAT ARRIVE BEFORE THE ROOM IS LOADED are queued and delivered in order once it is; more
 *    than one burst (`COLLABORATION_LIMITS.messageBurst`) closes the socket `rateLimited`.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import {
  BEARER_SUBPROTOCOL_PREFIX,
  CLOSE_CODE_BY_REASON,
  COLLABORATION_LIMITS,
  DECK_SYNC_PATH_PREFIX,
  DECK_SYNC_SUBPROTOCOL,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  type CloseReason,
  type ServerMessage,
} from "../engine/src/contracts/collaboration.ts";
import { parseDeckId } from "../engine/src/contracts/ids.ts";
import type { RoomConnection, RoomFrame } from "../engine/src/server/index.ts";
import type { DeckAccounts } from "./deck-accounts";
import type { DeckManager } from "./deck-manager";
import type { DeckTimers } from "./deck-registry";
import { publicOrigin } from "./deck-router";
import type { DeckSession, DeckSessionCookies, EmbedSessions } from "./deck-sessions";

export type DeckSockets = Readonly<{
  /** For `server.on("upgrade")`: answers a deck sync address and resolves true; false for any other. */
  handleUpgrade(options: Readonly<{ request: IncomingMessage; socket: Duplex; head: Buffer }>): Promise<boolean>;
  /** Every open socket, for shutdown accounting. */
  openCount(): number;
  /** Stops the heartbeat timers and the `ws` server (sockets are closed by the rooms). */
  close(): void;
}>;

export function createDeckSockets(
  options: Readonly<{
    publicUrl: string;
    manager: DeckManager;
    accounts: DeckAccounts;
    cookies: DeckSessionCookies;
    embeds: EmbedSessions;
    timers: DeckTimers;
    now: () => number;
    warn: (message: string) => void;
  }>,
): DeckSockets {
  const { manager, accounts, cookies, embeds, timers, now, warn } = options;
  const origin = publicOrigin(options.publicUrl);
  const server = new WebSocketServer({
    noServer: true,
    // A little above the protocol's limit: the room refuses oversized frames with a reason
    // (`updateTooLarge`); `ws` itself closes only what is far beyond it.
    maxPayload: COLLABORATION_LIMITS.maximumMessageBytes + 64 * 1024,
    handleProtocols: (protocols) => {
      if (protocols.has(DECK_SYNC_SUBPROTOCOL)) return DECK_SYNC_SUBPROTOCOL;
      const other = [...protocols].find((protocol) => protocol.startsWith("sasha-deck."));
      return other ?? false;
    },
  });
  const open = new Set<WebSocket>();
  let heartbeat: Disposable | null = null;

  const scheduleHeartbeat = (): void => {
    if (heartbeat !== null || open.size === 0) return;
    heartbeat = timers.schedule({
      delayMilliseconds: HEARTBEAT_INTERVAL_MILLISECONDS,
      run: () => {
        heartbeat = null;
        for (const socket of open) socketHeartbeat.get(socket)?.();
        scheduleHeartbeat();
      },
    });
  };
  const socketHeartbeat = new WeakMap<WebSocket, () => void>();

  const authenticate = async (request: IncomingMessage, offered: readonly string[]): Promise<DeckSession | null> => {
    const bearerProtocol = offered.find((protocol) => protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX));
    const session =
      bearerProtocol === undefined ? cookies.read(request) : embeds.verify({ bearerToken: bearerProtocol.slice(BEARER_SUBPROTOCOL_PREFIX.length) });
    if (session === null) return null;
    return (await accounts.exists({ accountId: session.accountId })) ? session : null;
  };

  const attach = async (socket: WebSocket, request: IncomingMessage, url: URL): Promise<void> => {
    const offered = offeredProtocols(request);
    const closeWith = (reason: CloseReason): void => socket.close(CLOSE_CODE_BY_REASON[reason], reason);
    if (socket.protocol !== DECK_SYNC_SUBPROTOCOL) return closeWith("protocolVersionUnsupported");
    const deckId = parseDeckId(url.pathname.slice(DECK_SYNC_PATH_PREFIX.length));
    if (deckId === null) return closeWith("deckNotFound");
    const queued: RoomFrame[] = [];
    let connection: RoomConnection | null = null;
    let closed = false;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const frame: RoomFrame = isBinary ? { kind: "binary", bytes: bytesOf(data) } : { kind: "text", text: bytesOf(data).toString("utf-8") };
      if (connection !== null) {
        connection.receive(frame);
        return;
      }
      // Before the room has the connection, nothing rate-limits it: past one burst the sender is
      // flooding, and the queue would only move that into the server's memory.
      if (queued.length >= COLLABORATION_LIMITS.messageBurst) {
        closeWith("rateLimited");
        return;
      }
      queued.push(frame);
    });
    socket.on("close", () => {
      closed = true;
      open.delete(socket);
      connection?.disconnect();
    });
    socket.on("error", (cause) => warn(`deck socket: ${cause.message}`));
    open.add(socket);
    const session = await authenticate(request, offered);
    if (session === null) return closeWith("unauthenticated");
    if (session.kind === "bearer" && session.deckId !== deckId) return closeWith("deckNotFound");
    const discussionAfter = Number.parseInt(url.searchParams.get("discussionAfter") ?? "0", 10);
    const connected = await manager.connect({
      accountId: session.accountId,
      deckId,
      discussionAfter: Number.isSafeInteger(discussionAfter) && discussionAfter >= 0 ? discussionAfter : 0,
      port: {
        send: (frame) => {
          if (socket.readyState !== socket.OPEN) return;
          switch (frame.kind) {
            case "binary":
              socket.send(frame.bytes, { binary: true });
              return;
            case "text":
              socket.send(frame.text, { binary: false });
              return;
            default:
              assertNever(frame);
          }
        },
        close: (reason) => closeWith(reason),
      },
    });
    if (connected.kind === "refused") return closeWith(connected.reason);
    connection = connected.connection;
    if (closed) {
      connection.disconnect();
      return;
    }
    for (const frame of queued.splice(0)) connection.receive(frame);
    let answeredPing = true;
    socket.on("pong", () => {
      answeredPing = true;
    });
    socketHeartbeat.set(socket, () => {
      if (!answeredPing) {
        socket.terminate();
        return;
      }
      if (session.expiresAt <= now()) {
        connection?.closeWith("unauthenticated");
        return;
      }
      answeredPing = false;
      const message: ServerMessage = { kind: "heartbeat" };
      socket.send(JSON.stringify(message));
      socket.ping();
    });
    scheduleHeartbeat();
  };

  return {
    handleUpgrade: async ({ request, socket, head }) => {
      const url = new URL(request.url ?? "/", "http://host.invalid");
      if (!url.pathname.startsWith(DECK_SYNC_PATH_PREFIX)) return false;
      if (request.headers.origin !== origin) {
        refuseHandshake(socket, 403, "Forbidden");
        return true;
      }
      server.handleUpgrade(request, socket, head, (webSocket) => {
        attach(webSocket, request, url).catch((cause: unknown) => {
          warn(`deck socket: attaching failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          webSocket.close(CLOSE_CODE_BY_REASON.serverShuttingDown, "serverShuttingDown");
        });
      });
      return true;
    },
    openCount: () => open.size,
    close: () => {
      heartbeat?.[Symbol.dispose]();
      heartbeat = null;
      server.close();
    },
  };
}

function offeredProtocols(request: IncomingMessage): readonly string[] {
  const header = request.headers["sec-websocket-protocol"];
  if (typeof header !== "string") return [];
  return header.split(",").map((protocol) => protocol.trim()).filter((protocol) => protocol !== "");
}

function bytesOf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function refuseHandshake(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

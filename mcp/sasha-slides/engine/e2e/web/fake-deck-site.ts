// A STAND-IN FOR THE CONNECTOR'S DECK SERVER, for the web application's end-to-end run in Chrome
// until the collaboration server module's routes land: it serves the BUILT pages (dist/web, with
// the manifest's content security policy, so the run also proves the pages work under it), a test
// identity provider at /account/deck-session, the slice of the deck API the pages call, and the
// deck WebSocket -- the real wire protocol (collaboration.ts): a welcome, y-protocols sync on a
// model replica seeded with `blankDeck`, an awareness relay, the discussion log, heartbeats.
//
// What it does NOT do, on purpose: sign anything (the cookie is an opaque random token), persist
// anything (rooms live in memory, and survive `stop()` / `start()` like a restart with storage), or
// enforce the protected-field guard. It is a fake of the contracts, not a second server.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { asyncScheduler } from "rxjs";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { Doc } from "yjs";
import { BEARER_SUBPROTOCOL_PREFIX, BINARY_MESSAGE_TYPE, COLLABORATION_PROTOCOL_VERSION, DECK_SYNC_PATH_PREFIX, DECK_SYNC_SUBPROTOCOL, type ClientMessage, type ServerMessage } from "../../src/contracts/collaboration.ts";
import { assertNever } from "../../src/contracts/assert-never.ts";
import type { DeckMember, DeckRole } from "../../src/contracts/deck-access.ts";
import type { DeckSummary, WebBuildManifest } from "../../src/contracts/deck-api.ts";
import type { DiscussionLogEntry, Person } from "../../src/contracts/discussion.ts";
import type { DocumentStore } from "../../src/contracts/document-store.ts";
import { mintId, parseDeckId, parsePersonId, type DeckId } from "../../src/contracts/ids.ts";
import { createDocumentStore } from "../../src/model/index.ts";
import { sendFile, type HeadersOf } from "../../serve-directory.ts";
import { acceptWebSocket, offeredProtocolsOf, type ServerSocket } from "./minimal-websocket.ts";

export type FakeDeckSite = AsyncDisposable &
  Readonly<{
    address: string;
    /** The server goes away as a killed process would: sockets die (1006), the port refuses. */
    stop: () => Promise<void>;
    /** Listens again on the same port with the same rooms, as after a restart. */
    start: () => Promise<void>;
    deckTitle: (deckId: DeckId) => string | null;
    /** A single-use add-on ticket for an existing account, as the add-on handoff would mint one. */
    mintTicket: (email: string) => string;
    /** The text of every text body on every slide of a deck, as the server's replica holds it. */
    deckText: (deckId: DeckId) => string;
  }>;

type Account = Readonly<{ token: string; person: Person; email: string; csrfToken: string }>;

type Connection = Readonly<{ socket: ServerSocket; account: Account; awarenessClients: Set<number> }>;

type Room = {
  readonly deckId: DeckId;
  readonly owner: Account;
  readonly members: Map<string, DeckRole>;
  readonly invitations: { email: string; role: Exclude<DeckRole, "owner">; invitationId: string; invitedAt: number }[];
  readonly createdAt: number;
  updatedAt: number;
  readonly store: DocumentStore;
  readonly awareness: Awareness;
  readonly log: DiscussionLogEntry[];
  readonly connections: Set<Connection>;
  readonly assets: Map<string, Readonly<{ bytes: Buffer; mediaType: string }>>;
};

export async function startFakeDeckSite(options: Readonly<{ port: number; webDirectory: string }>): Promise<FakeDeckSite> {
  const manifest = JSON.parse(await readFile(join(options.webDirectory, "manifest.json"), "utf8")) as WebBuildManifest;
  const accounts = new Map<string, Account>();
  const tickets = new Map<string, Account>();
  const bearers = new Map<string, Account>();
  const rooms = new Map<DeckId, Room>();
  let server: Server | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const address = `http://127.0.0.1:${options.port}`;

  const accountOf = (request: IncomingMessage): Account | null => {
    const authorization = request.headers.authorization;
    if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return bearers.get(authorization.slice("Bearer ".length)) ?? null;
    const offeredBearer = offeredProtocolsOf(request).find((protocol) => protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX));
    if (offeredBearer !== undefined) return bearers.get(offeredBearer.slice(BEARER_SUBPROTOCOL_PREFIX.length)) ?? null;
    const cookie = request.headers.cookie ?? "";
    const token = /(?:^|;\s*)sasha_deck=([A-Za-z0-9_-]+)/.exec(cookie)?.[1];
    return token === undefined ? null : accounts.get(token) ?? null;
  };

  const roleIn = (room: Room, account: Account): DeckRole | null => room.members.get(account.token) ?? null;

  const summaryOf = (room: Room, account: Account): DeckSummary | null => {
    const role = roleIn(room, account);
    if (role === null) return null;
    return { deckId: room.deckId, title: room.store.snapshot().title, role, owner: room.owner.person, createdAt: room.createdAt, updatedAt: room.updatedAt, googleSlides: null };
  };

  const membersOf = (room: Room, viewer: Account): readonly DeckMember[] =>
    [...room.members].flatMap(([token, role]) => {
      const account = accounts.get(token);
      return account === undefined ? [] : [{ person: account.person, role, email: roleIn(room, viewer) === "owner" ? account.email : null }];
    });

  const detailsOf = (room: Room, account: Account): unknown => ({
    deck: summaryOf(room, account),
    members: membersOf(room, account),
    invitations: roleIn(room, account) === "owner" ? room.invitations : [],
    linkSharing: { kind: "off" },
    agentSessions: [],
  });

  const createRoom = (owner: Account, title: string): Room => {
    const deckId = parseDeckId(`dk_${randomBytes(16).toString("hex").slice(0, 22)}`);
    if (deckId === null) throw new Error("minted an invalid deck id");
    const store = createDocumentStore({ sharedDocument: new Doc(), seed: { kind: "blankDeck", deckId }, now: () => Date.now(), random: Math.random, scheduler: asyncScheduler, repairPolicy: "repairAfterTransaction", typingMergeWindowMilliseconds: 500 });
    store.apply({
      commandId: mintId({ seed: { sessionPrefix: "FakeSite", counter: rooms.size }, kind: "command" }).id,
      author: { kind: "person", personId: owner.person.id },
      commands: [{ kind: "setTitle", title }],
      selectionBefore: { kind: "none" },
      selectionAfter: { kind: "none" },
      mergeWithPrevious: false,
    });
    const room: Room = {
      deckId,
      owner,
      members: new Map([[owner.token, "owner"]]),
      invitations: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      store,
      awareness: new Awareness(new Doc()),
      log: [],
      connections: new Set(),
      assets: new Map(),
    };
    room.awareness.setLocalState(null);
    store.sharedDocument.on("update", (update: Uint8Array, origin: unknown) => {
      room.updatedAt = Date.now();
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
      syncProtocol.writeUpdate(encoder, update);
      const frame = encoding.toUint8Array(encoder);
      for (const connection of room.connections) if (connection !== origin) connection.socket.send(frame);
    });
    room.awareness.on("update", (changes: Readonly<{ added: number[]; updated: number[]; removed: number[] }>, origin: unknown) => {
      const changed = [...changes.added, ...changes.updated, ...changes.removed];
      for (const connection of room.connections) {
        if (connection === origin) {
          for (const clientId of [...changes.added, ...changes.updated]) connection.awarenessClients.add(clientId);
          continue;
        }
        connection.socket.send(awarenessFrame(room.awareness, changed));
      }
    });
    rooms.set(deckId, room);
    return room;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestAddress = new URL(request.url ?? "/", address);
    const path = requestAddress.pathname;
    const method = request.method ?? "GET";
    const account = accountOf(request);

    const policy = (value: string): HeadersOf => () => ({ "content-security-policy": value });
    if (path === "/decks" || path === "/decks/") return sendFile({ response, directory: options.webDirectory, path: manifest.listPage, headers: policy(manifest.contentSecurityPolicy) });
    if (path.startsWith("/deck/")) return sendFile({ response, directory: options.webDirectory, path: manifest.deckPage, headers: policy(requestAddress.searchParams.get("embed") === "addon" ? manifest.embeddedContentSecurityPolicy : manifest.contentSecurityPolicy) });
    if (path.startsWith("/deck-app/runner/")) return sendFile({ response, directory: join(options.webDirectory, "runner"), path: path.slice("/deck-app/runner/".length), headers: policy(manifest.runnerContentSecurityPolicy) });
    if (path.startsWith("/deck-app/")) return sendFile({ response, directory: join(options.webDirectory, "assets"), path: path.slice("/deck-app/".length) });
    if (path === "/account/deck-session" && method === "GET") return sendSignIn({ response, returnPath: requestAddress.searchParams.get("return") ?? "/decks" });
    if (path === "/account/deck-session/sign-in" && method === "POST") return signIn({ request, response });
    if (path === "/account") return sendText({ response, status: 200, text: "The account page (not part of the fake)." });
    if (!path.startsWith("/deck-api/")) return sendText({ response, status: 404, text: "Not found" });

    if (path === "/deck-api/embed/session" && method === "POST") {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as { ticket?: unknown };
      const holder = typeof body.ticket === "string" ? tickets.get(body.ticket) : undefined;
      if (holder === undefined || typeof body.ticket !== "string") return sendStructured({ response, status: 401, body: errorBody({ error: "signedOut", message: "That ticket is not valid." }) });
      tickets.delete(body.ticket);
      return sendStructured({ response, status: 200, body: embeddedSessionOf(holder) });
    }
    if (account === null) return sendStructured({ response, status: 401, body: errorBody({ error: "signedOut", message: "Sign in first.", signInAddress: `/account/deck-session?return=${encodeURIComponent(returnPathOf(request))}` }) });
    if (method !== "GET" && request.headers["x-sasha-csrf"] !== account.csrfToken) return sendStructured({ response, status: 403, body: errorBody({ error: "csrfMismatch", message: "The CSRF header is missing or stale." }) });

    if (path === "/deck-api/embed/renew" && method === "POST") return sendStructured({ response, status: 200, body: embeddedSessionOf(account) });
    if (path === "/deck-api/session") return sendStructured({ response, status: 200, body: { me: account.person, email: account.email, csrfToken: account.csrfToken, expiresAt: Date.now() + 12 * 3_600_000, authentication: "cookie" } });
    if (path === "/deck-api/decks" && method === "GET") {
      const decks = [...rooms.values()].flatMap((room) => summaryOf(room, account) ?? []).sort((left, right) => right.updatedAt - left.updatedAt);
      return sendStructured({ response, status: 200, body: { decks } });
    }
    if (path === "/deck-api/decks" && method === "POST") {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as { title?: unknown };
      const room = createRoom(account, typeof body.title === "string" ? body.title : "Untitled deck");
      return sendStructured({ response, status: 201, body: { deck: summaryOf(room, account) } });
    }
    if (path === "/deck-api/google-slides/import" && method === "POST") {
      // No Google grant in the fake: the import asks the person to connect Google Slides first.
      return sendStructured({ response, status: 409, body: { ...(errorBody({ error: "googleNotConnected", message: "Connect Google Slides to Sasha first, then import again." }) as object), connectAddress: "/deck-api/google-slides/connect?return=/decks" } });
    }
    const deckMatch = /^\/deck-api\/decks\/([^/]+)(\/.*)?$/.exec(path);
    const deckId = deckMatch?.[1] === undefined ? null : parseDeckId(deckMatch[1]);
    const room = deckId === null ? undefined : rooms.get(deckId);
    if (room === undefined || roleIn(room, account) === null) return sendStructured({ response, status: 404, body: errorBody({ error: "notFound", message: "No such deck." }) });
    const rest = deckMatch?.[2] ?? "";
    if (rest === "" && method === "GET") return sendStructured({ response, status: 200, body: detailsOf(room, account) });
    if (rest === "" && method === "DELETE") {
      for (const connection of room.connections) connection.socket.close(4005);
      rooms.delete(room.deckId);
      response.writeHead(204);
      response.end();
      return;
    }
    if (rest === "/members" && method === "POST") {
      const body = JSON.parse((await readBody(request)).toString("utf8")) as { email?: unknown; role?: unknown };
      const email = typeof body.email === "string" ? body.email : "";
      const role = body.role === "editor" || body.role === "commenter" || body.role === "viewer" ? body.role : "viewer";
      const existing = [...accounts.values()].find((candidate) => candidate.email === email);
      if (existing !== undefined) room.members.set(existing.token, role);
      else room.invitations.push({ email, role, invitationId: `in_${randomBytes(6).toString("hex")}`, invitedAt: Date.now() });
      return sendStructured({ response, status: 200, body: { outcome: existing === undefined ? "invited" : "added", details: detailsOf(room, account) } });
    }
    if (rest === "/assets" && method === "PUT") {
      const bytes = await readBody(request);
      const assetId = createHash("sha256").update(bytes).digest("hex");
      const mediaType = request.headers["content-type"] ?? "image/png";
      room.assets.set(assetId, { bytes, mediaType });
      return sendStructured({ response, status: 200, body: { assetId, mediaType, byteLength: bytes.length } });
    }
    const asset = /^\/assets\/([0-9a-f]{64})$/.exec(rest)?.[1];
    if (asset !== undefined && method === "GET") {
      const stored = room.assets.get(asset);
      if (stored === undefined) return sendStructured({ response, status: 404, body: errorBody({ error: "notFound", message: "No such image." }) });
      response.writeHead(200, { "Content-Type": stored.mediaType, "Cache-Control": "private, max-age=31536000, immutable" });
      response.end(stored.bytes);
      return;
    }
    return sendStructured({ response, status: 404, body: errorBody({ error: "notFound", message: `The fake deck site has no ${method} ${rest}.` }) });
  };

  const embeddedSessionOf = (holder: Account): unknown => {
    const bearerToken = randomBytes(24).toString("base64url");
    bearers.set(bearerToken, holder);
    const expiresAt = Date.now() + 15 * 60_000;
    const deckId = [...rooms.values()].find((room) => roleIn(room, holder) !== null)?.deckId ?? null;
    return { bearerToken, expiresAt, deckId, session: { me: holder.person, email: holder.email, csrfToken: holder.csrfToken, expiresAt, authentication: "bearer" } };
  };

  const signIn = async (options: Readonly<{ request: IncomingMessage; response: ServerResponse }>): Promise<void> => {
    const form = new URLSearchParams((await readBody(options.request)).toString("utf8"));
    const name = (form.get("name") ?? "Test Person").trim() || "Test Person";
    const email = (form.get("email") ?? "").trim() || `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
    const digest = createHash("sha256").update(`sasha-person.v1:${email}`).digest("hex").slice(0, 32);
    const personId = parsePersonId(`pr_${digest}`);
    if (personId === null) throw new Error("minted an invalid person id");
    const account: Account = { token: randomBytes(18).toString("base64url"), person: { id: personId, displayName: name, colourIndex: Number.parseInt(digest.slice(0, 8), 16) % 6, kind: "person" }, email, csrfToken: randomBytes(12).toString("base64url") };
    accounts.set(account.token, account);
    for (const room of rooms.values()) {
      for (let index = room.invitations.length - 1; index >= 0; index -= 1) {
        const invitation = room.invitations[index];
        if (invitation === undefined || invitation.email !== email) continue;
        room.members.set(account.token, invitation.role);
        room.invitations.splice(index, 1);
      }
    }
    const returnPath = form.get("return") ?? "/decks";
    options.response.writeHead(303, { Location: returnPath.startsWith("/deck") ? returnPath : "/decks", "Set-Cookie": `sasha_deck=${account.token}; Path=/deck-api; HttpOnly; SameSite=Strict` });
    options.response.end();
  };

  const upgrade = (request: IncomingMessage, stream: Duplex, head: Buffer): void => {
    const requestAddress = new URL(request.url ?? "/", address);
    const account = accountOf(request);
    const deckId = requestAddress.pathname.startsWith(DECK_SYNC_PATH_PREFIX) ? parseDeckId(requestAddress.pathname.slice(DECK_SYNC_PATH_PREFIX.length)) : null;
    const room = deckId === null ? undefined : rooms.get(deckId);
    if (account === null || room === undefined || roleIn(room, account) === null || !offeredProtocolsOf(request).includes(DECK_SYNC_SUBPROTOCOL)) {
      stream.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const socket = acceptWebSocket({ request, stream, head, protocol: DECK_SYNC_SUBPROTOCOL });
    const connection: Connection = { socket, account, awarenessClients: new Set() };
    room.connections.add(connection);
    const discussionAfter = Number(requestAddress.searchParams.get("discussionAfter") ?? "0");
    const welcome: ServerMessage = {
      kind: "welcome",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      deckId: room.deckId,
      me: account.person,
      role: roleIn(room, account) ?? "viewer",
      members: membersOf(room, account),
      discussionSequence: room.log.length,
    };
    socket.send(JSON.stringify(welcome));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
    syncProtocol.writeSyncStep1(encoder, room.store.sharedDocument);
    socket.send(encoding.toUint8Array(encoder));
    const present = [...room.awareness.getStates().keys()];
    if (present.length > 0) socket.send(awarenessFrame(room.awareness, present));
    socket.send(JSON.stringify({ kind: "discussionEntries", entries: room.log.filter((entry) => entry.sequence > discussionAfter) } satisfies ServerMessage));

    socket.onMessage((frame) => {
      if (typeof frame === "string") return receiveText({ room, connection, text: frame });
      const decoder = decoding.createDecoder(frame);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === BINARY_MESSAGE_TYPE.awareness) {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), connection);
        return;
      }
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, BINARY_MESSAGE_TYPE.sync);
      syncProtocol.readSyncMessage(decoder, reply, room.store.sharedDocument, connection);
      if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
    });
    socket.onClose(() => {
      room.connections.delete(connection);
      removeAwarenessStates(room.awareness, [...connection.awarenessClients], null);
    });
  };

  const receiveText = (options: Readonly<{ room: Room; connection: Connection; text: string }>): void => {
    // The page's own encoder wrote it; the fake trusts its shape (the real server parses it).
    const message = JSON.parse(options.text) as ClientMessage;
    switch (message.kind) {
      case "heartbeat":
        return;
      case "discussionRequest":
        break;
      default:
        assertNever(message);
    }
    const room = options.room;
    const earlier = room.log.find((entry) => entry.requestId === message.request.requestId);
    const entry: DiscussionLogEntry = earlier ?? { sequence: room.log.length + 1, requestId: message.request.requestId, actor: options.connection.account.person, at: Date.now(), command: message.request.command };
    if (earlier === undefined) {
      room.log.push(entry);
      for (const connection of room.connections) connection.socket.send(JSON.stringify({ kind: "discussionEntries", entries: [entry] } satisfies ServerMessage));
    }
    options.connection.socket.send(JSON.stringify({ kind: "discussionOutcome", outcome: { kind: "applied", requestId: entry.requestId, sequence: entry.sequence } } satisfies ServerMessage));
  };

  const start = async (): Promise<void> => {
    const created = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    created.on("upgrade", upgrade);
    await new Promise<void>((resolve, reject) => {
      created.once("error", reject);
      created.listen(options.port, "127.0.0.1", () => resolve());
    });
    server = created;
    heartbeat = setInterval(() => {
      for (const room of rooms.values()) for (const connection of room.connections) connection.socket.send(JSON.stringify({ kind: "heartbeat" } satisfies ServerMessage));
    }, 15_000);
  };

  const stop = async (): Promise<void> => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    for (const room of rooms.values()) for (const connection of [...room.connections]) connection.socket.destroy();
    const stopping = server;
    server = null;
    if (stopping === null) return;
    stopping.closeAllConnections();
    await new Promise<void>((resolve) => stopping.close(() => resolve()));
  };

  await start();
  return {
    address,
    stop,
    start,
    deckTitle: (deckId) => rooms.get(deckId)?.store.snapshot().title ?? null,
    mintTicket: (email) => {
      const holder = [...accounts.values()].find((candidate) => candidate.email === email);
      if (holder === undefined) throw new Error(`no account for ${email}`);
      const ticket = randomBytes(18).toString("base64url");
      tickets.set(ticket, holder);
      return ticket;
    },
    deckText: (deckId) => {
      const room = rooms.get(deckId);
      if (room === undefined) return "";
      return JSON.stringify(room.store.snapshot().slides);
    },
    [Symbol.asyncDispose]: async () => {
      await stop();
      // Each room's awareness runs an interval of its own; the stores hold scheduler work.
      for (const room of rooms.values()) {
        room.awareness.destroy();
        room.store[Symbol.dispose]();
      }
      rooms.clear();
    },
  };
}

function awarenessFrame(awareness: Awareness, clientIds: readonly number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.awareness);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [...clientIds]));
  return encoding.toUint8Array(encoder);
}

function errorBody(options: Readonly<{ error: string; message: string; signInAddress?: string }>): unknown {
  return { error: options.error, message: options.message, signInAddress: options.signInAddress ?? null, connectAddress: null, retryAfterSeconds: null };
}

/** The page that asked (the API's Referer), for the sign-in round trip; /decks otherwise. */
function returnPathOf(request: IncomingMessage): string {
  const referer = request.headers.referer;
  if (typeof referer !== "string") return "/decks";
  try {
    const path = new URL(referer).pathname;
    return path === "/decks" || /^\/deck\/[A-Za-z0-9_-]+$/.test(path) ? path : "/decks";
  } catch {
    return "/decks";
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendSignIn(options: Readonly<{ response: ServerResponse; returnPath: string }>): void {
  options.response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  options.response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in (test identity provider)</title></head>
<body style="font-family: sans-serif; padding: 40px">
<h1>Test identity provider</h1>
<form method="post" action="/account/deck-session/sign-in">
<input type="hidden" name="return" value="${options.returnPath.replace(/"/g, "&quot;")}">
<p><label>Name <input name="name" id="name" required></label></p>
<p><label>Email <input name="email" id="email"></label></p>
<p><button type="submit" id="sign-in">Sign in</button></p>
</form></body></html>`);
}

function sendStructured(options: Readonly<{ response: ServerResponse; status: number; body: unknown }>): void {
  options.response.writeHead(options.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  options.response.end(JSON.stringify(options.body));
}

function sendText(options: Readonly<{ response: ServerResponse; status: number; text: string }>): void {
  options.response.writeHead(options.status, { "Content-Type": "text/plain; charset=utf-8" });
  options.response.end(options.text);
}

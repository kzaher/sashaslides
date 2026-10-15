// A FAKE DECK SERVER FOR THE COLLABORATION CLIENT'S TESTS, built from the same y-protocols the real
// room uses: it owns a Y.Doc, answers the client's sync step 1 with its step 2, applies the
// client's step 2 and updates, broadcasts its own document changes, and records every text frame.
// It implements `OpenDeckSocket` directly, so the client under test runs its real code with no
// network.
//
// Key decision: SERVER FRAMES ARE QUEUED, NEVER DELIVERED INSIDE A CLIENT CALL. A reply sent from
// inside the client's own `send` would re-enter the client mid-handler; a real socket never does
// that. Tests call `flush()` to deliver everything queued (repeatedly, until quiet), so every step
// of the handshake is observable and deterministic.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { Doc } from "yjs";
import {
  BINARY_MESSAGE_TYPE,
  COLLABORATION_PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import type { DeckMember, DeckRole } from "../../contracts/deck-access.ts";
import type { DiscussionRequest, Person } from "../../contracts/discussion.ts";
import type { DeckId } from "../../contracts/ids.ts";
import type { DeckSocketListener, OpenDeckSocket } from "../collaboration/deck-socket.ts";

export type FakeConnection = Readonly<{
  address: string;
  protocols: readonly string[];
  /** The socket's `open` event. */
  open: () => void;
  /** Queues the welcome and then the server's sync step 1, as the real room does. */
  welcome: (options?: Readonly<{ role?: DeckRole; members?: readonly DeckMember[]; discussionSequence?: number }>) => void;
  /** open, welcome, then deliver until quiet: the client ends online. */
  handshake: (options?: Readonly<{ role?: DeckRole }>) => void;
  sendMessage: (message: ServerMessage) => void;
  sendText: (text: string) => void;
  sendBinary: (frame: Uint8Array) => void;
  /** The server closes the socket with `code` (delivered at once, like a close event). */
  close: (code: number) => void;
  setBufferedAmount: (bytes: number) => void;
  /** The code the client closed with, or null while it has not. */
  closedByClient: () => number | null;
  /** True once the client's sync step 2 (its answer to the server's step 1) arrived. */
  clientStepTwoReceived: () => boolean;
  clientMessages: () => readonly ClientMessage[];
  /** Awareness payloads the client sent (the bytes after the message type). */
  clientAwareness: () => readonly Uint8Array[];
}>;

export type FakeDeckServer = Readonly<{
  deckId: DeckId;
  document: Doc;
  openSocket: OpenDeckSocket;
  connections: () => readonly FakeConnection[];
  /** The most recently opened connection; throws when there is none. */
  latest: () => FakeConnection;
  /** Delivers every queued server frame, and what the client's answers queue, until quiet. */
  flush: () => void;
  /** Delivers the oldest queued server frame; false when nothing was queued. */
  flushOne: () => boolean;
  discussionRequests: () => readonly DiscussionRequest[];
}>;

export function createFakeDeckServer(options: Readonly<{ deckId: DeckId; me: Person }>): FakeDeckServer {
  const document = new Doc();
  const connections: FakeConnection[] = [];
  const outbox: (() => void)[] = [];
  const welcomed = new Set<FakeConnection>();

  document.on("update", (update: Uint8Array, origin: unknown) => {
    for (const connection of welcomed) {
      if (connection === origin) continue;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
      syncProtocol.writeUpdate(encoder, update);
      connection.sendBinary(encoding.toUint8Array(encoder));
    }
  });

  const flush = (): void => {
    for (let delivered = 0; outbox.length > 0; delivered += 1) {
      if (delivered > 10_000) throw new Error("The fake deck server kept sending frames.");
      outbox.shift()?.();
    }
  };

  const openSocket: OpenDeckSocket = (socketOptions) => {
    const listener: DeckSocketListener = socketOptions.listener;
    let bufferedAmount = 0;
    let closedByClient: number | null = null;
    let closed = false;
    let stepTwoReceived = false;
    const clientMessages: ClientMessage[] = [];
    const clientAwareness: Uint8Array[] = [];

    const queue = (frame: string | Uint8Array): void => {
      outbox.push(() => {
        if (!closed) listener.received(frame);
      });
    };

    const receiveFromClient = (frame: string | Uint8Array): void => {
      if (typeof frame === "string") {
        // The client's own encoder wrote it; the test reads it back as the contract type.
        clientMessages.push(JSON.parse(frame) as ClientMessage);
        return;
      }
      const decoder = decoding.createDecoder(frame);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === BINARY_MESSAGE_TYPE.awareness) {
        clientAwareness.push(decoding.readVarUint8Array(decoder));
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, document, connection);
      if (syncType === syncProtocol.messageYjsSyncStep2) stepTwoReceived = true;
      if (encoding.length(encoder) > 1) queue(encoding.toUint8Array(encoder));
    };

    const connection: FakeConnection = {
      address: socketOptions.address,
      protocols: socketOptions.protocols,
      open: () => listener.opened(),
      welcome: (welcomeOptions) => {
        const message: ServerMessage = {
          kind: "welcome",
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          deckId: options.deckId,
          me: options.me,
          role: welcomeOptions?.role ?? "editor",
          members: welcomeOptions?.members ?? [],
          discussionSequence: welcomeOptions?.discussionSequence ?? 0,
        };
        queue(JSON.stringify(message));
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
        syncProtocol.writeSyncStep1(encoder, document);
        queue(encoding.toUint8Array(encoder));
        welcomed.add(connection);
      },
      handshake: (handshakeOptions) => {
        connection.open();
        connection.welcome(handshakeOptions?.role === undefined ? {} : { role: handshakeOptions.role });
        flush();
      },
      sendMessage: (message) => queue(JSON.stringify(message)),
      sendText: (text) => queue(text),
      sendBinary: (frame) => queue(frame),
      close: (code) => {
        if (closed) return;
        closed = true;
        welcomed.delete(connection);
        listener.closed(code);
      },
      setBufferedAmount: (bytes) => {
        bufferedAmount = bytes;
      },
      closedByClient: () => closedByClient,
      clientStepTwoReceived: () => stepTwoReceived,
      clientMessages: () => clientMessages,
      clientAwareness: () => clientAwareness,
    };
    connections.push(connection);
    return {
      send: (frame) => {
        if (closed) return;
        receiveFromClient(frame);
      },
      bufferedAmount: () => bufferedAmount,
      close: (code) => {
        if (closed) return;
        closed = true;
        closedByClient = code;
        welcomed.delete(connection);
      },
    };
  };

  return {
    deckId: options.deckId,
    document,
    openSocket,
    connections: () => connections,
    latest: () => {
      const connection = connections[connections.length - 1];
      if (connection === undefined) throw new Error("No socket was opened.");
      return connection;
    },
    flush,
    flushOne: () => {
      const next = outbox.shift();
      if (next === undefined) return false;
      next();
      return true;
    },
    discussionRequests: () =>
      connections.flatMap((connection) =>
        connection.clientMessages().flatMap((message) => {
          switch (message.kind) {
            case "discussionRequest":
              return [message.request];
            case "heartbeat":
              return [];
            default:
              return assertNever(message);
          }
        }),
      ),
  };
}

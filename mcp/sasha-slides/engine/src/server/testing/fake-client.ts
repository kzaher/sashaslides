// A FAKE BROWSER for the room's tests: its own Y.Doc and y-protocols Awareness, speaking the real
// wire format (y-protocols' sync and awareness encoders, JSON text frames) to a room through a
// synchronous in-memory port. Delivery is immediate and in order, so a test reads the result of a
// frame on the next line, with no timers and no sockets.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { BINARY_MESSAGE_TYPE, type CloseReason, type ServerMessage } from "../../contracts/collaboration.ts";
import type { DeckRole } from "../../contracts/deck-access.ts";
import type { Person } from "../../contracts/discussion.ts";
import { awarenessFrame, syncStepOneFrame, syncUpdateFrame } from "../../shared/sync-frames.ts";
import type { DeckRoom, RoomConnection, RoomFrame } from "../deck-room.ts";

export type FakeClient = Disposable &
  Readonly<{
    sharedDocument: Y.Doc;
    awareness: awarenessProtocol.Awareness;
    connection: RoomConnection;
    /** Every JSON text frame the server sent, parsed, in order. */
    messages: () => readonly ServerMessage[];
    /** Binary frames the server sent, in order. */
    binaryFrames: () => readonly Uint8Array[];
    closedWith: () => CloseReason | null;
    /** Sends the local awareness state (y-protocols' encoder) to the room. */
    publishAwareness: () => void;
    /** Sends raw awareness bytes, e.g. a forged removal of someone else's client id. */
    sendAwarenessUpdate: (update: Uint8Array) => void;
    sendText: (text: string) => void;
    sendBinary: (bytes: Uint8Array) => void;
    /** Leaves (the transport closed). */
    leave: () => void;
  }>;

/** The origin under which the fake applies what the server sent, so it is not echoed back. */
const FROM_SERVER = Object.freeze({ kind: "fromServer" });

export function connectFakeClient(
  options: Readonly<{ room: DeckRoom; person: Person; role: DeckRole; discussionAfter?: number; sendLocalUpdates?: boolean }>,
): FakeClient {
  const sharedDocument = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(sharedDocument);
  const messages: ServerMessage[] = [];
  const binaryFrames: Uint8Array[] = [];
  let closedWith: CloseReason | null = null;
  let connection: RoomConnection | null = null;
  const pendingBeforeConnected: RoomFrame[] = [];

  const send = (frame: RoomFrame): void => {
    if (connection === null) {
      pendingBeforeConnected.push(frame);
      return;
    }
    connection.receive(frame);
  };

  const receive = (frame: RoomFrame): void => {
    switch (frame.kind) {
      case "text":
        // The room only sends `ServerMessage` JSON (deck-room.ts `sendMessage`).
        messages.push(JSON.parse(frame.text) as ServerMessage);
        return;
      case "binary":
        binaryFrames.push(frame.bytes);
        receiveBinary(frame.bytes);
        return;
      default:
        throw new Error("unknown frame");
    }
  };

  const receiveBinary = (bytes: Uint8Array): void => {
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case BINARY_MESSAGE_TYPE.sync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
        syncProtocol.readSyncMessage(decoder, encoder, sharedDocument, FROM_SERVER);
        if (encoding.length(encoder) > 1) send({ kind: "binary", bytes: encoding.toUint8Array(encoder) });
        return;
      }
      case BINARY_MESSAGE_TYPE.awareness:
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), FROM_SERVER);
        return;
      default:
        throw new Error(`unknown binary message type ${String(messageType)}`);
    }
  };

  const sendLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === FROM_SERVER) return;
    send({ kind: "binary", bytes: syncUpdateFrame(update) });
  };
  if (options.sendLocalUpdates !== false) sharedDocument.on("update", sendLocalUpdate);

  connection = options.room.connect({
    person: options.person,
    role: options.role,
    discussionAfter: options.discussionAfter ?? 0,
    port: {
      send: receive,
      close: (reason) => {
        closedWith = reason;
      },
    },
  });
  // The client's own sync step 1, after the server's (y-websocket sends it on open).
  send({ kind: "binary", bytes: syncStepOneFrame(sharedDocument) });
  for (const frame of pendingBeforeConnected.splice(0)) send(frame);
  const connected = connection;

  const sendAwarenessUpdate = (update: Uint8Array): void => {
    send({ kind: "binary", bytes: awarenessFrame(update) });
  };

  return {
    sharedDocument,
    awareness,
    connection: connected,
    messages: () => messages,
    binaryFrames: () => binaryFrames,
    closedWith: () => closedWith,
    publishAwareness: () => sendAwarenessUpdate(awarenessProtocol.encodeAwarenessUpdate(awareness, [sharedDocument.clientID])),
    sendAwarenessUpdate,
    sendText: (text) => send({ kind: "text", text }),
    sendBinary: (bytes) => send({ kind: "binary", bytes }),
    leave: () => connected.disconnect(),
    [Symbol.dispose]: () => {
      sharedDocument.off("update", sendLocalUpdate);
      awareness.destroy();
      sharedDocument.destroy();
    },
  };
}

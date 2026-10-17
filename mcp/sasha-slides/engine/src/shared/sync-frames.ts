// THE Y-WEBSOCKET FRAMES THE DECK PROTOCOL SENDS, built in one place: a binary frame is a varUint
// message type (contracts/collaboration.ts `BINARY_MESSAGE_TYPE`) followed by the y-protocols sync
// body or an awareness update. The deck room, the browser's collaboration session, its awareness
// channel and the test fakes of both ends all build the same four frames; each had its own
// encoder lines until they came here. Pure and DOM-free: only lib0 and y-protocols, no socket.

import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";
import { BINARY_MESSAGE_TYPE } from "../contracts/collaboration.ts";

/** Sync step 1: `document`'s state vector, asking the peer for everything it lacks. */
export function syncStepOneFrame(document: Y.Doc): Uint8Array {
  return syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, document));
}

/** Sync step 2: `update` is what the peer's step 1 said it was missing. */
export function syncStepTwoFrame(update: Uint8Array): Uint8Array {
  return syncFrame((encoder) => {
    encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(encoder, update);
  });
}

/** A document update to relay. */
export function syncUpdateFrame(update: Uint8Array): Uint8Array {
  return syncFrame((encoder) => syncProtocol.writeUpdate(encoder, update));
}

/** An encoded awareness update (`encodeAwarenessUpdate`'s bytes). */
export function awarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.awareness);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function syncFrame(writeBody: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, BINARY_MESSAGE_TYPE.sync);
  writeBody(encoder);
  return encoding.toUint8Array(encoder);
}

// The frames' exact bytes: the first varUint is the message type, so the server, the browser and the
// fakes agree with y-websocket on the wire. A sync update of [7, 8] is 0 (sync), 2 (update), 2 (length), 7, 8.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import { awarenessFrame, syncStepOneFrame, syncStepTwoFrame, syncUpdateFrame } from "./sync-frames.ts";

describe("y-websocket frames", () => {
  it("frames a document update as sync message 2", () => {
    assert.deepEqual([...syncUpdateFrame(Uint8Array.of(7, 8))], [0, 2, 2, 7, 8]);
  });

  it("frames sync step 2 as sync message 1", () => {
    assert.deepEqual([...syncStepTwoFrame(Uint8Array.of(7, 8))], [0, 1, 2, 7, 8]);
  });

  it("frames sync step 1 as sync message 0 carrying the state vector", () => {
    const document = new Y.Doc();
    assert.deepEqual([...syncStepOneFrame(document)], [0, 0, 1, 0]);
  });

  it("frames an awareness update as message type 1", () => {
    assert.deepEqual([...awarenessFrame(Uint8Array.of(7, 8))], [1, 2, 7, 8]);
  });
});

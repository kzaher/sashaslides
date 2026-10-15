// A MINIMAL RFC 6455 WEBSOCKET SERVER for the end-to-end fake deck site: the opening handshake with
// a chosen subprotocol, unmasking client frames (text, binary, continuation, close, ping), and
// unmasked server frames. Written here, on node:http's `upgrade`, because the engine declares no
// WebSocket server dependency (`ws` arrives with the collaboration server module) and a second,
// hand-typed declaration of `ws` would collide with its real types when they land.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export type ServerSocket = Readonly<{
  /** The subprotocols the client offered. */
  offeredProtocols: readonly string[];
  send: (frame: string | Uint8Array) => void;
  /** An orderly close with `code` (a close frame, then the end of the stream). */
  close: (code: number) => void;
  /** The connection simply dies, as when a server process is killed: the client sees 1006. */
  destroy: () => void;
  onMessage: (handler: (frame: string | Uint8Array) => void) => void;
  onClose: (handler: () => void) => void;
}>;

/** RFC 6455 section 4.2.2: appended to the client's key before hashing it into the accept value. */
const HANDSHAKE_SUFFIX = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function offeredProtocolsOf(request: IncomingMessage): readonly string[] {
  const header = request.headers["sec-websocket-protocol"];
  return (typeof header === "string" ? header : "").split(",").map((protocol) => protocol.trim()).filter((protocol) => protocol !== "");
}

/** Completes the handshake on an `upgrade` request, choosing `protocol`. */
export function acceptWebSocket(options: Readonly<{ request: IncomingMessage; stream: Duplex; head: Buffer; protocol: string }>): ServerSocket {
  const key = options.request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${typeof key === "string" ? key : ""}${HANDSHAKE_SUFFIX}`).digest("base64");
  const stream = options.stream;
  stream.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, `Sec-WebSocket-Protocol: ${options.protocol}`, "", ""].join("\r\n"));

  const messageHandlers: ((frame: string | Uint8Array) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let buffered = options.head.length > 0 ? Buffer.from(options.head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentOpcode = 0;
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  };

  const writeFrame = (opcode: number, payload: Buffer): void => {
    if (stream.destroyed || stream.writableEnded) return;
    const length = payload.length;
    const header = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = length;
    else if (length < 65_536) {
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    stream.write(Buffer.concat([header, payload]));
  };

  const deliver = (opcode: number, payload: Buffer): void => {
    const frame = opcode === 1 ? payload.toString("utf8") : new Uint8Array(payload);
    for (const handler of messageHandlers) handler(frame);
  };

  const readFrames = (): void => {
    for (;;) {
      if (buffered.length < 2) return;
      const first = buffered[0] ?? 0;
      const second = buffered[1] ?? 0;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffered.length < offset + length) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] = (payload[index] ?? 0) ^ (buffered[maskOffset + (index % 4)] ?? 0);
      buffered = buffered.subarray(offset + length);
      if (opcode === 8) {
        writeFrame(8, payload.subarray(0, 2));
        stream.end();
        finish();
        return;
      }
      if (opcode === 9) {
        writeFrame(10, payload);
        continue;
      }
      if (opcode === 10) continue;
      if (opcode === 0) fragments.push(payload);
      else {
        fragmentOpcode = opcode;
        fragments = [payload];
      }
      if (!final) continue;
      deliver(fragmentOpcode, Buffer.concat(fragments));
      fragments = [];
    }
  };

  stream.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    readFrames();
  });
  stream.on("close", finish);
  stream.on("error", finish);
  if (buffered.length > 0) queueMicrotask(readFrames);

  return {
    offeredProtocols: offeredProtocolsOf(options.request),
    send: (frame) => {
      if (closed) return;
      if (typeof frame === "string") writeFrame(1, Buffer.from(frame, "utf8"));
      else writeFrame(2, Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
    },
    close: (code) => {
      if (closed) return;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      writeFrame(8, payload);
      stream.end();
      finish();
    },
    destroy: () => {
      stream.destroy();
      finish();
    },
    onMessage: (handler) => {
      messageHandlers.push(handler);
    },
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
  };
}

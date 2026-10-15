// THE SOCKET AS THE CONNECTION SEES IT: open with an address and subprotocols, send text or bytes,
// read how much is still buffered, close with a code, and three callbacks. The browser's WebSocket
// is adapted to it here, once; the tests' fake server implements it directly, so every unit test
// runs the real connection code against a y-protocols peer without a network.

export type DeckSocketListener = Readonly<{
  opened: () => void;
  /** A text frame as a string, a binary frame as its bytes. */
  received: (frame: string | Uint8Array) => void;
  /** Exactly once per socket, after an error too (the browser fires `close` after `error`). */
  closed: (code: number) => void;
}>;

export type DeckSocket = Readonly<{
  send: (frame: string | Uint8Array) => void;
  /** `WebSocket.bufferedAmount`: bytes queued but not yet handed to the network. */
  bufferedAmount: () => number;
  close: (code: number) => void;
}>;

export type OpenDeckSocket = (options: Readonly<{ address: string; protocols: readonly string[]; listener: DeckSocketListener }>) => DeckSocket;

/** Close code for "the network dropped" (RFC 6455 1006), used when a socket cannot even be created. */
export const ABNORMAL_CLOSE_CODE = 1006;
/** Close code for a deliberate, orderly close by this client. */
export const NORMAL_CLOSE_CODE = 1000;

/** The browser's WebSocket behind `OpenDeckSocket`. */
export function browserDeckSocket(createSocket: (address: string, protocols: string[]) => WebSocket): OpenDeckSocket {
  return (options) => {
    let socket: WebSocket;
    try {
      socket = createSocket(options.address, [...options.protocols]);
    } catch {
      // An address the browser refuses outright: report it as a dropped connection, asynchronously
      // like a real close, so the caller's state is never re-entered from inside `open`.
      queueMicrotask(() => options.listener.closed(ABNORMAL_CLOSE_CODE));
      return { send: () => undefined, bufferedAmount: () => 0, close: () => undefined };
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => options.listener.opened());
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data === "string") {
        options.listener.received(data);
        return;
      }
      if (data instanceof ArrayBuffer) options.listener.received(new Uint8Array(data));
    });
    socket.addEventListener("close", (event: CloseEvent) => options.listener.closed(event.code));
    return {
      send: (frame) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (typeof frame === "string") {
          socket.send(frame);
          return;
        }
        // A view over a plain ArrayBuffer is sent as is; one over shared memory (never produced by
        // lib0's encoder, but the type allows it) is copied, as WebSocket.send requires.
        socket.send(frame.buffer instanceof ArrayBuffer ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : frame.slice());
      },
      bufferedAmount: () => socket.bufferedAmount,
      close: (code) => socket.close(code),
    };
  };
}

/**
 * A `Transport` decorator that copies every JSON-RPC frame crossing a connection to a sink,
 * in both directions, without altering it.
 *
 * It exists because MCP is bidirectional and the interesting question — "did the *server* ever
 * send a request?" — is invisible from either endpoint's API. `Client` and `Server` expose
 * methods and handlers; only the transport sees the wire. Wrapping the transport is also the
 * only hook that sees the raw `initialize` params, which the SDK's `Server` consumes internally
 * and re-exposes only as a parsed `ClientCapabilities` (and, in stateless HTTP mode, re-exposes
 * on a *different* server instance than the one that handled the request).
 *
 * `Protocol.connect` installs `onclose`/`onerror`/`onmessage` on the transport it is given and
 * only then calls `start()`, so this decorator forwards whatever was installed on it at the
 * moment `start()` runs — which is why the inner transport's callbacks are wired there and not
 * in the constructor.
 */
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

/** From the perspective of the endpoint this transport is attached to. */
export type FrameDirection = "incoming" | "outgoing";

export type RecordedFrame = Readonly<{
  at: string;
  /** The endpoint that owns the wrapped transport, so one log can hold both sides. */
  endpoint: string;
  direction: FrameDirection;
  message: JSONRPCMessage;
}>;

export type FrameSink = (frame: RecordedFrame) => void;

export class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <TMessage extends JSONRPCMessage>(message: TMessage, extra?: MessageExtraInfo) => void;

  /**
   * Mirrored from the wrapped transport whenever a frame arrives, because
   * `StreamableHTTPServerTransport` only assigns it while handling `initialize` and
   * `Protocol` reads it off *this* object to populate `extra.sessionId`. Copied rather than
   * proxied through a getter: `Transport` declares the property as optional-`string`, which
   * under exactOptionalPropertyTypes a `string | undefined` getter cannot satisfy.
   */
  sessionId?: string;

  private readonly inner: Transport;
  private readonly endpoint: string;
  private readonly now: () => Date;
  private readonly record: FrameSink;

  constructor(
    options: Readonly<{ inner: Transport; endpoint: string; now: () => Date; record: FrameSink }>,
  ) {
    this.inner = options.inner;
    this.endpoint = options.endpoint;
    this.now = options.now;
    this.record = options.record;
  }

  async start(): Promise<void> {
    this.inner.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo): void => {
      const sessionId = this.inner.sessionId;
      if (sessionId !== undefined) this.sessionId = sessionId;
      this.emit({ direction: "incoming", message });
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error: Error): void => void this.onerror?.(error);
    this.inner.onclose = (): void => void this.onclose?.();
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.emit({ direction: "outgoing", message });
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  private emit(frame: Readonly<{ direction: FrameDirection; message: JSONRPCMessage }>): void {
    this.record({
      at: this.now().toISOString(),
      endpoint: this.endpoint,
      direction: frame.direction,
      message: frame.message,
    });
  }
}

/** One frame per line, so a running probe can be tailed and the log diffed. */
export function formatFrameLine(frame: RecordedFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

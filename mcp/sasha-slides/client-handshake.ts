/**
 * What a connecting MCP client advertised in `initialize`.
 *
 * This is the server's *only* source of truth for whether a server→client request is legal on
 * a connection: the SDK's `Server.assertCapabilityForMethod` refuses `sampling/createMessage`
 * unless the client declared `capabilities.sampling`, `elicitation/create` unless it declared
 * `capabilities.elicitation`, and `roots/list` unless it declared `capabilities.roots`. So
 * "can our server push a message into the conversation?" is answered by what lands here, not
 * by what the protocol allows in the abstract — and it is answered per client, per version.
 *
 * Recorded at the transport rather than from `Server.oninitialized` on purpose. `oninitialized`
 * fires on the `notifications/initialized` *notification*, which in the stateless HTTP mode
 * (`http/http-server.ts` builds a fresh `McpServer` per POST) arrives at a different server
 * instance than the `initialize` request did — so that hook sees no capabilities at all there.
 * The transport sees the raw frame on every transport.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InitializeRequestSchema, type ClientCapabilities, type Implementation } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";
import { RecordingTransport, type FrameSink } from "./jsonrpc-recording-transport.ts";

export type ClientHandshake = Readonly<{
  at: string;
  protocolVersion: string;
  clientInfo: Implementation;
  capabilities: ClientCapabilities;
  /** The three server→client capabilities, pre-decided so a log line answers the question directly. */
  supportsSampling: boolean;
  supportsElicitation: boolean;
  supportsRoots: boolean;
}>;

/**
 * Wraps `inner` so every `initialize` request observed on it is reported to `emit`. Frames are
 * passed through untouched; nothing here can change the handshake it records.
 */
export function handshakeRecordingTransport(
  options: Readonly<{
    inner: Transport;
    endpoint: string;
    now: () => Date;
    emit: (handshake: ClientHandshake) => void;
    /** Every frame, for the full bidirectional record. Pass a no-op to record handshakes only. */
    record: FrameSink;
  }>,
): Transport {
  const { inner, endpoint, now, emit, record } = options;
  return new RecordingTransport({
    inner,
    endpoint,
    now,
    record: (frame) => {
      record(frame);
      if (frame.direction !== "incoming") return;
      const handshake = clientHandshakeOf({ frame: frame.message, at: frame.at });
      if (handshake === null) return;
      emit(handshake);
    },
  });
}

/**
 * Parses an `initialize` request out of an arbitrary JSON-RPC frame, or reports that it is not
 * one. The trust boundary: `InitializeRequestSchema` is the SDK's own schema for the method, so
 * the spec's shape is the single source of truth rather than a hand-written set of checks.
 */
export function clientHandshakeOf(
  options: Readonly<{ frame: unknown; at: string }>,
): ClientHandshake | null {
  const parsed = InitializeRequestSchema.safeParse(options.frame);
  if (!parsed.success) return null;
  const { params } = parsed.data;
  return {
    at: options.at,
    protocolVersion: params.protocolVersion,
    clientInfo: params.clientInfo,
    capabilities: params.capabilities,
    supportsSampling: params.capabilities.sampling !== undefined,
    supportsElicitation: params.capabilities.elicitation !== undefined,
    supportsRoots: params.capabilities.roots !== undefined,
  };
}

/** One handshake per line, appended, so concurrent connections and restarts all accumulate. */
export function appendClientHandshake(options: Readonly<{ path: string; handshake: ClientHandshake }>): void {
  appendFileSync(options.path, `${JSON.stringify(options.handshake)}\n`, "utf8");
}

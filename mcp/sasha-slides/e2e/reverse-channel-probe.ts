#!/usr/bin/env node
/**
 * Does MCP let a *server* push a message into an agent conversation — the reverse of the
 * normal tool-call direction? This probe answers it by measurement, not by reading the spec.
 *
 *   npx tsx mcp/sasha-slides/e2e/reverse-channel-probe.ts [--out <dir>]
 *
 * Six probes, each one a separate MCP connection, with every JSON-RPC frame in both
 * directions appended to `<out>/frames.jsonl`:
 *
 *   1. real-server-stdio       The actual `server.ts --stdio`, driven by a client that
 *                              declares sampling + elicitation + roots. Records what the
 *                              server does with that offer (nothing) and what it declares.
 *   2. sampling-with-capability    `server.server.createMessage(...)` on the real
 *                              `createSashaSlidesServer` object, client declares sampling.
 *   3. sampling-without-capability Same, client declares nothing: the SDK refuses locally.
 *   4. elicitation             `server.server.elicitInput(...)`, client declares elicitation.
 *   5. tool-initiated-sampling A tool handler calling back with `extra.sendRequest`, which is
 *                              the shape a real feature would take (the reply rides the
 *                              originating request's stream, so it also works over HTTP SSE).
 *   6. resource-subscription   `resources/subscribe` against the real server, and the
 *                              server-side `notifications/resources/updated` path.
 *
 * Probes 2-5 use an in-process `InMemoryTransport` pair because the question is whether the
 * *server object* can issue a server→client request at all; probe 1 is the real subprocess, so
 * the handshake and the absence of any server-initiated frame are observed on a real wire.
 *
 * Everything effectful - the clock, the output directory, the frame sink - is passed in, so
 * `runReverseChannelProbe` can be driven from a test with no filesystem.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  ElicitRequestSchema,
  ResourceUpdatedNotificationSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { clientHandshakeOf, type ClientHandshake } from "../client-handshake.ts";
import { assertNever } from "../google-auth.ts";
import {
  RecordingTransport,
  formatFrameLine,
  type FrameSink,
  type RecordedFrame,
} from "../jsonrpc-recording-transport.ts";
import { createSashaSlidesServer } from "../server.ts";

/** What a probe concluded about one candidate reverse channel. */
export type ProbeVerdict =
  /** The server→client message was delivered and its result came back. */
  | "works"
  /** The attempt was refused; `detail` says by what. */
  | "blocked";

export type ProbeOutcome = Readonly<{
  name: string;
  verdict: ProbeVerdict;
  detail: string;
}>;

export type ProbeReport = Readonly<{
  outcomes: readonly ProbeOutcome[];
  handshakes: readonly ClientHandshake[];
  frameCount: number;
}>;

export const PROBE_CLIENT_NAME = "reverse-channel-probe";
export const PROBE_CLIENT_VERSION = "1.0.0";
/** Every probe is request/response over a live connection; nothing here should take seconds. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Long enough for a server that wanted to push something to have pushed it. */
export const IDLE_WINDOW_MS = 1_500;

export async function runReverseChannelProbe(
  options: Readonly<{ repoRoot: string; record: FrameSink; now: () => Date }>,
): Promise<ProbeReport> {
  const handshakes: ClientHandshake[] = [];
  const frames: RecordedFrame[] = [];
  const record: FrameSink = (frame) => {
    frames.push(frame);
    options.record(frame);
    if (frame.direction !== "outgoing") return;
    const handshake = clientHandshakeOf({ frame: frame.message, at: frame.at });
    if (handshake !== null) handshakes.push(handshake);
  };
  const probeOptions = { repoRoot: options.repoRoot, record, now: options.now } as const;
  const outcomes: readonly ProbeOutcome[] = [
    await probeRealServerOverStdio({
      ...probeOptions,
      serverInitiatedRequests: () =>
        frames.filter((frame) => frame.endpoint === "probe-client" && isIncomingRequest(frame)).length,
    }),
    await probeSamplingWithCapability(probeOptions),
    await probeSamplingWithoutCapability(probeOptions),
    await probeElicitation(probeOptions),
    await probeToolInitiatedSampling(probeOptions),
    await probeResourceSubscription(probeOptions),
  ];
  return { outcomes, handshakes, frameCount: frames.length };
}

/**
 * Probe 1. The real server, as a subprocess, over stdio - the transport Claude Code uses for a
 * local MCP server. The client offers everything a server could ask for and then sits still:
 * whatever lands in the frame log is what the server chose to do with the offer.
 */
export async function probeRealServerOverStdio(
  options: Readonly<{
    repoRoot: string;
    record: FrameSink;
    now: () => Date;
    /** How many requests the *server* has sent so far, read from the shared frame log. */
    serverInitiatedRequests: () => number;
  }>,
): Promise<ProbeOutcome> {
  const { repoRoot, record, now, serverInitiatedRequests } = options;
  const handshakeLogPath = join(repoRoot, "mcp/sasha-slides/e2e/.work/probe-handshake.jsonl");
  rmSync(handshakeLogPath, { force: true });
  mkdirSync(join(repoRoot, "mcp/sasha-slides/e2e/.work"), { recursive: true });
  const stdio = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp/sasha-slides/server.ts", "--stdio", "--handshake-log", handshakeLogPath],
    cwd: repoRoot,
    stderr: "ignore",
  });
  const client = fullyCapableClient();
  const transport = new RecordingTransport({ inner: stdio, endpoint: "probe-client", now, record });
  try {
    await client.connect(transport);
    const serverCapabilities = client.getServerCapabilities() ?? {};
    const tools = await client.listTools(undefined, { timeout: PROBE_TIMEOUT_MS });
    const before = serverInitiatedRequests();
    await idleFor({ windowMs: IDLE_WINDOW_MS });
    const serverInitiated = serverInitiatedRequests() - before;
    const logged = readFileSync(handshakeLogPath, "utf8").trim();
    return {
      name: "real-server-stdio",
      verdict: "blocked",
      detail:
        `server declared capabilities ${JSON.stringify(serverCapabilities)}; ` +
        `tools ${tools.tools.map((tool) => tool.name).join(", ")}; ` +
        `server-initiated requests in a ${String(IDLE_WINDOW_MS)}ms idle window: ${String(serverInitiated)}; ` +
        `handshake it logged: ${logged}`,
    };
  } finally {
    await client.close();
  }
}

/**
 * Probe 2. The real `createSashaSlidesServer` object, asked to issue `sampling/createMessage`
 * to a client that declared `sampling`. This is the load-bearing question: if it succeeds, the
 * server code is not what blocks a reverse channel - the client's capabilities are.
 */
export async function probeSamplingWithCapability(
  options: Readonly<{ record: FrameSink; now: () => Date }>,
): Promise<ProbeOutcome> {
  const { record, now } = options;
  const client = fullyCapableClient();
  client.setRequestHandler(CreateMessageRequestSchema, (request) =>
    Promise.resolve(stubCompletion({ echo: lastUserText(request.params.messages) })),
  );
  const server = probeSashaSlidesServer();
  const connected = await connectInMemory({ client, server, record, now });
  try {
    const result = await server.server.createMessage(
      {
        messages: [{ role: "user", content: { type: "text", text: "A user commented: tighten slide 3." } }],
        maxTokens: 256,
      },
      { timeout: PROBE_TIMEOUT_MS },
    );
    return {
      name: "sampling-with-capability",
      verdict: "works",
      detail: `sampling/createMessage round-tripped: ${JSON.stringify(result)}`,
    };
  } catch (cause: unknown) {
    return { name: "sampling-with-capability", verdict: "blocked", detail: describe(cause) };
  } finally {
    await connected.close();
  }
}

/**
 * Probe 3. The same call to a client that declared no capabilities. The refusal is local - the
 * SDK's `Server.assertCapabilityForMethod` throws before anything reaches the wire - which is
 * why the frame log for this probe contains no `sampling/createMessage` at all.
 */
export async function probeSamplingWithoutCapability(
  options: Readonly<{ record: FrameSink; now: () => Date }>,
): Promise<ProbeOutcome> {
  const { record, now } = options;
  const client = new Client(
    { name: PROBE_CLIENT_NAME, version: PROBE_CLIENT_VERSION },
    { capabilities: {} },
  );
  const server = probeSashaSlidesServer();
  const connected = await connectInMemory({ client, server, record, now });
  try {
    const result = await server.server.createMessage(
      { messages: [{ role: "user", content: { type: "text", text: "anyone there?" } }], maxTokens: 16 },
      { timeout: PROBE_TIMEOUT_MS },
    );
    return {
      name: "sampling-without-capability",
      verdict: "works",
      detail: `unexpected: a client that declared no sampling answered ${JSON.stringify(result)}`,
    };
  } catch (cause: unknown) {
    return { name: "sampling-without-capability", verdict: "blocked", detail: describe(cause) };
  } finally {
    await connected.close();
  }
}

/** Probe 4. `elicitation/create`: the server asks the *client* to collect user input. */
export async function probeElicitation(
  options: Readonly<{ record: FrameSink; now: () => Date }>,
): Promise<ProbeOutcome> {
  const { record, now } = options;
  const client = fullyCapableClient();
  client.setRequestHandler(ElicitRequestSchema, () => Promise.resolve(stubElicitAccept()));
  const server = probeSashaSlidesServer();
  const connected = await connectInMemory({ client, server, record, now });
  try {
    const result = await server.server.elicitInput(
      {
        mode: "form",
        message: "The user commented in the sidebar. What should the deck say instead?",
        requestedSchema: {
          type: "object",
          properties: { comment: { type: "string", description: "The user's comment." } },
          required: ["comment"],
        },
      },
      { timeout: PROBE_TIMEOUT_MS },
    );
    return {
      name: "elicitation",
      verdict: "works",
      detail: `elicitation/create round-tripped: ${JSON.stringify(result)}`,
    };
  } catch (cause: unknown) {
    return { name: "elicitation", verdict: "blocked", detail: describe(cause) };
  } finally {
    await connected.close();
  }
}

/**
 * Probe 5. Sampling issued from *inside* a tool handler via `extra.sendRequest`. This is the
 * only shape that survives the production transport: `http/http-server.ts` runs Streamable
 * HTTP in stateless mode (a fresh server and transport per POST, no standalone SSE stream), so
 * a server→client request is deliverable only while it can be attached to an in-flight
 * request's own stream - which `sendRequest` does and a bare `server.createMessage` does not.
 */
export async function probeToolInitiatedSampling(
  options: Readonly<{ record: FrameSink; now: () => Date }>,
): Promise<ProbeOutcome> {
  const { record, now } = options;
  const client = fullyCapableClient();
  client.setRequestHandler(CreateMessageRequestSchema, (request) =>
    Promise.resolve(stubCompletion({ echo: lastUserText(request.params.messages) })),
  );
  const server = new McpServer({ name: "reverse-channel-stub", version: "1.0.0" });
  server.registerTool(
    "answer_sidebar_comment",
    {
      title: "Answer a sidebar comment",
      description: "Asks the connected client's model to answer a comment, from inside a tool call.",
      inputSchema: { comment: z.string().min(1) },
    },
    async ({ comment }, extra) => {
      const completion = await extra.sendRequest(
        {
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: comment } }],
            maxTokens: 256,
          },
        },
        CreateMessageResultSchema,
        { timeout: PROBE_TIMEOUT_MS },
      );
      return { content: [{ type: "text", text: JSON.stringify(completion) }] };
    },
  );
  const connected = await connectInMemory({ client, server, record, now });
  try {
    const called = await client.callTool(
      { name: "answer_sidebar_comment", arguments: { comment: "Slide 3 is too wordy." } },
      undefined,
      { timeout: PROBE_TIMEOUT_MS },
    );
    return {
      name: "tool-initiated-sampling",
      verdict: "works",
      detail: `tool call nested a sampling/createMessage and returned ${JSON.stringify(called.content)}`,
    };
  } catch (cause: unknown) {
    return { name: "tool-initiated-sampling", verdict: "blocked", detail: describe(cause) };
  } finally {
    await connected.close();
  }
}

/**
 * Probe 6. Resource subscriptions: can the server make the client re-read something? Two
 * halves - the client's `resources/subscribe` against the real server, and the real server's
 * own `notifications/resources/updated` path.
 */
export async function probeResourceSubscription(
  options: Readonly<{ record: FrameSink; now: () => Date }>,
): Promise<ProbeOutcome> {
  const { record, now } = options;
  const client = fullyCapableClient();
  const updates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    updates.push(notification.params.uri);
    return Promise.resolve();
  });
  const server = probeSashaSlidesServer();
  const connected = await connectInMemory({ client, server, record, now });
  const reasons: string[] = [];
  try {
    try {
      await client.subscribeResource({ uri: "sasha://proposal/latest" }, { timeout: PROBE_TIMEOUT_MS });
      reasons.push("resources/subscribe accepted");
    } catch (cause: unknown) {
      reasons.push(`resources/subscribe refused: ${describe(cause)}`);
    }
    try {
      await server.server.sendResourceUpdated({ uri: "sasha://proposal/latest" });
      reasons.push(`notifications/resources/updated sent; client saw ${String(updates.length)}`);
    } catch (cause: unknown) {
      reasons.push(`notifications/resources/updated refused: ${describe(cause)}`);
    }
    return {
      name: "resource-subscription",
      verdict: updates.length > 0 ? "works" : "blocked",
      detail: reasons.join("; "),
    };
  } finally {
    await connected.close();
  }
}

export function formatProbeReport(report: ProbeReport): readonly string[] {
  const lines = [`${String(report.frameCount)} JSON-RPC frames recorded`, ""];
  for (const outcome of report.outcomes) {
    lines.push(`${verdictLabel(outcome.verdict)}  ${outcome.name}`, `      ${outcome.detail}`, "");
  }
  for (const handshake of report.handshakes) {
    lines.push(
      `handshake  ${handshake.clientInfo.name} ${handshake.clientInfo.version} ` +
        `protocol=${handshake.protocolVersion} sampling=${String(handshake.supportsSampling)} ` +
        `elicitation=${String(handshake.supportsElicitation)} roots=${String(handshake.supportsRoots)}`,
    );
  }
  return lines;
}

function verdictLabel(verdict: ProbeVerdict): string {
  switch (verdict) {
    case "works":
      return "WORKS  ";
    case "blocked":
      return "BLOCKED";
    default:
      return assertNever(verdict);
  }
}

/** A request the far end initiated: it carries both a `method` and an `id`. */
function isIncomingRequest(frame: RecordedFrame): boolean {
  return frame.direction === "incoming" && "method" in frame.message && "id" in frame.message;
}

/** Declares every server→client capability, so only the server's own limits can refuse one. */
function fullyCapableClient(): Client {
  return new Client(
    { name: PROBE_CLIENT_NAME, version: PROBE_CLIENT_VERSION },
    { capabilities: { sampling: {}, elicitation: { form: {}, url: {} }, roots: { listChanged: true } } },
  );
}

/**
 * The real tool surface with a resolver that never touches Google: the probe is about the
 * transport and the capability negotiation, not about Drive.
 */
function probeSashaSlidesServer(): McpServer {
  return createSashaSlidesServer({
    resolveEnvironment: () =>
      Promise.resolve({ kind: "auth-failed", message: "probe: no Drive is wired to this server" }),
    resolveFeedbackEnvironment: () =>
      Promise.resolve({ kind: "auth-failed", message: "probe: no comment channel is wired to this server" }),
    // This probe is about capability negotiation; the real instructions are measured in
    // `connector-guidance-probe.ts`.
    instructions: "probe: instructions are measured by connector-guidance-probe.ts",
  });
}

type ConnectedPair = Readonly<{ close: () => Promise<void> }>;

async function connectInMemory(
  options: Readonly<{ client: Client; server: McpServer; record: FrameSink; now: () => Date }>,
): Promise<ConnectedPair> {
  const { client, server, record, now } = options;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(new RecordingTransport({ inner: serverSide, endpoint: "server", now, record }));
  await client.connect(new RecordingTransport({ inner: clientSide, endpoint: "probe-client", now, record }));
  return {
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Resolves after `windowMs`, so the caller can ask what the server did while nothing happened. */
function idleFor(options: Readonly<{ windowMs: number }>): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, options.windowMs));
}

/** The prompt text a sampling request carries, for an echo the frame log can be read against. */
function lastUserText(messages: CreateMessageRequest["params"]["messages"]): string {
  const last = messages[messages.length - 1];
  if (last === undefined) return "";
  const { content } = last;
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join(" ");
}

function stubCompletion(options: Readonly<{ echo: string }>): CreateMessageResult {
  return {
    model: "probe-stub-model",
    role: "assistant",
    stopReason: "endTurn",
    content: { type: "text", text: `stub answered: ${options.echo}` },
  };
}

function stubElicitAccept(): ElicitResult {
  return { action: "accept", content: { comment: "make slide 3 three bullets" } };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function main(): Promise<void> {
  const outDir = outDirFromArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const framesPath = join(outDir, "frames.jsonl");
  writeFileSync(framesPath, "", "utf8");
  const pending: Promise<void>[] = [];
  const report = await runReverseChannelProbe({
    repoRoot: process.cwd(),
    now: () => new Date(),
    record: (frame) => void pending.push(appendFile(framesPath, formatFrameLine(frame), "utf8")),
  });
  await Promise.all(pending);
  for (const line of formatProbeReport(report)) process.stdout.write(`${line}\n`);
  process.stdout.write(`\nframes: ${framesPath}\n`);
}

function outDirFromArgs(args: readonly string[]): string {
  const at = args.indexOf("--out");
  const value = at === -1 ? undefined : args[at + 1];
  return value ?? join(process.cwd(), "mcp/sasha-slides/e2e/.work/reverse-channel");
}

void main();

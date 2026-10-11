#!/usr/bin/env node
/**
 * A minimal MCP server whose only job is to issue a server→client request to whatever real
 * client connects to it, and to write down what came back.
 *
 *   npx tsx mcp/sasha-slides/e2e/elicitation-probe-server.ts --log <path>
 *
 * `reverse-channel-probe.ts` proves the SDK's plumbing with a stub client on both ends. This
 * file is the other half: the client is real (Claude Code, Claude Desktop, anything that speaks
 * MCP), so what it answers is evidence about the *product*, not about the SDK.
 *
 * Three tools, one per candidate reverse channel, each issuing its request from inside the tool
 * call via `extra.sendRequest` - the only shape that is deliverable on Streamable HTTP in the
 * stateless mode `http/http-server.ts` uses, since the reply rides the originating request's
 * own stream rather than a standalone one.
 *
 * Every frame crossing the connection is appended to `--log`, including the client's raw
 * `initialize` params, so the capability negotiation and its consequence sit in one file.
 *
 * stdout belongs to the stdio transport: diagnostics go to stderr, always.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CreateMessageResultSchema,
  ElicitResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { handshakeRecordingTransport } from "../client-handshake.ts";
import { formatFrameLine, type FrameSink } from "../jsonrpc-recording-transport.ts";

export const PROBE_SERVER_NAME = "reverse-channel-probe-server";
export const PROBE_SERVER_VERSION = "1.0.0";
/** A real client may put a dialog in front of a human; still short enough to fail fast. */
export const PROBE_REQUEST_TIMEOUT_MS = 20_000;

export function createElicitationProbeServer(): McpServer {
  const server = new McpServer({ name: PROBE_SERVER_NAME, version: PROBE_SERVER_VERSION });

  server.registerTool(
    "probe_elicitation_form",
    {
      title: "Probe form elicitation",
      description:
        "Diagnostic. Issues one elicitation/create in form mode back to the connecting client " +
        "and reports verbatim what it answered. Call this when asked to probe elicitation.",
      inputSchema: { question: z.string().min(1).describe("The question to put to the user.") },
    },
    async ({ question }, extra) =>
      reportOutcome(
        await attempt(() =>
          extra.sendRequest(
            {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: question,
                requestedSchema: {
                  type: "object",
                  properties: { answer: { type: "string", description: "The user's answer." } },
                  required: ["answer"],
                },
              },
            },
            ElicitResultSchema,
            { timeout: PROBE_REQUEST_TIMEOUT_MS },
          ),
        ),
      ),
  );

  server.registerTool(
    "probe_elicitation_url",
    {
      title: "Probe URL elicitation",
      description:
        "Diagnostic. Issues one elicitation/create in url mode back to the connecting client - " +
        "the mode that would hand the user our own sidebar UI - and reports what it answered.",
      inputSchema: { url: z.string().min(1).describe("The URL the client should open.") },
    },
    async ({ url }, extra) =>
      reportOutcome(
        await attempt(() =>
          extra.sendRequest(
            {
              method: "elicitation/create",
              params: {
                mode: "url",
                message: "Answer the comment in the sidebar, then come back.",
                elicitationId: "probe-elicitation-1",
                url,
              },
            },
            ElicitResultSchema,
            { timeout: PROBE_REQUEST_TIMEOUT_MS },
          ),
        ),
      ),
  );

  server.registerTool(
    "probe_sampling",
    {
      title: "Probe sampling",
      description:
        "Diagnostic. Issues one sampling/createMessage back to the connecting client and " +
        "reports verbatim what it answered. Call this when asked to probe sampling.",
      inputSchema: { prompt: z.string().min(1).describe("The prompt to send for completion.") },
    },
    async ({ prompt }, extra) =>
      reportOutcome(
        await attempt(() =>
          extra.sendRequest(
            {
              method: "sampling/createMessage",
              params: {
                messages: [{ role: "user", content: { type: "text", text: prompt } }],
                maxTokens: 256,
              },
            },
            CreateMessageResultSchema,
            { timeout: PROBE_REQUEST_TIMEOUT_MS },
          ),
        ),
      ),
  );

  server.registerTool(
    "probe_block",
    {
      title: "Probe a blocking tool call",
      description:
        "Diagnostic. Blocks for the requested number of seconds and then returns, optionally " +
        "sending a progress notification on an interval. Characterises how long a client lets " +
        "a long-poll tool (like await_pick) hold a tool call open.",
      inputSchema: {
        seconds: z.number().int().min(1).max(3600).describe("How long to block before returning."),
        progressEverySeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .describe("Progress notification interval; 0 to stay completely silent."),
      },
    },
    async ({ seconds, progressEverySeconds }, extra) => {
      const startedAtMs = Date.now();
      const progressToken = extra._meta?.progressToken;
      let sent = 0;
      while (Date.now() - startedAtMs < seconds * 1000) {
        const sliceMs =
          progressEverySeconds === 0
            ? seconds * 1000 - (Date.now() - startedAtMs)
            : Math.min(progressEverySeconds * 1000, seconds * 1000 - (Date.now() - startedAtMs));
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(sliceMs, 0)));
        if (progressEverySeconds === 0 || Date.now() - startedAtMs >= seconds * 1000) break;
        if (progressToken === undefined) continue;
        sent += 1;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: sent, message: `still waiting (${String(sent)})` },
        });
      }
      const heldSeconds = Math.round((Date.now() - startedAtMs) / 100) / 10;
      return {
        content: [
          {
            type: "text",
            text: `BLOCKED_FOR ${String(heldSeconds)}s, progress notifications sent ${String(sent)}`,
          },
        ],
      };
    },
  );

  return server;
}

/** What the connected client did with one server→client request. */
export type ProbeAttempt =
  | Readonly<{ kind: "answered"; result: unknown }>
  | Readonly<{ kind: "refused"; error: string }>;

export function describeAttempt(attempt: ProbeAttempt): string {
  switch (attempt.kind) {
    case "answered":
      return `ANSWERED ${JSON.stringify(attempt.result)}`;
    case "refused":
      return `REFUSED ${attempt.error}`;
    default:
      return assertNeverAttempt(attempt);
  }
}

function assertNeverAttempt(value: never): never {
  throw new Error(`Unhandled probe attempt: ${String(value)}`);
}

async function attempt(send: () => Promise<unknown>): Promise<ProbeAttempt> {
  try {
    return { kind: "answered", result: await send() };
  } catch (cause: unknown) {
    return {
      kind: "refused",
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    };
  }
}

/** The outcome is the tool's *result*, so it also lands in the agent's own transcript. */
function reportOutcome(attempt: ProbeAttempt): CallToolResult {
  const text = describeAttempt(attempt);
  process.stderr.write(`[${PROBE_SERVER_NAME}] ${text}\n`);
  return { content: [{ type: "text", text }] };
}

async function main(): Promise<void> {
  const logPath = logPathFromArgs(process.argv.slice(2));
  if (logPath === null) {
    process.stderr.write(`usage: elicitation-probe-server.ts --log <path>\n`);
    process.exitCode = 2;
    return;
  }
  writeFileSync(logPath, "", "utf8");
  const record: FrameSink = (frame) => appendFileSync(logPath, formatFrameLine(frame), "utf8");
  const server = createElicitationProbeServer();
  await server.connect(
    handshakeRecordingTransport({
      inner: new StdioServerTransport(),
      endpoint: "server",
      now: () => new Date(),
      record,
      emit: (handshake) =>
        void process.stderr.write(
          `[${PROBE_SERVER_NAME}] ${handshake.clientInfo.name} ${handshake.clientInfo.version} ` +
            `sampling=${String(handshake.supportsSampling)} ` +
            `elicitation=${String(handshake.supportsElicitation)} roots=${String(handshake.supportsRoots)}\n`,
        ),
    }),
  );
  process.stderr.write(`[${PROBE_SERVER_NAME}] ready on stdio, logging frames to ${logPath}\n`);
}

function logPathFromArgs(args: readonly string[]): string | null {
  const at = args.indexOf("--log");
  if (at === -1) return null;
  return args[at + 1] ?? null;
}

void main();

/**
 * The real `mcp/sasha-slides/server.ts`, driven over stdio as an MCP client.
 *
 * Argument and reply shapes are taken from the server's registered zod schemas and its
 * exported payload types — `{ slides: [{ path, label }] }`, `timeoutSeconds` (not
 * milliseconds), and a payload delivered as JSON in one text block. `listTools` is
 * checked against the four names before anything is called, so a surface change fails
 * here with both lists printed instead of deep inside a phase.
 *
 * Every reply is untrusted input and goes through the parsers in `protocol-records.ts`.
 * A reply the harness cannot read is a FAIL with the raw text attached, never a default.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import type {
  ImagesReply,
  ProposalSide,
  ProposeOutcome,
  ProposedSlide,
  StateReply,
} from "./proposal-side.ts";
import type { PickReply } from "./protocol-records.ts";
import { parsePickReply } from "./protocol-records.ts";

export const TOOL_NAMES = ["propose_slides", "await_pick", "slide_images", "proposal_state"] as const;

export type McpSideOpen =
  | Readonly<{ kind: "ready"; side: ProposalSide; tools: readonly string[] }>
  | Readonly<{ kind: "absent"; reason: string }>;

export async function openMcpProposalSide(
  options: Readonly<{ serverPath: string; repoRoot: string; startupTimeoutMs: number }>,
): Promise<McpSideOpen> {
  if (!existsSync(options.serverPath)) {
    return { kind: "absent", reason: `${options.serverPath} does not exist yet (owned by the server stream)` };
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", options.serverPath, "--stdio"],
    cwd: options.repoRoot,
    stderr: "inherit",
  });
  const client = new Client({ name: "sasha-slides-e2e", version: "1.0.0" });

  try {
    await withTimeout({
      work: client.connect(transport),
      timeoutMs: options.startupTimeoutMs,
      label: "mcp connect",
    });
  } catch (cause) {
    await transport.close().catch(() => undefined);
    return { kind: "absent", reason: `could not start the server: ${describe(cause)}` };
  }

  const listed = await client.listTools();
  const tools = listed.tools.map((tool) => tool.name);
  const missing = TOOL_NAMES.filter((name) => !tools.includes(name));
  if (missing.length > 0) {
    await client.close();
    return { kind: "absent", reason: `server is missing tools: ${missing.join(", ")} (has ${tools.join(", ")})` };
  }

  return { kind: "ready", tools, side: mcpSide({ client }) };
}

function mcpSide(options: Readonly<{ client: Client }>): ProposalSide {
  const { client } = options;

  return {
    describe: "mcp server over stdio",

    async propose({ htmlPaths, labels, presentationId }) {
      // Paths in, ids out. The HTML bytes never cross this boundary. `presentationId` is
      // omitted rather than sent as null, because the server's schema is `z.string().optional()`.
      const reply = await callTool({
        client,
        name: "propose_slides",
        args: {
          slides: htmlPaths.map((path, position) => ({ path, label: labels[position] ?? "" })),
          ...(presentationId === null ? {} : { presentationId }),
        },
        timeoutMs: 120_000,
      });
      const json = requireObject({ reply, tool: "propose_slides" });
      const proposalId = requireString({ json, key: "proposalId", tool: "propose_slides" });
      const count = json["count"];
      if (typeof count !== "number") {
        throw new Error(`propose_slides reply has no numeric "count": ${reply.text}`);
      }
      return {
        proposalId,
        count,
        slides: narrowProposedSlides({ value: json["slides"], raw: reply.text }),
        folderId: optionalString(json["folderId"]),
        manifestFileId: optionalString(json["manifestFileId"]),
      } satisfies ProposeOutcome;
    },

    async awaitPick({ proposalId, timeoutSeconds }) {
      const reply = await callTool({
        client,
        name: "await_pick",
        args: { proposalId, timeoutSeconds },
        timeoutMs: timeoutSeconds * 1000 + 15_000,
      });
      const parsed = parsePickReply(reply.text);
      if (parsed.kind === "invalid") {
        throw new Error(`await_pick did not return an await_pick payload — ${parsed.reason}: ${reply.text}`);
      }
      return parsed.value satisfies PickReply;
    },

    async state({ proposalId }) {
      const reply = await callTool({ client, name: "proposal_state", args: { proposalId }, timeoutMs: 30_000 });
      const json = requireObject({ reply, tool: "proposal_state" });
      return {
        kind: "ok",
        summary:
          `exists=${String(json["exists"])} ready=${String(json["ready"])} pick=${String(json["pick"])} ` +
          `slideFiles=${String(json["slideFileCount"])} manifest=${String(json["manifestStatus"])}`,
        raw: reply.text,
      } satisfies StateReply;
    },

    async images({ proposalId, outDir }) {
      const reply = await callTool({
        client,
        name: "slide_images",
        args: { proposalId, outDir },
        timeoutMs: 120_000,
      });
      const json = requireObject({ reply, tool: "slide_images" });
      const status = json["status"];
      if (status === "unavailable") {
        const note = json["note"];
        return { kind: "unavailable", reason: typeof note === "string" ? note : "no note given" };
      }
      if (status !== "ok") {
        throw new Error(`slide_images returned status ${JSON.stringify(status)}: ${reply.text}`);
      }
      const rawFiles = json["files"];
      if (!Array.isArray(rawFiles)) throw new Error(`slide_images reply has no files array: ${reply.text}`);
      const files: Readonly<{ index: number; path: string }>[] = [];
      for (const entry of rawFiles) {
        const record = asRecord(entry);
        const index = record === null ? null : record["index"];
        const path = record === null ? null : record["path"];
        if (typeof index !== "number" || typeof path !== "string") {
          throw new Error(`slide_images returned a malformed file entry: ${reply.text}`);
        }
        files.push({ index, path });
      }
      return { kind: "ok", files } satisfies ImagesReply;
    },

    async close() {
      await client.close();
    },
  };
}

type RawReply = Readonly<{ text: string; structured: Readonly<Record<string, unknown>> | null }>;

async function callTool(
  options: Readonly<{
    client: Client;
    name: string;
    args: Readonly<Record<string, unknown>>;
    timeoutMs: number;
  }>,
): Promise<RawReply> {
  const result = await withTimeout({
    work: options.client.callTool({ name: options.name, arguments: { ...options.args } }),
    timeoutMs: options.timeoutMs,
    label: options.name,
  });

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => {
      const record = asRecord(block);
      const blockText = record === null ? null : record["text"];
      return typeof blockText === "string" ? blockText : "";
    })
    .join("\n")
    .trim();

  if (result.isError === true) throw new Error(`${options.name} returned isError: ${text || "<no text>"}`);
  return { text, structured: asRecord(result.structuredContent) };
}

function narrowProposedSlides(
  options: Readonly<{ value: unknown; raw: string }>,
): readonly ProposedSlide[] {
  if (!Array.isArray(options.value)) {
    throw new Error(`propose_slides reply has no slides array: ${options.raw}`);
  }
  return options.value.map((entry) => {
    const record = asRecord(entry);
    const index = record === null ? null : record["index"];
    const fileId = record === null ? null : record["fileId"];
    const name = record === null ? null : record["name"];
    if (typeof index !== "number" || typeof fileId !== "string" || typeof name !== "string") {
      throw new Error(`propose_slides returned a malformed slide entry: ${options.raw}`);
    }
    return { index, fileId, name };
  });
}

function requireObject(
  options: Readonly<{ reply: RawReply; tool: string }>,
): Readonly<Record<string, unknown>> {
  if (options.reply.structured !== null) return options.reply.structured;
  const fromText = asRecord(tryParseJson(options.reply.text));
  if (fromText !== null) return fromText;
  throw new Error(
    `${options.tool} replied with neither structuredContent nor a JSON object: ${options.reply.text || "<empty>"}`,
  );
}

function requireString(
  options: Readonly<{ json: Readonly<Record<string, unknown>>; key: string; tool: string }>,
): string {
  const value = options.json[options.key];
  if (typeof value !== "string") {
    throw new Error(`${options.tool} reply has no string "${options.key}": ${JSON.stringify(options.json)}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * A bounded wait around every call. Without it a server that hangs on a tool turns into a
 * watchdog kill with no evidence, instead of a FAIL naming the tool that never answered.
 */
async function withTimeout<TValue>(
  options: Readonly<{ work: Promise<TValue>; timeoutMs: number; label: string }>,
): Promise<TValue> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      options.work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${options.label} did not answer within ${options.timeoutMs}ms`)),
          options.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

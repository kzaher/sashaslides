#!/usr/bin/env npx tsx
/**
 * One tool call against the real connector, from the shell.
 *
 * The E2E is driven step by step because every shell command here has to finish inside the
 * command budget, and each step is its own conclusion with its own evidence. This is the
 * non-blocking half of that: staging a proposal, asking what state it is in, revising a
 * candidate. The BLOCKING half (`await_feedback`) belongs to `sasha-listener.ts`, which is a
 * long-lived session rather than a command.
 *
 * It attaches over `--stdio` exactly as Claude Code would, so what it exercises is the real
 * registered tool, not a function call into the module.
 *
 *   npx tsx mcp/sasha-slides/e2e/sasha-call.ts proposal_state '{"proposalId":"p_…"}'
 *   npx tsx mcp/sasha-slides/e2e/sasha-call.ts --list
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);

/** Text blocks printed as-is, the JSON payload pretty-printed: both are evidence. */
function printResult(result: unknown): void {
  const content = (result as { content?: readonly { type?: string; text?: string }[] }).content ?? [];
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      console.log(JSON.stringify(JSON.parse(block.text), null, 2));
    } catch {
      console.log(block.text);
    }
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "/workspaces/sashaslides/mcp/sasha-slides/server.ts", "--stdio"],
  });
  const client = new Client({ name: "sasha-call", version: "1" }, { capabilities: {} });
  await client.connect(transport);

  if (argv.length === 0 || argv[0] === "--list") {
    for (const tool of (await client.listTools()).tools) console.log(`${tool.name}\t${tool.title ?? ""}`);
    await client.close();
    return;
  }

  const name = argv[0] ?? "";
  const raw = argv[1] ?? "{}";
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("arguments must be a JSON object");
    args = parsed as Record<string, unknown>;
  } catch (cause) {
    console.error(`bad arguments JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    await client.close();
    process.exitCode = 1;
    return;
  }

  // A generous timeout with progress reset: some tools (propose_slides) upload several files,
  // and the SDK's 60 s default is about a request, not about Drive.
  printResult(
    await client.callTool({ name, arguments: args }, undefined, {
      onprogress: ({ message }) => console.error(`  …${message ?? "progress"}`),
      resetTimeoutOnProgress: true,
      timeout: 120_000,
      maxTotalTimeout: 600_000,
    }),
  );
  await client.close();
}
void main();

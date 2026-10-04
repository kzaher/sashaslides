#!/usr/bin/env node
/**
 * A diagnostic MCP server that exists to answer one question: when a user types
 * `/mcp__<server>__<prompt> some words here`, what does the client actually put in the
 * `prompts/get` `arguments`?
 *
 *   PROMPT_ARGUMENT_LOG=/tmp/args.jsonl npx tsx mcp/sasha-slides/e2e/prompt-argument-probe-server.ts
 *
 * It registers three prompts - one declared argument, two, and none - and appends the raw
 * arguments it received to `PROMPT_ARGUMENT_LOG`, one JSON line per `prompts/get`. The answer
 * cannot be read off either endpoint's API: `registerPrompt` sees the *parsed* arguments, so
 * the mapping the client chose is only visible by logging what arrived.
 *
 * Driven by `connector-guidance-probe.ts --probe prompt-arguments`. Measured against real
 * Claude Code 2.1.285: it splits the typed text on whitespace and binds the words positionally
 * to the declared arguments in declaration order, discarding anything past the last one. That
 * is why every prompt in `workflow-prompts.ts` declares exactly one argument.
 *
 * Each prompt echoes the arguments back as its message text as well, so the same run also
 * shows whether the template reaches the model at all.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";

export const PROMPT_ARGUMENT_LOG_ENV = "PROMPT_ARGUMENT_LOG";

/** One line per `prompts/get`, so a run can be tailed and diffed. */
export type ReceivedPromptArguments = Readonly<{ name: string; arguments: Readonly<Record<string, string>> }>;

export function createPromptArgumentProbeServer(
  options: Readonly<{ record: (received: ReceivedPromptArguments) => void }>,
): McpServer {
  const { record } = options;
  const server = new McpServer({ name: "prompt-argument-probe", version: "1.0.0" });

  const echo = (name: string, received: Readonly<Record<string, string>>): GetPromptResult => {
    record({ name, arguments: received });
    return {
      messages: [
        { role: "user", content: { type: "text", text: `${name} received ${JSON.stringify(received)}` } },
      ],
    };
  };

  server.registerPrompt(
    "one_arg",
    { title: "One declared argument", description: "Declares a single argument.", argsSchema: { only: z.string() } },
    (args) => echo("one_arg", { only: args.only }),
  );
  server.registerPrompt(
    "two_args",
    {
      title: "Two declared arguments",
      description: "Declares two arguments, the second optional.",
      argsSchema: { first: z.string(), second: z.string().optional() },
    },
    (args) => echo("two_args", args.second === undefined ? { first: args.first } : { first: args.first, second: args.second }),
  );
  server.registerPrompt(
    "no_args",
    { title: "No declared arguments", description: "Declares no arguments at all." },
    () => echo("no_args", {}),
  );

  return server;
}

/** One JSON line per received `prompts/get`, appended. */
export function appendReceivedPromptArguments(
  options: Readonly<{ path: string; received: ReceivedPromptArguments }>,
): void {
  appendFileSync(options.path, `${JSON.stringify(options.received)}\n`, "utf8");
}

async function main(): Promise<void> {
  const logPath = process.env[PROMPT_ARGUMENT_LOG_ENV];
  if (logPath === undefined) {
    process.stderr.write(`${PROMPT_ARGUMENT_LOG_ENV} must name the file to append received arguments to\n`);
    process.exitCode = 2;
    return;
  }
  const server = createPromptArgumentProbeServer({
    record: (received) => appendReceivedPromptArguments({ path: logPath, received }),
  });
  await server.connect(new StdioServerTransport());
}

/** Guards against a test import starting a server on the test runner's stdio. */
function invokedAsEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && /prompt-argument-probe-server\.(?:ts|js|mjs|cjs)$/.test(entry);
}

if (invokedAsEntryPoint()) void main();

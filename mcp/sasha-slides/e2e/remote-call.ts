#!/usr/bin/env npx tsx
/**
 * Calls one tool on a REMOTE connector as a signed-in user and prints the result text.
 *
 *   npx tsx mcp/sasha-slides/e2e/brokered-signin-live.ts --base https://sashaslides.com --token-out /tmp/t
 *   npx tsx mcp/sasha-slides/e2e/remote-call.ts --base https://sashaslides.com --token /tmp/t open_work '{}'
 *
 * Exits 1 when the call is an error, so a shell loop can stop on the first failure.
 */
import { readFileSync } from "node:fs";

export type RemoteResult = Readonly<{ isError: boolean; text: string }>;

export async function callRemoteTool(
  options: Readonly<{ base: string; token: string; name: string; args: Readonly<Record<string, unknown>> }>,
): Promise<RemoteResult> {
  const reply = await fetch(`${options.base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: options.name, arguments: options.args } }),
  });
  const body = await reply.text();
  // Streamable HTTP answers either plain JSON or one SSE `data:` line holding it.
  const json = body.split("\n").map((line) => line.replace(/^data: /, "")).find((line) => line.startsWith("{"));
  if (reply.status !== 200 || json === undefined) return { isError: true, text: `HTTP ${String(reply.status)}: ${body.slice(0, 300)}` };
  const parsed = JSON.parse(json) as {
    result?: { isError?: boolean; content?: { type: string; text?: string }[] };
    error?: { message: string };
  };
  if (parsed.error !== undefined) return { isError: true, text: parsed.error.message };
  const text = (parsed.result?.content ?? []).map((part) => part.text ?? `[${part.type}]`).join("\n");
  return { isError: parsed.result?.isError === true, text };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv.splice(at, 2)[1] : undefined;
  };
  const base = option("--base") ?? "https://sashaslides.com";
  const tokenPath = option("--token");
  const [name, args] = argv;
  if (tokenPath === undefined || name === undefined) throw new Error("usage: remote-call.ts --token <file> <tool> '<json>'");
  const result = await callRemoteTool({
    base,
    token: readFileSync(tokenPath, "utf8").trim(),
    name,
    args: JSON.parse(args ?? "{}") as Record<string, unknown>,
  });
  console.log(result.text);
  process.exitCode = result.isError ? 1 : 0;
}

if ((process.argv[1] ?? "").endsWith("remote-call.ts")) void main();

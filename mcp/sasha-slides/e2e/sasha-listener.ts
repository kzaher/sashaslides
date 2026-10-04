#!/usr/bin/env npx tsx
/**
 * A real Sasha: a Model Context Protocol client that attaches to the connector, waits for the
 * user's comments on a candidate, and answers them.
 *
 * This is what the product means by "Sasha" — not a service, but a session parked inside a
 * blocking `await_feedback` call. Run it while driving the add-on in a browser and the round
 * trip is observable from both ends.
 *
 *   npx tsx mcp/sasha-slides/e2e/sasha-listener.ts --proposal p_… --slide 2 --rounds 2
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const PROPOSAL = option("--proposal") ?? "";
const SLIDE = Number(option("--slide") ?? 2);
const ROUNDS = Number(option("--rounds") ?? 1);
const TIMEOUT_MS = Number(option("--timeout") ?? 240_000);

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Tool replies arrive as content blocks; the JSON payload is the first text block. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: readonly { type?: string; text?: string }[] }).content ?? [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
      } catch {
        // a human-readable block, not the payload
      }
    }
  }
  return {};
}

async function main(): Promise<void> {
  if (PROPOSAL === "") {
    console.error("need --proposal <proposalId>");
    process.exitCode = 1;
    return;
  }
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "/workspaces/sashaslides/mcp/sasha-slides/server.ts", "--stdio"],
  });
  const client = new Client({ name: "sasha-listener", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(`${stamp()}  attached. tools: ${tools.join(", ")}`);
  console.log(`${stamp()}  waiting on candidate ${SLIDE} of ${PROPOSAL} (up to ${TIMEOUT_MS / 1000}s)...`);

  for (let round = 1; round <= ROUNDS; round += 1) {
    const waited = payloadOf(
      await client.callTool(
        {
          name: "await_feedback",
          arguments: { proposalId: PROPOSAL, slideIndex: SLIDE, timeoutMs: TIMEOUT_MS },
        },
        undefined,
        {
          // All three are required for a multi-minute wait. `onprogress` is what makes the
          // SDK mint a progressToken at all (without it the server is told nothing was
          // asked for and stays silent); `resetTimeoutOnProgress` is what makes an arriving
          // notification push the deadline out, and it defaults to FALSE; and `timeout`
          // replaces the SDK's 60 s default, which is what killed the first run of this
          // script with `McpError -32001  data: { timeout: 60000 }`. `maxTotalTimeout`
          // caps the whole thing so a chatty server cannot keep the call alive forever.
          onprogress: ({ progress, total, message }) => {
            const pct = typeof total === "number" && total > 0 ? ` ${String(Math.round((progress / total) * 100))}%` : "";
            console.log(`${stamp()}  ...progress${pct}: ${message ?? ""}`);
          },
          resetTimeoutOnProgress: true,
          timeout: 90_000,
          maxTotalTimeout: TIMEOUT_MS + 60_000,
        },
      ),
    );
    const status = String(waited["status"] ?? "?");
    const posts = Array.isArray(waited["posts"]) ? (waited["posts"] as readonly Record<string, unknown>[]) : [];
    console.log(`${stamp()}  await_feedback -> ${status}, ${posts.length} post(s)`);
    if (status !== "arrived" || posts.length === 0) {
      console.log(`${stamp()}  nothing arrived; stopping`);
      break;
    }

    for (const post of posts) {
      const commentId = String(post["commentId"] ?? post["id"] ?? "");
      const text = String(post["text"] ?? post["content"] ?? "").replace(/\s+/g, " ").slice(0, 110);
      console.log(`${stamp()}  USER SAID: "${text}"`);
      if (commentId === "") continue;
      const answer =
        `Sasha here — I read this. You said: "${text.slice(0, 60)}". ` +
        `Round ${round}: I would redraw candidate ${SLIDE} to address it.`;
      const replied = payloadOf(
        await client.callTool({
          name: "reply_feedback",
          arguments: { proposalId: PROPOSAL, slideIndex: SLIDE, commentId, text: answer },
        }),
      );
      console.log(`${stamp()}  reply_feedback -> ${String(replied["status"] ?? "?")} replyId=${String(replied["replyId"] ?? "-")}`);
    }
  }
  await client.close();
  console.log(`${stamp()}  detached`);
}
void main();

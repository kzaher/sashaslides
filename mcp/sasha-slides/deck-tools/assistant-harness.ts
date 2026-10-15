/**
 * An MCP CLIENT TALKING TO THE DECK TOOLS, the way Claude does: a real `McpServer` with
 * `registerDeckTools`, a real `Client`, joined by the SDK's in-memory transport. The server side of
 * the transport carries a session id, which is what `extra.sessionId` reports to the tools, so
 * each connection is one MCP session -- one agent session -- for the account the test maps it to.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DeckCaller, DeckService } from "../deck-contracts/deck-service-contract.ts";
import { agentSessionIdFor } from "./agent-session.ts";
import { registerDeckTools } from "./deck-tools.ts";

export const TEST_PUBLIC_URL = "https://sashaslides.test";

export type ToolAnswer = Readonly<{ isError: boolean; text: string }>;

export type AssistantConnection = Readonly<{
  sessionId: string;
  call: (name: string, input: Readonly<Record<string, unknown>>, onProgress?: (progress: Readonly<{ progress: number; total?: number | undefined }>) => void) => Promise<ToolAnswer>;
  /** `call`, then the answer's text parsed (the tools answer JSON). */
  read: (name: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  listToolNames: () => Promise<readonly string[]>;
  close: () => Promise<void>;
}>;

export async function connectAssistant(
  options: Readonly<{ service: DeckService | null; sessionId: string; caller: DeckCaller | null; fetch?: typeof fetch; now?: () => number }>,
): Promise<AssistantConnection> {
  const server = new McpServer({ name: "deck-tools-test", version: "0.0.0" });
  registerDeckTools({
    server,
    deckService: options.service,
    callerFor: ({ sessionId }) =>
      Promise.resolve(
        options.caller === null || sessionId === undefined
          ? { kind: "unavailable", message: "unavailable: sign in to the remote connector to use decks" }
          : { kind: "ok", caller: options.caller, agentSessionId: agentSessionIdFor(sessionId) },
      ),
    publicUrl: TEST_PUBLIC_URL,
    fetch: options.fetch ?? (() => Promise.reject(new Error("no network in tests"))),
    now: options.now ?? Date.now,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = options.sessionId;
  await server.connect(serverTransport);
  const client = new Client({ name: "deck-tools-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const call: AssistantConnection["call"] = async (name, input, onProgress) => {
    const result = await client.callTool({ name, arguments: { ...input } }, undefined, onProgress === undefined ? {} : { onprogress: onProgress, resetTimeoutOnProgress: true });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((part: unknown) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
    return { isError: result.isError === true, text };
  };
  return {
    sessionId: options.sessionId,
    call,
    read: async (name, input) => {
      const answer = await call(name, input);
      try {
        return JSON.parse(answer.text) as unknown;
      } catch {
        // Not JSON: a refusal sentence. Hand it back as text so the assertion shows it.
        return answer.text;
      }
    },
    listToolNames: async () => (await client.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

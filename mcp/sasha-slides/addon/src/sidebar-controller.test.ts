// ASK SASHA'S BOOT, against a fake server: which `google.script.run` calls go out, and in what
// order, before any of them has answered. That ordering IS the opening time -- each call costs
// ~0.7 s of fixed overhead plus its own work, so a call that waits for another adds both.

import assert from "node:assert/strict";
import test from "node:test";
import type { ServerCall } from "./bridge-client.ts";
import type { CallOutcome } from "./bridge.ts";
import { startSidebar, type SidebarController, type SidebarView } from "./sidebar-controller.ts";

const DECK = "deck_0123456789";
const HELLO = { protocolVersion: 1, presentationUrl: `https://docs.google.com/open?id=${DECK}` };
const READ_AT = "2026-10-04T12:00:00.000Z";
const MARK = {
  proposalId: "p_1791115140000_boot01",
  folderId: "folder_1",
  readyFileId: "ready_1",
  pickFileId: null,
  createdTime: "2026-10-04T11:59:00.000Z",
  manifestFileId: "manifest_1",
};

type Invocation = Readonly<{ name: string; spec: unknown }>;

/**
 * A server that records every call and answers only when told to. The runner is a Proxy because
 * the client reaches it only through `invoke(runner)`, and a recorder for every method name is the
 * point.
 */
function fakeServer(): Readonly<{
  call: ServerCall;
  invoked: Invocation[];
  answer: (name: string, value: unknown) => void;
}> {
  const invoked: Invocation[] = [];
  const pending = new Map<string, ((outcome: CallOutcome<unknown>) => void)[]>();
  const call: ServerCall = <TReply>({ invoke }: Parameters<ServerCall>[0]) =>
    new Promise<CallOutcome<TReply>>((resolve) => {
      const runner: object = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "withSuccessHandler" || property === "withFailureHandler") return () => runner;
            return (spec: unknown) => {
              const name = String(property);
              invoked.push({ name, spec });
              // SAFETY: a fake reply is handed to the same bridge.ts parser a real one is, which is
              // what `TReply` stands for here (bridge-client.ts parses every `unknown` it gets).
              const settle = (outcome: CallOutcome<unknown>): void => resolve(outcome as CallOutcome<TReply>);
              pending.set(name, [...(pending.get(name) ?? []), settle]);
            };
          },
        },
      );
      // SAFETY: every method the client calls on the runner is answered by the Proxy above; the
      // test asserts on the recorded names, so a call to anything unexpected is visible there.
      invoke(runner as AppsScriptRunner);
    });
  return {
    call,
    invoked,
    answer(name, value) {
      const waiting = pending.get(name) ?? [];
      pending.delete(name);
      for (const settle of waiting) settle({ kind: "ok", value });
    },
  };
}

function seedText(): string {
  const remembered = (value: unknown): unknown => ({ presentationId: DECK, readAt: READ_AT, value });
  return JSON.stringify({
    hello: HELLO,
    remembered: {
      scan: remembered({ marks: [MARK] }),
      log: remembered({ folderId: "folder_1", events: [] }),
    },
  });
}

function start({ call, text }: { call: ServerCall; text: string | null }): Readonly<{ controller: SidebarController; views: SidebarView[] }> {
  const views: SidebarView[] = [];
  const controller = startSidebar({
    call,
    render: (view) => views.push(view),
    isVisible: () => true,
    onVisibilityChange: () => {},
    seedText: text,
  });
  return { controller, views };
}

function namesOf(invoked: readonly Invocation[]): readonly string[] {
  return invoked.map((entry) => entry.name);
}

test("A SEEDED BOOT asks for no sashaHello and starts the scan AND the log read together", async () => {
  const server = fakeServer();
  const { controller, views } = start({ call: server.call, text: seedText() });
  try {
    await controller.started;
    // Nothing has answered yet, and both reads are already out.
    const names = namesOf(server.invoked);
    assert.ok(!names.includes("sashaHello"), names.join(", "));
    assert.ok(names.includes("sashaScanInbox"), names.join(", "));
    assert.ok(names.includes("sashaReadEvents"), names.join(", "));
    // The manifest is read at once too (the seed had none), in the same pump -- and the scan
    // goes out FIRST, ahead of everything a nested pump pass used to send before it.
    assert.ok(names.includes("sashaReadTexts"), names.join(", "));
    assert.equal(names[0], "sashaScanInbox", names.join(", "));
    // The first paint is already the seeded set, not a spinner.
    const first = views[0]?.conversation;
    assert.equal(first?.set.kind === "following" ? first.set.proposalId : null, MARK.proposalId);
    // Each read asks Code.gs to remember its answer for the next open.
    for (const entry of server.invoked) {
      if (entry.name === "sashaScanInbox" || entry.name === "sashaReadEvents") {
        const spec = entry.spec;
        const flag = typeof spec === "object" && spec !== null && "rememberForSidebar" in spec ? spec.rememberForSidebar : undefined;
        assert.equal(flag, true, entry.name);
      }
    }
    const manifestRead = server.invoked.find((entry) => entry.name === "sashaReadTexts");
    assert.deepEqual(manifestRead?.spec, { fileIds: ["ready_1", "manifest_1"], rememberForSidebar: { forEventId: null } });
  } finally {
    controller.stop();
  }
});

test("AN UNSEEDED BOOT scans in parallel with sashaHello, and reads the log only once the scan names a set", async () => {
  const server = fakeServer();
  const { controller } = start({ call: server.call, text: null });
  try {
    assert.deepEqual(namesOf(server.invoked), ["sashaScanInbox", "sashaHello"]);
    server.answer("sashaHello", HELLO);
    await controller.started;
    assert.deepEqual(namesOf(server.invoked), ["sashaScanInbox", "sashaHello"], "the early scan is consumed, not repeated");
    server.answer("sashaScanInbox", { marks: [MARK] });
    await new Promise((resolve) => setImmediate(resolve));
    const after = namesOf(server.invoked).slice(2);
    assert.ok(after.includes("sashaReadEvents"), after.join(", "));
    assert.ok(after.includes("sashaReadTexts"), after.join(", "));
  } finally {
    controller.stop();
  }
});

test("a seed from another deck is not drawn, but its hello still saves the round trip", async () => {
  const server = fakeServer();
  const text = seedText().split(`"presentationId":"${DECK}"`).join('"presentationId":"deck_9876543210"');
  const { controller, views } = start({ call: server.call, text });
  try {
    await controller.started;
    assert.equal(views[0]?.conversation.set.kind, "none");
    assert.deepEqual(namesOf(server.invoked), ["sashaScanInbox"]);
  } finally {
    controller.stop();
  }
});

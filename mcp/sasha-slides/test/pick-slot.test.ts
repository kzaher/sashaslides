// THE PICK REACHES A REMOTE CONNECTOR: measured 2026-10-12 on https://sashaslides.com, the user picked
// candidate 1 in the deck ("Inserted option 1. Sasha has been told."), and claude.ai's await_pick kept
// waiting for 7.5 minutes. The add-on creates PICK under its own Apps Script credentials, and the
// connector only has drive.file (it sees files it created) and finds files by its own private
// appProperties, so it can never see that PICK. Fix: staging creates an empty PICK.slot the connector
// owns; the add-on writes the pick into it and renames it to PICK; the connector reads its own file.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { awaitPick, createProposal, readProposalState, type ProposalEnvironment } from "../proposal";
import { createFakeDrive } from "./fake-drive";

const SLIDE = "<!doctype html><h1>Q3 Infrastructure Spend</h1>";

function environment(): Readonly<{ env: ProposalEnvironment; fake: ReturnType<typeof createFakeDrive> }> {
  const fake = createFakeDrive();
  let nowMs = Date.parse("2026-10-12T12:00:00.000Z");
  return {
    fake,
    env: {
      drive: fake.channel,
      now: () => new Date(nowMs),
      randomSuffix: () => "aaa111",
      sleep: ({ milliseconds }) => {
        nowMs += milliseconds;
        return Promise.resolve();
      },
      statFile: () => ({ bytes: 2048 }),
      warn: () => undefined,
    },
  };
}

async function staged(env: ProposalEnvironment): Promise<string> {
  const outcome = await createProposal({
    env,
    slides: [{ html: SLIDE, label: "dark" }, { html: SLIDE, label: "light" }],
    presentationId: "deck-1",
  });
  if (outcome.kind !== "ok") throw new Error(`staging failed: ${outcome.reason}`);
  return outcome.proposalId;
}

const PICK_BODY = (proposalId: string): string =>
  JSON.stringify({
    protocolVersion: 1,
    proposalId,
    picked: 1,
    decidedAt: "2026-10-12T12:05:00.000Z",
    anomalies: [],
    insertedObjectIds: ["obj_1"],
  });

describe("the pick slot", () => {
  test("staging creates an empty PICK.slot the connector owns, before READY", async () => {
    const { env, fake } = environment();
    const proposalId = await staged(env);
    const slot = fake.find({ name: "PICK.slot" });
    assert.ok(slot !== null, "PICK.slot exists");
    assert.deepEqual(slot.appProperties, { sashaSlides: "pick-slot", proposalId });
    assert.equal(slot.text, "");
    const writes = fake.calls().filter((call) => call.op === "createFile").map((call) => call.name);
    assert.ok(writes.indexOf("PICK.slot") < writes.indexOf("READY"), `PICK.slot before READY: ${writes.join(", ")}`);
    assert.equal(fake.find({ name: "PICK" }), null, "no PICK yet: nothing is decided");
  });

  test("an untouched slot is not a decision: await_pick times out and the state says not picked", async () => {
    const { env } = environment();
    const proposalId = await staged(env);
    const waited = await awaitPick({ env, proposalId, timeoutSeconds: 5 });
    assert.equal(waited.kind, "timeout");
    const state = await readProposalState({ env, proposalId });
    assert.equal(state.picked, false);
  });

  test("once the add-on writes the pick into the slot and renames it PICK, await_pick returns it", async () => {
    const { env, fake } = environment();
    const proposalId = await staged(env);
    const slot = fake.find({ name: "PICK.slot" });
    assert.ok(slot !== null);
    fake.editAsAnotherApp({ fileId: slot.id, name: "PICK", text: PICK_BODY(proposalId) });
    const waited = await awaitPick({ env, proposalId, timeoutSeconds: 5 });
    assert.equal(waited.kind, "decided");
    assert.equal(waited.kind === "decided" ? waited.pick.picked : null, 1);
    const state = await readProposalState({ env, proposalId });
    assert.equal(state.picked, true);
  });
});

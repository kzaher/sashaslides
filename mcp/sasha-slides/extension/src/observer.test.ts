// The READY-observer state machine, end to end against a fake Drive: reducer, effect executor,
// Drive calls, poll cadence, backoff and the persisted `seen` set. No network, no Chrome, no timers
// (the timer is injected and fired by hand), so the whole file runs in milliseconds.

import assert from "node:assert/strict";
import test from "node:test";
import { fakeDrive, type FakeDrive } from "./fake-drive.ts";
import { pollDelayMs, type Viewers } from "./observer.ts";
import { createObserver, type Announcer, type Observer, type PollTimer, type SeenStore } from "./observer-runtime.ts";
import type { Proposal } from "./observer.ts";

test("no Slides tab means no polling at all", async () => {
  const harness = await observerHarness();
  await harness.viewers({ count: 0, anyVisible: false });
  assert.equal(harness.drive.files().length, 0);
  assert.equal(harness.timer.pending(), null);
  assert.equal(harness.observer.snapshot().phase.kind, "stopped");
});

test("a visible tab polls at 5 s and a hidden one at 30 s", async () => {
  const harness = await observerHarness();
  await harness.viewers({ count: 1, anyVisible: true });
  assert.equal(harness.timer.pending(), 5_000);
  await harness.viewers({ count: 1, anyVisible: false });
  assert.equal(harness.timer.pending(), 30_000);
});

test("a READY proposal is offered with 1-based slides and the folder it must write PICK into", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_1", count: 3, presentationId: "deck_1" });
  await harness.viewers({ count: 1, anyVisible: true });

  const offered = harness.announced();
  assert.equal(offered.length, 1);
  const proposal = offered[0];
  assert.ok(proposal !== undefined);
  assert.equal(proposal.proposalId, "p_1");
  assert.equal(proposal.count, 3);
  assert.equal(proposal.presentationId, "deck_1");
  assert.equal(proposal.folderId, "folder_p_1");
  assert.deepEqual(
    proposal.slides.map((slide) => slide.index),
    [1, 2, 3],
  );
  assert.equal(harness.observer.snapshot().phase.kind, "offering");
});

test("a manifest with no READY yet is invisible -- READY is the final mark", async () => {
  const harness = await observerHarness();
  harness.drive.put({
    id: "manifest_partial",
    name: "manifest.json",
    createdTime: "2026-10-03T12:00:00.000Z",
    parents: ["folder_partial"],
    appProperties: { sashaSlides: "manifest", proposalId: "p_partial" },
    body: "{}",
  });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
  assert.equal(harness.observer.snapshot().phase.kind, "waiting");
});

test("a proposal that already has a PICK is never offered again", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_answered", count: 2, presentationId: null });
  harness.drive.put({
    id: "pick_answered",
    name: "PICK",
    createdTime: "2026-10-03T12:00:01.000Z",
    parents: ["folder_p_answered"],
    appProperties: { sashaSlides: "pick", proposalId: "p_answered" },
    body: "{}",
  });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
});

test("an unknown protocolVersion is ignored with a warning and never retried", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_future", count: 1, presentationId: null, protocolVersion: 99 });
  await harness.viewers({ count: 1, anyVisible: true });

  assert.deepEqual(harness.announced(), []);
  assert.ok(harness.warnings().some((warning) => warning.includes("protocolVersion 99")));
  assert.deepEqual(await harness.seen.read(), ["p_future"]);

  // The next poll must not reload it: that is what marking it seen is for.
  const callsBefore = harness.warnings().length;
  await harness.tick();
  assert.equal(harness.warnings().length, callsBefore);
});

test("a transport failure backs off, keeps the proposal unanswered, and succeeds on retry", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_flaky", count: 1, presentationId: null });
  harness.drive.failNext(2, "503 from Drive");

  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
  assert.equal(harness.observer.snapshot().consecutiveFailures, 1);
  assert.equal(harness.timer.pending(), 10_000, "5 s doubled once");
  assert.deepEqual(await harness.seen.read(), [], "a transport failure must not mark it answered");

  await harness.tick();
  assert.equal(harness.observer.snapshot().consecutiveFailures, 2);
  assert.ok(harness.troubles().length > 0, "two failures in a row are announced to the user");

  await harness.tick();
  assert.equal(harness.announced().length, 1);
  assert.equal(harness.observer.snapshot().consecutiveFailures, 0);
});

test("resolving an offer persists it and polls again immediately", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_a", count: 1, presentationId: null, createdTime: "2026-10-03T12:00:00.000Z" });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.equal(harness.announced().length, 1);

  harness.drive.stageProposal({ proposalId: "p_b", count: 2, presentationId: null, createdTime: "2026-10-03T12:05:00.000Z" });
  harness.observer.dispatch({ kind: "resolved", proposalId: "p_a", nowMs: 0 });
  await harness.observer.settled();

  assert.deepEqual(await harness.seen.read(), ["p_a"]);
  assert.deepEqual(
    harness.announced().map((proposal) => proposal.proposalId),
    ["p_a", "p_b"],
    "the queued proposal is offered without waiting for the next tick",
  );
});

test("a tab that connects after the offer still hears about it", async () => {
  const harness = await observerHarness();
  harness.drive.stageProposal({ proposalId: "p_1", count: 1, presentationId: null });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.equal(harness.announced().length, 1);

  await harness.viewers({ count: 2, anyVisible: true });
  assert.equal(harness.announced().length, 2, "re-announced, so the new tab can render it");
  assert.equal(harness.announced()[1]?.proposalId, "p_1");
});

test("the restored seen set suppresses a proposal from a previous session", async () => {
  const harness = await observerHarness({ seeded: ["p_old"] });
  harness.drive.stageProposal({ proposalId: "p_old", count: 1, presentationId: null });
  await harness.viewers({ count: 1, anyVisible: true });
  assert.deepEqual(harness.announced(), []);
});

test("pollDelayMs backs off exponentially and is capped", () => {
  const visible: Viewers = { count: 1, anyVisible: true };
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 0 }), 5_000);
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 1 }), 10_000);
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 4 }), 80_000);
  assert.equal(pollDelayMs({ viewers: visible, consecutiveFailures: 40 }), 80_000, "4 doublings is the limit");
  const hidden: Viewers = { count: 1, anyVisible: false };
  assert.equal(pollDelayMs({ viewers: hidden, consecutiveFailures: 0 }), 30_000);
  assert.equal(pollDelayMs({ viewers: hidden, consecutiveFailures: 4 }), 120_000, "capped, not 480 s");
});

type Harness = Readonly<{
  drive: FakeDrive;
  observer: Observer;
  seen: SeenStore;
  timer: Readonly<{ pending(): number | null; fire(): void }>;
  viewers(viewers: Viewers): Promise<void>;
  tick(): Promise<void>;
  announced(): readonly Proposal[];
  troubles(): readonly string[];
  warnings(): readonly string[];
}>;

async function observerHarness({ seeded = [] }: { seeded?: readonly string[] } = {}): Promise<Harness> {
  const drive = fakeDrive();
  const announced: Proposal[] = [];
  const troubles: string[] = [];
  const warnings: string[] = [];
  const announcer: Announcer = {
    proposal(proposal) {
      announced.push(proposal);
    },
    trouble(message) {
      troubles.push(message);
    },
  };

  let scheduled: Readonly<{ delayMs: number; fire: () => void }> | null = null;
  const timer: PollTimer = {
    schedule(spec) {
      scheduled = spec;
    },
    cancel() {
      scheduled = null;
    },
  };

  let persisted: readonly string[] = seeded;
  const seen: SeenStore = {
    async read() {
      return persisted;
    },
    async write(seenProposalIds) {
      persisted = seenProposalIds;
    },
  };

  const observer = createObserver({
    drive: drive.api,
    announcer,
    timer,
    seen,
    log: { warn: (message) => warnings.push(message) },
    nowMs: () => 0,
  });
  await observer.start();

  return {
    drive,
    observer,
    seen,
    timer: {
      pending: () => scheduled?.delayMs ?? null,
      fire: () => scheduled?.fire(),
    },
    async viewers(viewers) {
      observer.dispatch({ kind: "viewers-changed", viewers, nowMs: 0 });
      await observer.settled();
    },
    async tick() {
      const pending = scheduled;
      assert.ok(pending !== null, "expected a poll to be scheduled");
      scheduled = null;
      pending.fire();
      await observer.settled();
    },
    announced: () => announced,
    troubles: () => troubles,
    warnings: () => warnings,
  };
}

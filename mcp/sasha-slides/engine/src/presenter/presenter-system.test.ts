// The assembled system: the clock ticks fast only while deadlines are watched, an exit reaches the
// caller's `onExit` with the slide being shown, and the system never touches the page itself (the
// lifecycle tests drive it entirely through the fake environment).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mintId } from "../contracts/ids.ts";
import { initialShowState } from "./presenter-state.ts";
import { FAST_TICK_MILLISECONDS, SLOW_TICK_MILLISECONDS, tickPeriodOf } from "./presenter-system.ts";
import { builtinTransition, fixtureDocument, scriptedTransition, slideIdOf } from "./testing/document-fixture.ts";
import { presenterHarness } from "./testing/presenter-harness.ts";

describe("presenter system", () => {
  const document = fixtureDocument({ slides: [{ id: "slide_a" }, { id: "slide_b", transition: builtinTransition({ effect: "fade" }) }] });
  const base = initialShowState({ document, startSlideId: slideIdOf("slide_a"), idSeed: { sessionPrefix: "Test0000", counter: 0 }, now: 0, reducedMotion: false });
  const periods = [
    { label: "a still slide ticks slowly", state: base, expected: SLOW_TICK_MILLISECONDS },
    { label: "a loading runner is watched closely", state: { ...base, spareRunner: { kind: "loading" as const, runnerId: mintId({ seed: { sessionPrefix: "Test0000", counter: 0 }, kind: "runner" }).id, since: 0, loadCount: 0 } }, expected: FAST_TICK_MILLISECONDS },
    { label: "after the exit nothing ticks", state: { ...base, exitRequested: true }, expected: null },
  ];
  for (const row of periods) {
    it(`clock: ${row.label}`, () => {
      assert.equal(tickPeriodOf(row.state), row.expected);
    });
  }

  const exits = [
    { keys: ["ArrowRight", "ArrowRight", "Escape"], expected: "slide_b" },
    { keys: ["Escape"], expected: "slide_a" },
    { keys: ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"], expected: "slide_b" },
  ];
  for (const row of exits) {
    it(`${row.keys.join(", ")}: onExit is called once, with ${row.expected}`, async () => {
      const harness = presenterHarness({ slides: [{ id: "slide_a" }, { id: "slide_b", transition: scriptedTransition("script_missing") }] });
      for (const key of row.keys) {
        harness.press(key);
        await harness.advanceBy(10);
      }
      await harness.advanceBy(50);
      assert.deepEqual(harness.exits, [row.expected]);
    });
  }
});

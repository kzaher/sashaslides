import assert from "node:assert/strict";
import test from "node:test";
import { createCallRateLimit, CALLS_PER_MINUTE } from "./call-budget.ts";

/**
 * THE DAY THE QUOTA WENT.
 *
 * A reducer change made every finished read want another one, and `pump` runs after every
 * dispatch -- so each arriving read started the next. The loop ran until Apps Script said
 * "Exception: Service invoked too many times for one day: urlfetch" and the add-on could not
 * read a single comment for the rest of the day (measured in the deployed add-on, 2026-10-04).
 *
 * The reducer bug is fixed, but the DAMAGE was only possible because nothing between the
 * reducer and Google counted. This is that counter: a ceiling no state machine can argue with.
 * It is deliberately far above any legitimate cadence -- the surfaces poll a handful of times a
 * minute -- so it only ever fires on a runaway.
 */
test("ordinary polling is never touched by the ceiling", () => {
  let now = 0;
  const limit = createCallRateLimit({ now: () => now });
  // Four reads every eight seconds for five minutes: the real steady state, with room to spare.
  for (let tick = 0; tick < 38; tick += 1) {
    now += 8_000;
    for (let call = 0; call < 4; call += 1) assert.equal(limit.allow(), true, `tick ${tick}`);
  }
});

test("a runaway is stopped at the ceiling instead of spending the day's quota", () => {
  let now = 0;
  const limit = createCallRateLimit({ now: () => now });
  let allowed = 0;
  // A tight loop: no time passes between calls, which is exactly what the runaway looked like.
  for (let call = 0; call < 10_000; call += 1) if (limit.allow()) allowed += 1;
  assert.equal(allowed, CALLS_PER_MINUTE, "it stops dead at the ceiling");
});

test("the ceiling is a rolling minute, so a stopped surface recovers by itself", () => {
  let now = 0;
  const limit = createCallRateLimit({ now: () => now });
  for (let call = 0; call < 10_000; call += 1) limit.allow();
  assert.equal(limit.allow(), false, "still blocked inside the minute");
  now += 61_000;
  assert.equal(limit.allow(), true, "a minute later it is working again, with no reload");
});

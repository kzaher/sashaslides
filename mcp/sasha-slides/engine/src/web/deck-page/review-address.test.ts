// The review address deck_write_transition hands out (deck-api.ts TRANSITION_REVIEW_QUERY) opens
// exactly the named script and leaves the rest of the address as it was.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewRequestOf } from "./review-address.ts";

describe("the transition review address", () => {
  const rows = [
    { name: "control: no request", search: "", hash: "", expected: null },
    { name: "a script id", search: "?reviewTransitionScript=tr_NaUYsPLQ0", hash: "", expected: { scriptId: "tr_NaUYsPLQ0", addressWithoutRequest: "/deck/dk_AAAAAAAAAAAAAAAAAAAAAA" } },
    { name: "the embedded editor keeps embed=addon and its fragment", search: "?embed=addon&reviewTransitionScript=tr_NaUYsPLQ0", hash: "#ticket=t", expected: { scriptId: "tr_NaUYsPLQ0", addressWithoutRequest: "/deck/dk_AAAAAAAAAAAAAAAAAAAAAA?embed=addon#ticket=t" } },
    { name: "not an object id", search: "?reviewTransitionScript=%3Cscript%3E", hash: "", expected: null },
  ] as const;
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(reviewRequestOf({ pathname: "/deck/dk_AAAAAAAAAAAAAAAAAAAAAA", search: row.search, hash: row.hash }), row.expected);
    });
  }
});

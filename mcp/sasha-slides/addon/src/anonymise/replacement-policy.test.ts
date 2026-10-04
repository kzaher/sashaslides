/**
 * replacement-policy.test.ts — one test per rejection rule, plus one per way of trying to slip
 * past it. If a rule here goes green by accident the model becomes the privacy guarantee, which is
 * the thing UI-CONTRACT.md forbids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenizeHtml } from "./html-tokens.ts";
import {
  decideReplacements,
  echoFragmentsOf,
  forbiddenEchoFragmentsOf,
  judgeReplacement,
  type ReplacementVerdict,
} from "./replacement-policy.ts";
import { collectTextRunSites, type TextRunSite } from "./text-runs.ts";

const sitesOf = (html: string): readonly TextRunSite[] => collectTextRunSites({ tokens: tokenizeHtml(html) });

const SLIDE = `<!doctype html><html><head><title>Quarterly review</title></head>
<body><h1>Northwind infrastructure spend</h1><p>Total was £1,284,300</p></body></html>`;

const judge = ({ original, proposed }: { original: string; proposed: string }): ReplacementVerdict =>
  judgeReplacement({ original, proposed, forbiddenFragments: echoFragmentsOf(original) });

test("RULE 1: a replacement that equals the original is rejected, whatever the casing", () => {
  for (const proposed of ["Northwind spend", "NORTHWIND SPEND", "northwind spend", "  Northwind spend  "]) {
    assert.deepEqual(judge({ original: "Northwind spend", proposed }), { outcome: "rejected", reason: "unchanged" }, proposed);
  }
  // It fires even where there is no token of four or more characters for rule 2 to catch.
  assert.deepEqual(judge({ original: "Q3 x", proposed: "q3 X" }), { outcome: "rejected", reason: "unchanged" });
});

test("RULE 1 is not defeated by a compatibility or accent variant of the original", () => {
  assert.deepEqual(judge({ original: "Q3 x", proposed: "Ｑ３ ｘ" }), { outcome: "rejected", reason: "unchanged" });
  assert.deepEqual(judge({ original: "Q3 e", proposed: "Q3 é" }), { outcome: "rejected", reason: "unchanged" });
});

test("RULE 2: a replacement that reuses a whole 4+ character word of the original is rejected", () => {
  for (const proposed of [
    "Acme Northwind costs",
    "northwind",
    "pre-Northwind-post",
    "Acme costs 1284 units",
    "Northwind2",
  ]) {
    assert.deepEqual(
      judge({ original: "Northwind spend 1284", proposed }),
      { outcome: "rejected", reason: "echoes-original" },
      proposed,
    );
  }
});

test("RULE 2 catches PART of a word too, which a word-level rule would have let straight through", () => {
  // The case that decided the rule: a fragment of a company name is the company name to a reader.
  for (const proposed of ["Acme Northwi costs", "Acme thwind costs", "Acme windy costs", "Acme 1284s"]) {
    assert.deepEqual(
      judge({ original: "Northwind spend 1284", proposed }),
      { outcome: "rejected", reason: "echoes-original" },
      proposed,
    );
  }
  // Three shared characters is under the contract's threshold and stays usable.
  assert.deepEqual(judge({ original: "Northwind spend", proposed: "Nor Acme costs" }), {
    outcome: "accepted",
    text: "Nor Acme costs",
  });
});

test("RULE 2 never matches ACROSS a word boundary, in the original or in the replacement", () => {
  // `Big Dog` contributes no fragment at all (two three-letter runs), so `bigd` is not an echo.
  assert.deepEqual(judge({ original: "Big Dog Ltd", proposed: "bigdog plc" }), {
    outcome: "accepted",
    text: "bigdog plc",
  });
});

test("RULE 2 ignores runs of three characters or fewer, so short words are still usable", () => {
  const verdict = judge({ original: "Q3 VAT for the EU", proposed: "Q4 VAT for the US" });
  assert.deepEqual(verdict, { outcome: "accepted", text: "Q4 VAT for the US" });
});

test("RULE 2 is not defeated by an invisible character, a fullwidth form or a combining mark", () => {
  for (const proposed of ["North​wind costs", "Ｎｏｒｔｈｗｉｎｄ costs", "Nörthwind costs", "NoRtHwInD costs"]) {
    assert.deepEqual(
      judge({ original: "Northwind spend", proposed }),
      { outcome: "rejected", reason: "echoes-original" },
      proposed,
    );
  }
});

test("RULE 3: an empty replacement is rejected when the original was not empty", () => {
  for (const proposed of ["", "   ", "\n\t", "​", "\u0000"]) {
    assert.deepEqual(judge({ original: "Northwind spend", proposed }), { outcome: "rejected", reason: "emptied" }, JSON.stringify(proposed));
  }
});

test("an accepted replacement comes back NORMALISED, so no invisible character reaches the output", () => {
  const verdict = judge({ original: "Northwind spend", proposed: "  Acme​ outlay\u0007\r\n " });
  assert.deepEqual(verdict, { outcome: "accepted", text: "Acme outlay" });
});

test("THE DOCUMENT SCOPE: a word moved from one run into another is still an echo", () => {
  const sites = sitesOf(SLIDE);
  const heading = sites.find((site) => site.text.includes("Northwind"));
  const total = sites.find((site) => site.text.startsWith("Total"));
  assert.ok(heading !== undefined && total !== undefined);

  // Per-run, "Northwind" is not in the Total run's original at all — so only the document-wide
  // token set stops the model relocating it.
  const decisions = decideReplacements({
    sites,
    replacements: new Map([[total.id, "Northwind made £3,200,000"]]),
  });
  assert.deepEqual(decisions.accepted.size, 0);
  assert.deepEqual(
    decisions.rejected.map((rejection) => ({ runId: rejection.runId, reason: rejection.reason })),
    [{ runId: total.id, reason: "echoes-original" }],
  );
});

test("an id this slide has no run for is reported as unknown-run and changes nothing", () => {
  const decisions = decideReplacements({
    sites: sitesOf(SLIDE),
    replacements: new Map([
      ["t999", "Acme Corporation"],
      ["", "Acme Corporation"],
      ["t4a7", "Acme Corporation"],
    ]),
  });
  assert.deepEqual(decisions.accepted.size, 0);
  assert.deepEqual(
    decisions.rejected.map((rejection) => rejection.reason),
    ["unknown-run", "unknown-run", "unknown-run"],
  );
  for (const rejection of decisions.rejected) assert.match(rejection.detail, /no run/);
});

test("every rejection carries a sentence naming its run, so the UI can say which one was gibberished", () => {
  const sites = sitesOf(SLIDE);
  const heading = sites.find((site) => site.text.includes("Northwind"));
  assert.ok(heading !== undefined);
  const decisions = decideReplacements({ sites, replacements: new Map([[heading.id, ""]]) });
  assert.equal(decisions.rejected.length, 1);
  const rejection = decisions.rejected[0];
  assert.ok(rejection !== undefined);
  assert.equal(rejection.reason, "emptied");
  assert.ok(rejection.detail.includes(heading.id));
  assert.match(rejection.detail, /gibberished/);
});

test("a plausible, same-shape replacement is accepted with no shape risk at all", () => {
  const sites = sitesOf(SLIDE);
  const heading = sites.find((site) => site.text.includes("Northwind"));
  assert.ok(heading !== undefined);
  // "Northwind infrastructure spend" is 30 characters; "Fabrikam datacentre outlays" is 27, which
  // is inside the +/-3 band, has the same single line and no longer word than the original's 14.
  const decisions = decideReplacements({ sites, replacements: new Map([[heading.id, "Fabrikam datacentre outlays"]]) });
  assert.deepEqual(decisions.rejected, []);
  assert.equal(decisions.accepted.get(heading.id)?.text, "Fabrikam datacentre outlays");
  assert.deepEqual(decisions.shapeRisks, []);
});

test("a shape change is REPORTED rather than silently accepted: length, hard breaks and long words", () => {
  const sites = sitesOf(SLIDE);
  const heading = sites.find((site) => site.text.includes("Northwind"));
  assert.ok(heading !== undefined);
  const risksFor = (replacement: string): readonly string[] =>
    decideReplacements({ sites, replacements: new Map([[heading.id, replacement]]) }).shapeRisks.map((risk) => risk.risk);

  assert.deepEqual(risksFor("Acme"), ["length"]);
  assert.deepEqual(risksFor("Fabrikam datacentre\noutlay plans"), ["line-count"]);
  assert.deepEqual(risksFor("Fabrikamdatacentreoutlays"), ["length", "longest-word"]);
  const risks = decideReplacements({
    sites,
    replacements: new Map([[heading.id, "Fabrikam datacentre outlay for the whole of the southern region"]]),
  }).shapeRisks;
  assert.deepEqual(risks.map((risk) => risk.risk), ["length"]);
  const risk = risks[0];
  assert.ok(risk !== undefined);
  assert.equal(risk.runId, heading.id);
  assert.equal(risk.runKind, "body-text");
  assert.equal(risk.originalLength, 30);
  assert.ok(risk.detail.includes("longer"));
});

test("echoFragmentsOf is every four-character window inside a letter or digit run, and nothing else", () => {
  // `1,284,300` yields NO fragment: a thousands separator breaks the run and three digits is under
  // the threshold. That is a real gap in rule 2, and the reason rule 1 exists beside it.
  assert.deepEqual([...echoFragmentsOf("Wind2024 Q3 £1,284,300")], ["wind", "2024"]);
  assert.deepEqual([...echoFragmentsOf("Northwind")], ["nort", "orth", "rthw", "thwi", "hwin", "wind"]);
  assert.deepEqual([...echoFragmentsOf("Q3 VAT EU")], []);
  // A window is never taken across the boundary: no `d202` from `Wind2024`.
  assert.ok(!echoFragmentsOf("Wind2024").has("d202"));
});

test("forbiddenEchoFragmentsOf is the union over every run, which is what makes the document scope work", () => {
  const fragments = forbiddenEchoFragmentsOf({ sites: sitesOf(SLIDE) });
  for (const fragment of ["nort", "wind", "quar", "erly", "revi", "view", "infr", "ture", "spen", "tota", "otal"]) {
    assert.ok(fragments.has(fragment), `missing ${fragment}`);
  }
  // "was" and the thousands-separated amount are both under the threshold.
  for (const fragment of ["was", "1284", "2843"]) assert.ok(!fragments.has(fragment), `unexpected ${fragment}`);
});

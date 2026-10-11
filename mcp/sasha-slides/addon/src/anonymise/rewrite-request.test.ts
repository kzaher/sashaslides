/**
 * rewrite-request.test.ts — the prompt says what the gate will check, and the parser treats the
 * reply as what it is: untrusted input from a process that may be broken or hostile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTextRunRewriteReply, textRunRewriteRequest } from "./rewrite-request.ts";
import { extractTextRuns, type TextRun } from "./text-runs.ts";

const RUNS: readonly TextRun[] = extractTextRuns({
  html: `<!doctype html><html><head><title>Quarterly review</title></head>
<body><h1>Northwind infrastructure spend</h1><p>Total was £1,284,300</p></body></html>`,
});

const idsOf = (runs: readonly TextRun[]): readonly string[] => runs.map((run) => run.id);

test("the prompt lists every run with its id, kind and length, and quotes the text unambiguously", () => {
  const { prompt, runs } = textRunRewriteRequest({ runs: RUNS });
  assert.deepEqual(idsOf(runs), idsOf(RUNS));
  for (const run of RUNS) {
    assert.ok(prompt.includes(run.id), `the prompt does not name ${run.id}`);
    assert.ok(prompt.includes(JSON.stringify(run.text)), `the prompt does not carry ${run.id}'s text`);
    assert.ok(prompt.includes(run.kind), `the prompt does not say ${run.id} is a ${run.kind}`);
  }
});

test("the prompt states the rules the policy is about to enforce, so a cooperative model clears them", () => {
  const { prompt } = textRunRewriteRequest({ runs: RUNS });
  assert.match(prompt, /Never return the original/);
  assert.match(prompt, /FOUR CONSECUTIVE LETTERS OR DIGITS from any run above/);
  assert.match(prompt, /never leave a replacement empty/);
  assert.match(prompt, /JSON array and nothing else/);
});

test("a well-formed reply parses into a map, with the missing runs named", () => {
  const first = RUNS[0];
  const second = RUNS[1];
  assert.ok(first !== undefined && second !== undefined);
  const parsed = parseTextRunRewriteReply({
    reply: JSON.stringify([
      { id: first.id, text: "Half-year summary" },
      { id: second.id, text: "Fabrikam datacentre outlays" },
    ]),
    runs: RUNS,
  });
  assert.equal(parsed.outcome, "parsed");
  if (parsed.outcome !== "parsed") return;
  assert.deepEqual([...parsed.replacements], [
    [first.id, "Half-year summary"],
    [second.id, "Fabrikam datacentre outlays"],
  ]);
  assert.deepEqual(parsed.unknownRunIds, []);
  assert.deepEqual(parsed.missingRunIds, idsOf(RUNS.slice(2)));
});

test("one fenced block around the whole reply is a formatting habit, so it is removed", () => {
  const first = RUNS[0];
  assert.ok(first !== undefined);
  const entries = JSON.stringify([{ id: first.id, text: "Half-year summary" }]);
  for (const reply of [`\`\`\`json\n${entries}\n\`\`\``, `\`\`\`\n${entries}\n\`\`\`\n`]) {
    const parsed = parseTextRunRewriteReply({ reply, runs: RUNS });
    assert.equal(parsed.outcome, "parsed", reply);
  }
});

test("an id this slide has no run for is reported, not applied", () => {
  const parsed = parseTextRunRewriteReply({
    reply: JSON.stringify([{ id: "t999", text: "Acme Corporation" }]),
    runs: RUNS,
  });
  assert.equal(parsed.outcome, "parsed");
  if (parsed.outcome !== "parsed") return;
  assert.equal(parsed.replacements.size, 0);
  assert.deepEqual(parsed.unknownRunIds, ["t999"]);
  assert.deepEqual(parsed.missingRunIds, idsOf(RUNS));
});

test("EVERY malformed reply is rejected whole, and says why without quoting itself back", () => {
  const first = RUNS[0];
  assert.ok(first !== undefined);
  const malformed: readonly Readonly<{ why: string; reply: string }>[] = [
    { why: "empty", reply: "" },
    { why: "whitespace", reply: "   \n " },
    { why: "prose", reply: "Sure! Here are the replacements you asked for." },
    { why: "prose around the JSON", reply: `Here you go: [{"id":"${first.id}","text":"x"}]` },
    { why: "truncated JSON", reply: `[{"id":"${first.id}","text":"Half-year` },
    { why: "an object rather than an array", reply: `{"${first.id}":"Half-year summary"}` },
    { why: "a bare string", reply: '"Half-year summary"' },
    { why: "null", reply: "null" },
    { why: "an entry that is not an object", reply: '["Half-year summary"]' },
    { why: "an entry that is an array", reply: '[["t1","Half-year summary"]]' },
    { why: "a missing text", reply: `[{"id":"${first.id}"}]` },
    { why: "a missing id", reply: '[{"text":"Half-year summary"}]' },
    { why: "an extra key", reply: `[{"id":"${first.id}","text":"x","confidence":0.9}]` },
    { why: "a non-string text", reply: `[{"id":"${first.id}","text":42}]` },
    { why: "a null text", reply: `[{"id":"${first.id}","text":null}]` },
    { why: "a non-string id", reply: '[{"id":7,"text":"x"}]' },
    { why: "an empty id", reply: '[{"id":"","text":"x"}]' },
    { why: "the same run twice", reply: `[{"id":"${first.id}","text":"x"},{"id":"${first.id}","text":"y"}]` },
    { why: "the same unknown run twice", reply: '[{"id":"t999","text":"x"},{"id":"t999","text":"y"}]' },
  ];
  for (const { why, reply } of malformed) {
    const parsed = parseTextRunRewriteReply({ reply, runs: RUNS });
    assert.equal(parsed.outcome, "malformed", `accepted a reply with ${why}`);
    if (parsed.outcome !== "malformed") continue;
    assert.ok(parsed.problem.length > 0, why);
    assert.ok(!parsed.problem.includes("Half-year"), `the problem quotes the reply back: ${parsed.problem}`);
  }
});

test("an empty array is well-formed and means every run is gibberish — which is the safe answer", () => {
  const parsed = parseTextRunRewriteReply({ reply: "[]", runs: RUNS });
  assert.equal(parsed.outcome, "parsed");
  if (parsed.outcome !== "parsed") return;
  assert.equal(parsed.replacements.size, 0);
  assert.deepEqual(parsed.missingRunIds, idsOf(RUNS));
});

test("the parser does NOT judge the text: that is replacement-policy.ts's job, at the output", () => {
  // It passes an echo of the original straight through. The gate is at the one place that can see
  // the document, so there is no second, weaker copy of the rules here to drift out of step.
  const second = RUNS[1];
  assert.ok(second !== undefined);
  const parsed = parseTextRunRewriteReply({
    reply: JSON.stringify([{ id: second.id, text: second.text }]),
    runs: RUNS,
  });
  assert.equal(parsed.outcome, "parsed");
  if (parsed.outcome !== "parsed") return;
  assert.equal(parsed.replacements.get(second.id), second.text);
});

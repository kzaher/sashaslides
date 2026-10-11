// Unit + report for tools/jit-cas.js (the content-addressed-store planner). FEASIBILITY PROTOTYPE:
// nothing in the build, serve.mjs or the sandbox page calls it, and this test is not wired into
// `npm test` — run it by hand:  node test/jit-cas-unit.mjs [--report]
//
// The synthetic cases pin the arithmetic; --report decodes the real bundles in build/eh-nb/jit and
// prints what a merged, content-keyed store would cost (see docs/engine.md on bundles).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planCas, coverageOf } from "../tools/jit-cas.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const mod = (keys, byteLength) => ({ keys, byteLength });

// --- 1. disjoint bundles: nothing to dedupe
{
  const plan = planCas([
    { name: "a", tag: "T", modules: [mod(["1:1"], 100)] },
    { name: "b", tag: "T", modules: [mod(["2:2"], 200)] },
  ]);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.tagSplit, false);
  const g = plan.groups[0];
  assert.equal(g.uniqueKeys, 2);
  assert.equal(g.summedKeys, 2);
  assert.equal(g.keyDedupeFraction, 0);
  assert.equal(g.uniqueBytes, 300);
  assert.equal(g.redundantModules, 0);
  assert.equal(g.overlaps.length, 1);
  assert.equal(g.overlaps[0].shared, 0);
}
// --- 2. a fully redundant module is dropped, and its bytes are counted as the saving
{
  const plan = planCas([
    { name: "a", tag: "T", modules: [mod(["1:1", "2:2"], 100)] },
    { name: "b", tag: "T", modules: [mod(["1:1"], 70), mod(["3:3"], 30)] },
  ]);
  const g = plan.groups[0];
  assert.equal(g.uniqueKeys, 3);              // 1:1, 2:2, 3:3
  assert.equal(g.summedKeys, 2 + 2);          // a has 2 distinct, b has 2 distinct
  assert.equal(g.redundantModules, 1);
  assert.equal(g.redundantBytes, 70);
  assert.equal(g.uniqueBytes, 130);
  assert.equal(g.summedBytes, 200);
  assert.equal(g.overlaps[0].shared, 1);
  assert.equal(g.overlaps[0].fractionOfSmaller, 0.5);
}
// --- 3. a foreign engine tag can never be shared (jit-host.js:106 drops it)
{
  const plan = planCas([
    { name: "a", tag: "T1", modules: [mod(["1:1"], 10)] },
    { name: "b", tag: "T2", modules: [mod(["1:1"], 10)] },
  ]);
  assert.equal(plan.tagSplit, true);
  assert.equal(plan.groups.length, 2);
  for (const g of plan.groups) assert.equal(g.keyDedupeFraction, 0);
  const cov = coverageOf({ name: "b", tag: "T2", modules: [mod(["1:1"], 10)] },
                          [{ name: "a", tag: "T1", modules: [mod(["1:1"], 10)] }]);
  assert.equal(cov.hits, 0, "a foreign-tag bundle must contribute no coverage");
  assert.equal(cov.total, 1);
}
// --- 4. coverage of a never-recorded workload against a store built from others
{
  const have = [{ name: "k", tag: "T", modules: [mod(["1:1", "2:2", "3:3"], 10)] }];
  const cov = coverageOf({ name: "new", tag: "T", modules: [mod(["2:2", "3:3", "9:9", "8:8"], 10)] }, have);
  assert.equal(cov.hits, 2);
  assert.equal(cov.total, 4);
  assert.equal(cov.fraction, 0.5);
}
console.log("jit-cas-unit: 4/4 synthetic cases OK");

// --- report over the real artifacts -------------------------------------------------------------
if (process.argv.includes("--report")) {
  globalThis.self = globalThis;
  await import(path.join(ROOT, "web/jit-bundle.js"));
  const B = globalThis.NanoboxJitBundle;
  const dir = path.join(ROOT, "build/eh-nb/jit");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".nbjb")).sort();
  const bundles = files.map((f) => {
    const d = B.decode(new Uint8Array(fs.readFileSync(path.join(dir, f))));
    const modules = d.modules.map((m) => ({
      keys: m.funcKeys.filter(([lo, hi]) => (lo || hi) && !B.isLinkKey(lo, hi)).map(([lo, hi]) => B.keyString(lo, hi)),
      byteLength: m.bytes.length,
    }));
    return { name: f.replace(/\.nbjb$/, ""), tag: d.tag, modules };
  });
  const mb = (n) => (n / 1e6).toFixed(1) + " MB";
  const plan = planCas(bundles);
  console.log(`\n${dir}: ${files.length} bundles, tagSplit=${plan.tagSplit}`);
  for (const g of plan.groups) {
    console.log(`\n== engine tag ${g.tag.slice(0, 24)} :: ${g.bundles.join(", ")}`);
    console.log(`   merged store: ${g.uniqueKeys} keys / ${mb(g.uniqueBytes)}   vs name-keyed sum: ${g.summedKeys} keys / ${mb(g.summedBytes)}`);
    console.log(`   key dedupe ${(100 * g.keyDedupeFraction).toFixed(1)}%   fully-redundant modules ${g.redundantModules} (${mb(g.redundantBytes)} saved)`);
    for (const o of g.overlaps) console.log(`   overlap ${o.a} n ${o.b}: ${o.shared} keys = ${(100 * o.fractionOfSmaller).toFixed(1)}% of the smaller`);
  }
  console.log("\n-- leave-one-out coverage: what a store of the OTHERS already answers --");
  for (const b of bundles) {
    const cov = coverageOf(b, bundles.filter((x) => x !== b));
    console.log(`   ${b.name.padEnd(42)} ${String(cov.hits).padStart(6)}/${String(cov.total).padEnd(6)} = ${(100 * cov.fraction).toFixed(1)}%`);
  }
}

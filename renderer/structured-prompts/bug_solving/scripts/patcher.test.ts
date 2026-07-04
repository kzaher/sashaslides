/**
 * patcher.test.ts — unit tests for the git-agnostic patch/compose engine.
 *
 * Run:  cd /workspaces/sashaslides && npx tsx renderer/structured-prompts/bug_solving/scripts/patcher.test.ts
 *
 * Same convention as renderer/html2slides/css-parse-helpers.test.ts: a tiny
 * assert harness, prints PASS/FAIL per case, and process.exit(1) if any failed.
 * Uses only node:assert + node:fs (no test-runner dep).
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { computeChanges, applyChanges, _internal, type FileChange } from "./patcher.js";

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  PASS: ${label}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  assert(label, a === e, `expected ${e}, got ${a}`);
}

// ── scratch dir helpers ─────────────────────────────────────────────────────
const roots: string[] = [];
function tmproot(): string { const d = mkdtempSync(join(tmpdir(), "patcher-test-")); roots.push(d); return d; }
function write(root: string, rel: string, content: string): void {
  const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
}
function read(root: string, rel: string): string | null {
  const p = join(root, rel); return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== computeChanges ===");

{
  // added / deleted / modified + identical-file omission + glob scoping.
  const base = tmproot(), mod = tmproot();
  write(base, "renderer/html2slides/a.ts", "line1\nline2\n");     // modified
  write(mod,  "renderer/html2slides/a.ts", "line1\nCHANGED\n");
  write(base, "renderer/html2slides/gone.ts", "delete me\n");     // deleted
  write(mod,  "renderer/html2slides/new.ts", "brand new\n");      // added
  write(base, "renderer/html2slides/same.ts", "unchanged\n");     // identical
  write(mod,  "renderer/html2slides/same.ts", "unchanged\n");
  write(base, "renderer/other/ignore.ts", "off-glob\n");          // outside glob
  write(mod,  "renderer/other/ignore.ts", "off-glob changed\n");

  const changes = computeChanges(base, mod, ["renderer/html2slides/**/*.ts"]);
  const byPath = new Map(changes.map((c) => [c.path, c]));

  assertEq("change count (a, gone, new)", changes.length, 3);
  assert("modified a.ts detected", byPath.get("renderer/html2slides/a.ts")?.before === "line1\nline2\n" && byPath.get("renderer/html2slides/a.ts")?.after === "line1\nCHANGED\n");
  assert("deleted gone.ts (after=null)", byPath.get("renderer/html2slides/gone.ts")?.after === null);
  assert("added new.ts (before=null)", byPath.get("renderer/html2slides/new.ts")?.before === null);
  assert("identical same.ts omitted", !byPath.has("renderer/html2slides/same.ts"));
  assert("off-glob ignore.ts omitted", !byPath.has("renderer/other/ignore.ts"));
}

{
  // identical dirs → []
  const base = tmproot(), mod = tmproot();
  write(base, "renderer/html2slides/x.ts", "same\n");
  write(mod,  "renderer/html2slides/x.ts", "same\n");
  assertEq("identical dirs → []", computeChanges(base, mod, ["renderer/html2slides/**/*.ts"]).length, 0);
}

{
  // single-star glob does NOT cross '/'
  const base = tmproot(), mod = tmproot();
  write(base, "renderer/html2slides/top.ts", "a\n");
  write(mod,  "renderer/html2slides/top.ts", "b\n");
  write(base, "renderer/html2slides/sub/deep.ts", "a\n");
  write(mod,  "renderer/html2slides/sub/deep.ts", "b\n");
  const c1 = computeChanges(base, mod, ["renderer/html2slides/*.ts"]);
  assertEq("single-star matches only top-level", c1.map((c) => c.path), ["renderer/html2slides/top.ts"]);
  const c2 = computeChanges(base, mod, ["renderer/html2slides/**/*.ts"]);
  assertEq("double-star matches both", c2.map((c) => c.path).sort(), ["renderer/html2slides/sub/deep.ts", "renderer/html2slides/top.ts"]);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== 3-way merge primitive (_internal.merge3) ===");

{
  const base = "a\nb\nc\n";
  // ours changes line 1, theirs changes line 3 → both compose.
  const m = _internal.merge3(base, "A\nb\nc\n", "a\nb\nC\n");
  assert("non-overlapping compose clean", !m.conflict, `body=${JSON.stringify(m.body)}`);
  assertEq("non-overlapping compose body", m.body, "A\nb\nC\n");
}
{
  // both sides change the SAME line differently → conflict.
  const base = "a\nb\nc\n";
  const m = _internal.merge3(base, "a\nX\nc\n", "a\nY\nc\n");
  assert("overlapping edit conflicts", m.conflict);
  assert("conflict body has markers", m.body.includes("<<<<<<<") && m.body.includes("=======") && m.body.includes(">>>>>>>"));
}
{
  // both sides make the IDENTICAL change → no conflict.
  const base = "a\nb\nc\n";
  const m = _internal.merge3(base, "a\nZ\nc\n", "a\nZ\nc\n");
  assert("identical change no conflict", !m.conflict);
  assertEq("identical change body", m.body, "a\nZ\nc\n");
}
{
  // ours == base → take theirs.
  const m = _internal.merge3("a\nb\n", "a\nb\n", "a\nb\nc\n");
  assert("ours==base takes theirs", !m.conflict);
  assertEq("ours==base body", m.body, "a\nb\nc\n");
}
{
  // insertions at different anchors compose.
  const base = "one\ntwo\nthree\n";
  const m = _internal.merge3(base, "one\nINS_A\ntwo\nthree\n", "one\ntwo\nthree\nINS_B\n");
  assert("distinct inserts compose", !m.conflict, `body=${JSON.stringify(m.body)}`);
  assertEq("distinct inserts body", m.body, "one\nINS_A\ntwo\nthree\nINS_B\n");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== applyChanges: clean compose (the case that broke) ===");

{
  // Two clusters edited convert-pptx-io.ts at DIFFERENT regions off the SAME base.
  // Cluster1's change is already in the target (ours); cluster2's change (theirs)
  // must compose on top → both land.
  const target = tmproot();
  const BASE =
`import x;
function foo() {
  return 1;
}
function bar() {
  return 2;
}
`;
  const CLUSTER1 = // edits foo()
`import x;
function foo() {
  return 111;
}
function bar() {
  return 2;
}
`;
  const CLUSTER2 = // edits bar()
`import x;
function foo() {
  return 1;
}
function bar() {
  return 222;
}
`;
  // target already carries cluster1's fix.
  write(target, "renderer/html2slides/convert-pptx-io.ts", CLUSTER1);

  // cluster2's FileChange is computed against the clean base.
  const changes: FileChange[] = [{ path: "renderer/html2slides/convert-pptx-io.ts", before: BASE, after: CLUSTER2 }];
  const res = applyChanges(target, changes);

  assert("two-region compose ok", res.ok === true, res.ok ? "" : JSON.stringify((res as { conflicts: unknown }).conflicts));
  const got = read(target, "renderer/html2slides/convert-pptx-io.ts") ?? "";
  assert("cluster1 edit preserved (foo→111)", got.includes("return 111;"));
  assert("cluster2 edit landed (bar→222)", got.includes("return 222;"));
  assert("no conflict markers", !got.includes("<<<<<<<"));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== applyChanges: genuine conflict (same lines) ===");

{
  const target = tmproot();
  const BASE = "header\nvalue = 1\nfooter\n";
  const OURS = "header\nvalue = 2\nfooter\n";   // already in target
  const THEIRS = "header\nvalue = 3\nfooter\n"; // the change we apply
  write(target, "renderer/html2slides/x.ts", OURS);
  const res = applyChanges(target, [{ path: "renderer/html2slides/x.ts", before: BASE, after: THEIRS }]);
  assert("same-line edit reported as conflict", res.ok === false);
  if (res.ok === false) {
    assertEq("one conflict reported", res.conflicts.length, 1);
    assert("conflict names the file", res.conflicts[0].path === "renderer/html2slides/x.ts");
    assert("conflict merged view has markers", res.conflicts[0].merged.includes("<<<<<<<"));
  }
  // NOT silently clobbered: target still holds ours (conflicted file left unwritten).
  assertEq("target unchanged on conflict", read(target, "renderer/html2slides/x.ts"), OURS);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== applyChanges: create + delete propagation ===");

{
  const target = tmproot();
  write(target, "renderer/html2slides/keep.ts", "keep\n");
  write(target, "renderer/html2slides/todelete.ts", "old body\n");
  const changes: FileChange[] = [
    { path: "renderer/html2slides/created.ts", before: null, after: "fresh file\n" },      // create
    { path: "renderer/html2slides/todelete.ts", before: "old body\n", after: null },        // delete (matches base)
  ];
  const res = applyChanges(target, changes);
  assert("create+delete ok", res.ok === true);
  assertEq("created file written", read(target, "renderer/html2slides/created.ts"), "fresh file\n");
  assert("deleted file removed", read(target, "renderer/html2slides/todelete.ts") === null);
  assertEq("untouched file kept", read(target, "renderer/html2slides/keep.ts"), "keep\n");
}

{
  // modify/delete conflict: target diverged from the base we delete against.
  const target = tmproot();
  write(target, "renderer/html2slides/y.ts", "locally modified\n");
  const res = applyChanges(target, [{ path: "renderer/html2slides/y.ts", before: "original\n", after: null }]);
  assert("modify/delete → conflict", res.ok === false);
  assert("modify/delete file kept", read(target, "renderer/html2slides/y.ts") === "locally modified\n");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== round-trip: computeChanges then applyChanges ===");

{
  // Realistic loop: base dir + a modified dir → computeChanges → apply onto a
  // fresh copy of base → the fresh copy now equals modified.
  const base = tmproot(), modified = tmproot(), target = tmproot();
  const files = {
    "renderer/html2slides/a.ts": ["a1\na2\na3\n", "a1\nA2\na3\n"],
    "renderer/html2slides/b.ts": ["b1\n", "b1\nb2\n"],
    "renderer/html2slides/deleteme.ts": ["bye\n", null],
    "renderer/html2slides/added.ts": [null, "hello\n"],
  } as const;
  for (const [rel, [b]] of Object.entries(files)) if (b !== null) write(base, rel, b);
  for (const [rel, [, m]] of Object.entries(files)) if (m !== null && m !== undefined) write(modified, rel, m);
  // target starts as a copy of base.
  for (const [rel, [b]] of Object.entries(files)) if (b !== null) write(target, rel, b);

  const changes = computeChanges(base, modified, ["renderer/html2slides/**/*.ts"]);
  const res = applyChanges(target, changes);
  assert("round-trip apply ok", res.ok === true);
  assertEq("round-trip a.ts", read(target, "renderer/html2slides/a.ts"), "a1\nA2\na3\n");
  assertEq("round-trip b.ts", read(target, "renderer/html2slides/b.ts"), "b1\nb2\n");
  assert("round-trip deleted", read(target, "renderer/html2slides/deleteme.ts") === null);
  assertEq("round-trip added", read(target, "renderer/html2slides/added.ts"), "hello\n");
}

// ── cleanup ─────────────────────────────────────────────────────────────────
for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } }

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

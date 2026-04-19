import { parseLinearGradient, parseBoxShadow, parseColor } from "./css-parse-helpers";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function assertEq(label: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, `expected ${e}, got ${a}`);
}

// ── parseLinearGradient ─────────────────────────────────────────────────────

console.log("\n=== parseLinearGradient ===");

{
  const r = parseLinearGradient("linear-gradient(135deg, rgb(30, 136, 229), rgb(142, 36, 170))");
  assert("deg gradient not null", r !== null);
  assertEq("deg gradient angle", r?.angle, 135);
  assertEq("deg gradient stop count", r?.stops.length, 2);
  assertEq("deg gradient stop 0 color", r?.stops[0].color, "#1e88e5");
  assertEq("deg gradient stop 0 pos", r?.stops[0].position, 0);
  assertEq("deg gradient stop 1 color", r?.stops[1].color, "#8e24aa");
  assertEq("deg gradient stop 1 pos", r?.stops[1].position, 1);
}

{
  const r = parseLinearGradient("linear-gradient(to right, #ff0000 0%, #0000ff 100%)");
  assert("to right gradient not null", r !== null);
  assertEq("to right angle", r?.angle, 90);
  assertEq("to right stop count", r?.stops.length, 2);
  assertEq("to right stop 0 color", r?.stops[0].color, "#ff0000");
  assertEq("to right stop 0 pos", r?.stops[0].position, 0);
  assertEq("to right stop 1 color", r?.stops[1].color, "#0000ff");
  assertEq("to right stop 1 pos", r?.stops[1].position, 1);
}

{
  const r = parseLinearGradient("linear-gradient(#aaa, #bbb)");
  assert("no-angle gradient not null", r !== null);
  assertEq("no-angle default 180", r?.angle, 180);
  assertEq("no-angle stop 0", r?.stops[0].color, "#aaaaaa");
  assertEq("no-angle stop 1", r?.stops[1].color, "#bbbbbb");
}

{
  const r = parseLinearGradient("radial-gradient(circle, #fff, #000)");
  assert("radial returns null", r === null);
}

{
  const r = parseLinearGradient("none");
  assert("none returns null", r === null);
}

{
  const r = parseLinearGradient("linear-gradient(to bottom right, rgba(255,0,0,0.5) 20%, rgba(0,0,255,0.8) 80%)");
  assert("diagonal gradient not null", r !== null);
  assertEq("diagonal angle", r?.angle, 135);
  assertEq("diagonal stop 0 pos", r?.stops[0].position, 0.2);
  assertEq("diagonal stop 1 pos", r?.stops[1].position, 0.8);
}

// ── parseBoxShadow ──────────────────────────────────────────────────────────

console.log("\n=== parseBoxShadow ===");

{
  const r = parseBoxShadow("0px 4px 8px rgba(0, 0, 0, 0.2)");
  assert("simple shadow not null", r !== null);
  assertEq("simple offsetX", r?.offsetX, 0);
  assertEq("simple offsetY", r?.offsetY, 4);
  assertEq("simple blur", r?.blur, 8);
  assertEq("simple spread", r?.spread, 0);
  assertEq("simple color", r?.color, "#000000");
}

{
  const r = parseBoxShadow("rgba(60, 64, 67, 0.3) 0px 1px 3px 0px, rgba(60, 64, 67, 0.15) 0px 4px 8px 3px");
  assert("multi shadow not null", r !== null);
  assertEq("multi offsetX", r?.offsetX, 0);
  assertEq("multi offsetY", r?.offsetY, 1);
  assertEq("multi blur", r?.blur, 3);
  assertEq("multi spread", r?.spread, 0);
  assertEq("multi color", r?.color, "#3c4043");
}

{
  const r = parseBoxShadow("none");
  assert("none returns null", r === null);
}

{
  const r = parseBoxShadow("2px -3px 0px 1px #ff0000");
  assert("hex color shadow not null", r !== null);
  assertEq("hex offsetX", r?.offsetX, 2);
  assertEq("hex offsetY", r?.offsetY, -3);
  assertEq("hex blur", r?.blur, 0);
  assertEq("hex spread", r?.spread, 1);
  assertEq("hex color", r?.color, "#ff0000");
}

// ── parseColor ──────────────────────────────────────────────────────────────

console.log("\n=== parseColor ===");

assertEq("hex 6", parseColor("#1e88e5"), "#1e88e5");
assertEq("hex 3", parseColor("#abc"), "#aabbcc");
assertEq("hex 8 (with alpha)", parseColor("#1e88e5ff"), "#1e88e5");
assertEq("rgb()", parseColor("rgb(255, 128, 0)"), "#ff8000");
assertEq("rgba()", parseColor("rgba(60, 64, 67, 0.3)"), "#3c4043");
assertEq("transparent", parseColor("transparent"), null);
assertEq("empty", parseColor(""), null);
assertEq("rgba 0", parseColor("rgba(0, 0, 0, 0)"), null);

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

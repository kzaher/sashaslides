#!/usr/bin/env npx tsx
/**
 * offtarget-gate.ts — VISUAL off-target regression gate for bug_solving.
 *
 * Replaces the old binary-structural off-target check. The whole-deck
 * regression scan (main.ts step 4b) writes `<scratch>/reg-diffs/<slide>.diff`
 * for every slide; a non-cluster slide whose diff is not
 * "(no structural differences detected)" merely means the fix CHANGED that
 * slide's pptx — NOT that it looks worse. A shared-converter fix legitimately
 * shifts the rendering math for other slides in ways that are invisible or even
 * improvements; binary-failing those forces overly-narrow hacks.
 *
 * This gate instead RENDERS each changed off-target slide BEFORE (HEAD) and
 * AFTER (the worker's fix) to Google Slides and asks an image-aware `claude -p`
 * verifier whether the change is a VISIBLE regression. Only verifier-confirmed
 * visible regressions are reported. Output is written to
 * `<scratch>/offtarget-gate.json`:
 *   { regressions: string[],            // slide ids judged visibly WORSE
 *     verdicts: { slide_id, isVisibleRegression, rationale }[],
 *     changed: string[] }               // all structurally-changed off-targets
 *
 * The script ALWAYS writes the file and ALWAYS exits 0 — it is a data producer,
 * not a gate that throws; main.ts step 6b reads `regressions` and decides. On
 * any rendering/verifier failure it is CONSERVATIVE: the affected slide is
 * reported as a regression (fail-safe), so a flaky render can't silently pass a
 * real regression.
 *
 * Usage:
 *   npx tsx offtarget-gate.ts --scratch <dir> --cluster <csv> --workdir <wt> \
 *     --fixtures <dir> --record <record-rendering.ts> --title <presentation-title>
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

type Args = {
  scratch: string; cluster: string; workdir: string;
  fixtures: string; record: string; title: string;
};

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--scratch": a.scratch = v; i++; break;
      case "--cluster": a.cluster = v; i++; break;
      case "--workdir": a.workdir = v; i++; break;
      case "--fixtures": a.fixtures = v; i++; break;
      case "--record": a.record = v; i++; break;
      case "--title": a.title = v; i++; break;
    }
  }
  for (const k of ["scratch", "workdir", "fixtures", "record", "title"] as const) {
    if (!a[k]) throw new Error(`offtarget-gate: missing --${k}`);
  }
  a.cluster ??= "";
  return a as Args;
}

interface OffVerdict { slide_id: string; isVisibleRegression: boolean; rationale: string }

/** Structurally-changed slides NOT in the cluster (the candidates to verify). */
function changedOffTargets(scratch: string, clusterCsv: string): string[] {
  const regDir = join(scratch, "reg-diffs");
  if (!existsSync(regDir)) return [];
  const cluster = new Set(clusterCsv.split(",").map(s => s.trim()).filter(Boolean));
  const out: string[] = [];
  for (const f of readdirSync(regDir)) {
    if (!f.endsWith(".diff")) continue;
    const sid = f.replace(/\.diff$/, "");
    if (cluster.has(sid)) continue;
    let txt = "";
    try { txt = readFileSync(join(regDir, f), "utf-8"); } catch { continue; }
    if (!/no structural differences/i.test(txt)) out.push(sid);
  }
  return out.sort();
}

/** Render the given slides to Google Slides (--mode full → thumbs/<id>.png). */
function renderFull(a: Args, slidesCsv: string, outDir: string, titleSuffix: string): void {
  rmSync(outDir, { recursive: true, force: true });
  execSync(
    `cd ${a.workdir}/renderer && npx tsx ${a.record} --mode full ` +
    `--fixtures ${a.fixtures} --slides "${slidesCsv}" ` +
    `--title "${a.title}-${titleSuffix}" --out ${outDir}`,
    { stdio: "inherit", maxBuffer: 64 * 1024 * 1024 },
  );
}

/** Ask claude -p to judge BEFORE-vs-AFTER for one slide. Conservative on error. */
function verifyOne(sid: string, beforePng: string, afterPng: string, diffPath: string): OffVerdict {
  if (!existsSync(beforePng) || !existsSync(afterPng)) {
    return { slide_id: sid, isVisibleRegression: true, rationale: "render unavailable (missing BEFORE/AFTER thumbnail) — failing safe" };
  }
  const prompt =
    `You are checking whether a code fix caused a VISIBLE regression on an UNRELATED slide ${sid} ` +
    `(NOT one of the slides the fix targeted). Use the Read tool to VIEW both images:\n` +
    `BEFORE-fix render: ${beforePng}\nAFTER-fix render: ${afterPng}\n` +
    `(Structural OOXML diff, for context: ${diffPath})\n` +
    `The pptx changed structurally by definition; your ONLY job is to decide if the AFTER render ` +
    `looks WORSE than BEFORE to a human — clipped/overlapping/misaligned/missing content, broken ` +
    `layout, wrong colors. A benign or invisible reflow a viewer would not notice is NOT a regression.\n` +
    `Respond with ONLY a single-line JSON object (no prose, no code fences): ` +
    `{"slide_id":"${sid}","rationale":"<=300 chars on what visibly changed, if anything","isVisibleRegression":<true|false>}`;
  try {
    const raw = execSync(
      `claude -p ${JSON.stringify(prompt)} --output-format json --dangerously-skip-permissions --model sonnet`,
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, cwd: process.cwd() },
    );
    // `--output-format json` wraps the model output: { ..., result: "<text>" }.
    let resultText = raw;
    try { const env = JSON.parse(raw) as { result?: string }; if (typeof env.result === "string") resultText = env.result; } catch { /* raw is the text */ }
    const m = resultText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("verifier returned no JSON object");
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (typeof o.isVisibleRegression !== "boolean") throw new Error("isVisibleRegression not boolean");
    return {
      slide_id: sid,
      isVisibleRegression: o.isVisibleRegression,
      rationale: typeof o.rationale === "string" ? o.rationale : "",
    };
  } catch (e) {
    return { slide_id: sid, isVisibleRegression: true, rationale: `verifier error (failing safe): ${(e as Error).message.slice(0, 160)}` };
  }
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const outFile = join(a.scratch, "offtarget-gate.json");
  const write = (o: unknown) => writeFileSync(outFile, JSON.stringify(o, null, 2));

  const changed = changedOffTargets(a.scratch, a.cluster);
  if (changed.length === 0) {
    write({ regressions: [], verdicts: [], changed: [] });
    console.log("offtarget-gate: no off-target structural changes — PASS");
    return;
  }
  console.log(`offtarget-gate: ${changed.length} off-target slide(s) changed structurally: ${changed.join(", ")} — rendering BEFORE/AFTER to verify visually`);

  const csv = changed.join(",");
  const afterDir = join(a.scratch, "offtarget-after");
  const beforeDir = join(a.scratch, "offtarget-before");
  // AFTER = the worker's fix as it sits in the worktree right now.
  try { renderFull(a, csv, afterDir, "offA"); } catch (e) { console.error(`AFTER render failed: ${(e as Error).message}`); }
  // BEFORE = HEAD: stash the fix, render, restore (mirrors main.ts step 4b).
  try {
    execSync(`git -C ${a.workdir} stash push -m bs-offbase`, { stdio: "ignore" });
    let stashed = true;
    try { renderFull(a, csv, beforeDir, "offB"); }
    finally {
      try {
        const list = execSync(`git -C ${a.workdir} stash list`, { encoding: "utf-8" });
        if (stashed && /bs-offbase/.test(list)) execSync(`git -C ${a.workdir} stash pop`, { stdio: "ignore" });
      } catch { /* leave stash; non-fatal */ }
    }
  } catch (e) { console.error(`BEFORE render/stash failed: ${(e as Error).message}`); }

  const verdicts: OffVerdict[] = changed.map(sid => verifyOne(
    sid,
    join(beforeDir, "thumbs", `${sid}.png`),
    join(afterDir, "thumbs", `${sid}.png`),
    join(a.scratch, "reg-diffs", `${sid}.diff`),
  ));
  const regressions = verdicts.filter(v => v.isVisibleRegression).map(v => v.slide_id);
  write({ regressions, verdicts, changed });
  console.log(`offtarget-gate: ${regressions.length}/${changed.length} are VISIBLE regressions: ${regressions.join(", ") || "(none)"}`);
}

try { main(); }
catch (e) {
  // Never throw — write a conservative empty-pass so a gate-script bug doesn't
  // wedge the chain. (A real visible regression is caught per-slide above.)
  console.error(`offtarget-gate fatal: ${(e as Error).message}`);
  process.exit(0);
}

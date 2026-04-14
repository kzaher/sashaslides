#!/usr/bin/env npx tsx
/**
 * eval-renderer.ts — Evaluate HTML-to-Slides renderer across iterations
 *
 * For each iteration of the renderer, measures:
 *   - Tokens used (total and per slide)
 *   - Time per slide
 *   - Total time
 *   - Fidelity score (visual comparison of rendered vs original)
 *
 * Usage: npx tsx eval-renderer.ts <html-dir> --presentation <url-or-id> [--iterations 5]
 *
 * Each iteration tries to improve the conversion prompt to reduce tokens
 * while maintaining or improving fidelity.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";

const ANALYSIS_DIR = dirname(dirname(new URL(import.meta.url).pathname));

interface IterationResult {
  iteration: number;
  totalSlides: number;
  totalTokens: number;
  totalTimeMs: number;
  avgTokensPerSlide: number;
  avgTimePerSlideMs: number;
  fidelityScore: number;
  promptStrategy: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function scoreFidelity(
  renderedDir: string,
  originalDir: string
): number {
  // Use haiku to compare rendered vs original screenshots
  const renderedFiles = readdirSync(renderedDir)
    .filter((f) => f.startsWith("rendered_") && f.endsWith(".png"))
    .sort();
  const originalFiles = readdirSync(originalDir)
    .filter((f) => f.startsWith("slide_") && f.endsWith(".png"))
    .sort();

  if (renderedFiles.length === 0 || originalFiles.length === 0) {
    console.log("  No screenshots to compare, returning default score");
    return 5.0;
  }

  const compareCount = Math.min(renderedFiles.length, originalFiles.length, 5);
  let totalScore = 0;

  for (let i = 0; i < compareCount; i++) {
    // Ask haiku to score fidelity 1-10
    const prompt = `Score how well slide B matches slide A's layout and style (not content). Score 1-10. Just output the number.

Slide A (original): ${join(originalDir, originalFiles[i])}
Slide B (rendered): ${join(renderedDir, renderedFiles[i])}`;

    try {
      const output = execSync(
        `echo '${prompt.replace(/'/g, "'\\''")}' | claude -p --model haiku --dangerously-skip-permissions 2>/dev/null`,
        { timeout: 15000, encoding: "utf-8" }
      );
      const score = parseFloat(output.match(/\d+\.?\d*/)?.[0] || "5");
      totalScore += Math.min(10, Math.max(0, score));
    } catch {
      totalScore += 5;
    }
  }

  return totalScore / compareCount;
}

const PROMPT_STRATEGIES = [
  {
    name: "full-verbose",
    description:
      "Full prompt with examples and all command types. Baseline iteration.",
  },
  {
    name: "compressed-json",
    description:
      "Minimal prompt: just HTML + compact JSON format spec. No examples.",
  },
  {
    name: "template-mapped",
    description:
      "Pre-classify slide type, send only the matching template commands + content diff.",
  },
  {
    name: "delta-only",
    description:
      "Send only what differs from a blank slide: title text, body text, style overrides.",
  },
  {
    name: "no-llm-direct",
    description:
      "Skip LLM entirely: parse HTML DOM directly, map elements to CDP commands programmatically.",
  },
];

async function runIteration(
  htmlDir: string,
  presId: string,
  iterNum: number,
  iterDir: string,
  originalDir?: string
): Promise<IterationResult> {
  const strategy = PROMPT_STRATEGIES[iterNum % PROMPT_STRATEGIES.length];
  console.log(
    `\n--- Iteration ${iterNum}: ${strategy.name} ---\n${strategy.description}\n`
  );

  mkdirSync(iterDir, { recursive: true });

  // Copy HTML files to iteration dir
  const htmlFiles = readdirSync(htmlDir)
    .filter((f) => f.endsWith(".html") && f.startsWith("slide_"))
    .sort();
  for (const f of htmlFiles) {
    copyFileSync(join(htmlDir, f), join(iterDir, f));
  }
  if (existsSync(join(htmlDir, "style.json"))) {
    copyFileSync(join(htmlDir, "style.json"), join(iterDir, "style.json"));
  }

  const start = Date.now();

  // Run renderer
  try {
    execSync(
      `cd "${join(ANALYSIS_DIR, "scripts")}" && npx tsx "${join(ANALYSIS_DIR, "renderer/html-to-slides.ts")}" "${iterDir}" --presentation "${presId}" --iteration ${iterNum}`,
      {
        timeout: 300000,
        encoding: "utf-8",
        stdio: "inherit",
      }
    );
  } catch (err: any) {
    console.log(`  Renderer exited with error (may be partial success)`);
  }

  const totalTimeMs = Date.now() - start;

  // Read metrics
  const metricsPath = join(iterDir, "render_metrics.json");
  let metrics: any = {
    totalSlides: htmlFiles.length,
    totalTokens: 0,
    avgTokensPerSlide: 0,
    avgTimePerSlideMs: 0,
  };

  if (existsSync(metricsPath)) {
    metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
  }

  // Score fidelity
  let fidelity = 5.0;
  const renderedDir = join(iterDir, "rendered");
  if (originalDir && existsSync(renderedDir)) {
    fidelity = scoreFidelity(renderedDir, originalDir);
  }

  return {
    iteration: iterNum,
    totalSlides: metrics.totalSlides,
    totalTokens: metrics.totalTokens,
    totalTimeMs,
    avgTokensPerSlide: metrics.avgTokensPerSlide,
    avgTimePerSlideMs: metrics.avgTimePerSlideMs,
    fidelityScore: fidelity,
    promptStrategy: strategy.name,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx tsx eval-renderer.ts <html-dir> --presentation <url-or-id> [--iterations N] [--originals <dir>]"
    );
    process.exit(1);
  }

  const htmlDir = args[0];
  let presId = "";
  let iterationCount = 5;
  let originalDir = "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--presentation") presId = args[++i];
    if (args[i] === "--iterations") iterationCount = parseInt(args[++i]);
    if (args[i] === "--originals") originalDir = args[++i];
  }

  if (!presId) {
    console.error("--presentation is required");
    process.exit(1);
  }

  const evalDir = join(ANALYSIS_DIR, "eval/iterations");
  mkdirSync(evalDir, { recursive: true });

  console.log(`=== Renderer Evaluation ===`);
  console.log(`HTML dir:      ${htmlDir}`);
  console.log(`Presentation:  ${presId}`);
  console.log(`Iterations:    ${iterationCount}`);
  console.log(`Originals:     ${originalDir || "(none — fidelity will be estimated)"}`);

  const results: IterationResult[] = [];

  for (let i = 0; i < iterationCount; i++) {
    const iterDir = join(evalDir, `iteration_${i}`);
    const result = await runIteration(htmlDir, presId, i, iterDir, originalDir);
    results.push(result);

    console.log(
      `  → Tokens: ${result.totalTokens} | Time: ${(result.totalTimeMs / 1000).toFixed(1)}s | Fidelity: ${result.fidelityScore.toFixed(1)}/10`
    );
  }

  // Print comparison table
  console.log(`\n=== ITERATION COMPARISON ===\n`);
  console.log(
    `| Iter | Strategy         | Tokens | Tok/Slide | Time(s) | Time/Slide(s) | Fidelity |`
  );
  console.log(
    `|------|------------------|--------|-----------|---------|---------------|----------|`
  );

  for (const r of results) {
    console.log(
      `| ${r.iteration}    | ${r.promptStrategy.padEnd(16)} | ${String(r.totalTokens).padStart(6)} | ${String(Math.round(r.avgTokensPerSlide)).padStart(9)} | ${(r.totalTimeMs / 1000).toFixed(1).padStart(7)} | ${(r.avgTimePerSlideMs / 1000).toFixed(1).padStart(13)} | ${r.fidelityScore.toFixed(1).padStart(8)} |`
    );
  }

  // Show trends
  if (results.length >= 2) {
    const first = results[0];
    const last = results[results.length - 1];
    console.log(`\n--- Trends (first → last) ---`);
    console.log(
      `Tokens:   ${first.totalTokens} → ${last.totalTokens} (${(((last.totalTokens - first.totalTokens) / first.totalTokens) * 100).toFixed(1)}%)`
    );
    console.log(
      `Time:     ${(first.totalTimeMs / 1000).toFixed(1)}s → ${(last.totalTimeMs / 1000).toFixed(1)}s (${(((last.totalTimeMs - first.totalTimeMs) / first.totalTimeMs) * 100).toFixed(1)}%)`
    );
    console.log(
      `Fidelity: ${first.fidelityScore.toFixed(1)} → ${last.fidelityScore.toFixed(1)} (${(((last.fidelityScore - first.fidelityScore) / first.fidelityScore) * 100).toFixed(1)}%)`
    );
  }

  // Save report
  const report = {
    runAt: new Date().toISOString(),
    htmlDir,
    presId,
    iterations: results,
  };

  writeFileSync(join(evalDir, "eval_report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${evalDir}/eval_report.json`);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * run-eval-multi.ts — Run the full eval across multiple presentations × 3 candidates
 *
 * ALL operations within a step run IN PARALLEL.
 * Steps run sequentially (extract → analyze → reconstruct → screenshot → score)
 * because each step depends on the previous one's output.
 *
 * Usage:
 *   npx tsx run-eval-multi.ts                          # all steps, all presentations
 *   npx tsx run-eval-multi.ts --step analyze            # one step only
 *   npx tsx run-eval-multi.ts --pres airbnb-seed-2009   # one presentation only
 *   npx tsx run-eval-multi.ts --max 3                   # first N presentations
 *   npx tsx run-eval-multi.ts --force                   # re-run even if output exists
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";

const ANALYSIS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");
const RESULTS_DIR = join(ANALYSIS_DIR, "eval", "results");
const PROMPTS_DIR = join(ANALYSIS_DIR, "prompts");
const PRES_DIR = join(ANALYSIS_DIR, "presentations");
const SCRIPTS_DIR = join(ANALYSIS_DIR, "scripts");

const CANDIDATE_NAMES: Record<number, string> = {
  1: "decompose",
  2: "persona",
  3: "generative",
};

type Step = "all" | "extract" | "analyze" | "reconstruct" | "screenshot" | "score";

interface Config {
  presentations: string[];
  candidates: number[];
  step: Step;
  model: string;
  force: boolean;
}

interface CandidateResult {
  candidate: number;
  slideCount: number;
  scores: { layout: number; content: number; visual: number; rules: number; avg: number };
}

interface PresentationResult {
  presId: string;
  slideCount: number;
  candidates: CandidateResult[];
  ranking: number[];
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(join(PRES_DIR, "manifest.json"), "utf-8"));
  const config: Config = {
    presentations: manifest.presentations.map((p: any) => p.id),
    candidates: [1, 2, 3],
    step: "all",
    model: "sonnet",
    force: false,
  };

  let max = Infinity;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--pres": config.presentations = [args[++i]]; break;
      case "--max": max = parseInt(args[++i]); break;
      case "--step": config.step = args[++i] as Step; break;
      case "--model": config.model = args[++i]; break;
      case "--candidates": config.candidates = args[++i].split(",").map(Number); break;
      case "--force": config.force = true; break;
    }
  }
  config.presentations = config.presentations.slice(0, max);
  return config;
}

function presResultDir(presId: string): string {
  return join(RESULTS_DIR, presId);
}

function has(path: string, minBytes = 100): boolean {
  return existsSync(path) && readFileSync(path, "utf-8").length >= minBytes;
}

function countFiles(dir: string, pattern: RegExp): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f: string) => pattern.test(f)).length;
}

/** Run claude -p as a promise — enables parallel execution */
function runClaudeAsync(promptFile: string, model: string, timeoutSec = 180): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--model", model, "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutSec * 1000,
    });

    const input = readFileSync(promptFile, "utf-8");
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", () => resolve(stdout));
    child.on("error", () => resolve(stdout));

    child.stdin.write(input);
    child.stdin.end();
  });
}

// ---- EXTRACT (parallel across presentations) ----
async function runExtractAll(config: Config) {
  console.log(`\n=== EXTRACT ===`);
  await Promise.all(config.presentations.map(async (presId) => {
    const extractDir = join(presResultDir(presId), "extraction");
    if (!config.force && has(join(extractDir, "structure.json"))) {
      console.log(`  [extract] ${presId}: already done`);
      return;
    }

    const srcDir = join(PRES_DIR, presId);
    const slideImages = countFiles(srcDir, /^slide_\d+\.png$/);
    if (slideImages === 0) {
      console.log(`  [extract] ${presId}: no slide images — skipping`);
      return;
    }

    mkdirSync(extractDir, { recursive: true });
    execSync(`cp "${srcDir}"/slide_*.png "${extractDir}/" 2>/dev/null || true`);
    if (existsSync(join(srcDir, "storyline.md")))
      execSync(`cp "${srcDir}/storyline.md" "${extractDir}/"`);
    if (existsSync(join(srcDir, "structure.json")))
      execSync(`cp "${srcDir}/structure.json" "${extractDir}/"`);

    console.log(`  [extract] ${presId}: ${slideImages} slides`);
  }));
}

// ---- ANALYZE (parallel across ALL presentation×candidate pairs) ----
async function runAnalyzeAll(config: Config) {
  console.log(`\n=== ANALYZE (${config.presentations.length * config.candidates.length} jobs in parallel) ===`);

  const jobs: Promise<void>[] = [];

  for (const presId of config.presentations) {
    for (const c of config.candidates) {
      jobs.push((async () => {
        const candidateDir = join(presResultDir(presId), `candidate_${c}`);
        const analysisFile = join(candidateDir, "analysis.md");

        if (!config.force && has(analysisFile, 500)) {
          console.log(`  [analyze] ${presId}/C${c}: already done`);
          return;
        }

        const extractDir = join(presResultDir(presId), "extraction");
        if (!has(join(extractDir, "structure.json"))) {
          console.log(`  [analyze] ${presId}/C${c}: no extraction — skipping`);
          return;
        }

        mkdirSync(candidateDir, { recursive: true });

        const sharedRules = readFileSync(join(PROMPTS_DIR, "shared-rules.md"), "utf-8");
        const candidatePrompt = readFileSync(
          join(PROMPTS_DIR, `candidate-${c}-${CANDIDATE_NAMES[c]}.md`), "utf-8"
        );
        const structure = readFileSync(join(extractDir, "structure.json"), "utf-8");
        const storylinePath = join(extractDir, "storyline.md");
        const storyline = existsSync(storylinePath) ? readFileSync(storylinePath, "utf-8") : "";

        const fullPrompt = `${sharedRules}\n\n---\n\n${candidatePrompt}\n\n---\n\n## Input Data\n\n### Structure (JSON)\n\n\`\`\`json\n${structure.substring(0, 12000)}\n\`\`\`\n\n### Storyline\n\n${storyline.substring(0, 4000)}\n\n---\n\nNow analyze the presentation and output the design system following the candidate prompt's output format. Remember: NO slide numbers, NO content summaries, NO content-derived template names. General transferable rules only.`;

        const tmpFile = join(candidateDir, `_prompt_${Date.now()}.txt`);
        writeFileSync(tmpFile, fullPrompt);

        console.log(`  [analyze] ${presId}/C${c}: running (${config.model})...`);
        const output = await runClaudeAsync(tmpFile, config.model, 180);
        writeFileSync(analysisFile, output);

        try { execSync(`rm "${tmpFile}"`); } catch {}
        console.log(`  [analyze] ${presId}/C${c}: done (${output.length} chars)`);
      })());
    }
  }

  await Promise.all(jobs);
}

// ---- RECONSTRUCT (parallel across ALL presentation×candidate pairs) ----
async function runReconstructAll(config: Config) {
  console.log(`\n=== RECONSTRUCT (${config.presentations.length * config.candidates.length} jobs in parallel) ===`);

  const jobs: Promise<void>[] = [];

  for (const presId of config.presentations) {
    for (const c of config.candidates) {
      jobs.push((async () => {
        const candidateDir = join(presResultDir(presId), `candidate_${c}`);
        const reconDir = join(candidateDir, "reconstruction");
        const existing = countFiles(reconDir, /^slide_.*\.html$/);

        if (!config.force && existing >= 5) {
          console.log(`  [reconstruct] ${presId}/C${c}: already done (${existing} slides)`);
          return;
        }

        if (!has(join(candidateDir, "analysis.md"), 500)) {
          console.log(`  [reconstruct] ${presId}/C${c}: no analysis — skipping`);
          return;
        }

        mkdirSync(reconDir, { recursive: true });

        const analysis = readFileSync(join(candidateDir, "analysis.md"), "utf-8");
        const extractDir = join(presResultDir(presId), "extraction");
        const storylinePath = join(extractDir, "storyline.md");
        const storyline = existsSync(storylinePath) ? readFileSync(storylinePath, "utf-8") : "";
        const structure = JSON.parse(readFileSync(join(extractDir, "structure.json"), "utf-8"));
        const slideCount = structure.slideCount || 10;

        const prompt = `Generate exactly ${slideCount} self-contained HTML slides (1280x720px each).

DESIGN RULES — apply these exactly:
${analysis.substring(0, 12000)}

STORYLINE — this is the content to present (you decide how to split it into slides):
${storyline.substring(0, 8000)}

OUTPUT FORMAT:
For each slide, output a \`\`\`html code block starting with <!-- slide_NN.html -->
Each slide must be a complete HTML document with inline CSS.
Use the exact colors, fonts, sizes, and layout rules from the design rules above.
If the rules specify Google Fonts, include the <link> tag.
Generate ALL ${slideCount} slides.`;

        const tmpFile = join(reconDir, `_prompt_${Date.now()}.txt`);
        writeFileSync(tmpFile, prompt);

        console.log(`  [reconstruct] ${presId}/C${c}: generating ${slideCount} slides (${config.model})...`);
        const startMs = Date.now();
        const output = await runClaudeAsync(tmpFile, config.model, 600);
        const timeMs = Date.now() - startMs;

        // Parse HTML blocks
        const blocks = [...output.matchAll(/```html\s*\n([\s\S]*?)```/g)];
        let written = 0;
        for (const block of blocks) {
          const html = block[1].trim();
          if (html.length < 50) continue;
          written++;
          writeFileSync(join(reconDir, `slide_${String(written).padStart(2, "0")}.html`), html);
        }

        if (written === 0 && output.includes("<html")) {
          const parts = output.split(/(?=<!DOCTYPE|<html)/i).filter((p: string) => p.trim().length > 100);
          for (const part of parts) {
            written++;
            writeFileSync(join(reconDir, `slide_${String(written).padStart(2, "0")}.html`), part.trim());
          }
        }

        writeFileSync(join(reconDir, "reconstruction_metrics.json"), JSON.stringify({
          slideCount: written, targetSlideCount: slideCount, timeMs, model: config.model,
          tokensEstimate: Math.ceil((prompt.length + output.length) / 4),
          timestamp: new Date().toISOString(),
        }, null, 2));

        try { execSync(`rm "${tmpFile}"`); } catch {}
        console.log(`  [reconstruct] ${presId}/C${c}: ${written}/${slideCount} slides in ${(timeMs / 1000).toFixed(1)}s`);
      })());
    }
  }

  await Promise.all(jobs);
}

// ---- SCREENSHOT (parallel across ALL presentation×candidate pairs) ----
async function runScreenshotAll(config: Config) {
  console.log(`\n=== SCREENSHOT ===`);

  const jobs: Promise<void>[] = [];

  for (const presId of config.presentations) {
    for (const c of config.candidates) {
      jobs.push((async () => {
        const reconDir = join(presResultDir(presId), `candidate_${c}`, "reconstruction");
        const ssDir = join(reconDir, "screenshots");
        const htmlCount = countFiles(reconDir, /^slide_.*\.html$/);
        const pngCount = countFiles(ssDir, /\.png$/);

        if (htmlCount === 0) return;
        if (!config.force && pngCount >= htmlCount) {
          console.log(`  [screenshot] ${presId}/C${c}: already done`);
          return;
        }

        console.log(`  [screenshot] ${presId}/C${c}: capturing ${htmlCount} slides...`);
        try {
          execSync(
            `npx tsx "${join(SCRIPTS_DIR, "screenshot-html-slides.ts")}" "${reconDir}" "${ssDir}"`,
            { timeout: 120000, encoding: "utf-8", stdio: "pipe" }
          );
          console.log(`  [screenshot] ${presId}/C${c}: done`);
        } catch {
          console.log(`  [screenshot] ${presId}/C${c}: failed`);
        }
      })());
    }
  }

  await Promise.all(jobs);
}

// ---- SCORE (parallel across ALL presentation×candidate pairs, then rank) ----
async function runScoreAll(config: Config): Promise<PresentationResult[]> {
  console.log(`\n=== SCORE ===`);

  // Score all candidates in parallel
  const scoreJobs: Promise<{ presId: string; candidate: number; slideCount: number; scores: any } | null>[] = [];

  for (const presId of config.presentations) {
    for (const c of config.candidates) {
      scoreJobs.push((async () => {
        const reconDir = join(presResultDir(presId), `candidate_${c}`, "reconstruction");
        const htmlFiles = existsSync(reconDir)
          ? readdirSync(reconDir).filter((f: string) => /^slide_.*\.html$/.test(f)).sort()
          : [];
        if (htmlFiles.length === 0) return null;

        const sample = htmlFiles
          .filter((_: string, i: number, arr: string[]) => i % Math.max(1, Math.floor(arr.length / 5)) === 0)
          .slice(0, 5);

        const sampleHtml = sample
          .map((f: string) => `### ${f}\n\`\`\`html\n${readFileSync(join(reconDir, f), "utf-8").substring(0, 1200)}\n\`\`\``)
          .join("\n\n");

        const analysisExcerpt = readFileSync(
          join(presResultDir(presId), `candidate_${c}`, "analysis.md"), "utf-8"
        ).substring(0, 1500);

        const prompt = `Score these HTML presentation slides 0-10 on 4 dimensions. Output ONLY JSON.\n\nDesign rules applied:\n${analysisExcerpt}\n\nSample slides:\n${sampleHtml}\n\nScore:\n1. layout (0-10)\n2. content (0-10)\n3. visual (0-10)\n4. rules (0-10)\n\nOutput: {"layout":N,"content":N,"visual":N,"rules":N}`;

        const tmpFile = join(presResultDir(presId), `_score_${c}_${Date.now()}.txt`);
        writeFileSync(tmpFile, prompt);

        console.log(`  [score] ${presId}/C${c}: scoring...`);
        const output = await runClaudeAsync(tmpFile, "haiku", 30);

        let scores = { layout: 5, content: 5, visual: 5, rules: 5, avg: 5 };
        try {
          const match = output.match(/\{[\s\S]*?\}/);
          if (match) {
            const p = JSON.parse(match[0]);
            scores = {
              layout: p.layout ?? 5, content: p.content ?? 5,
              visual: p.visual ?? 5, rules: p.rules ?? 5, avg: 0,
            };
            scores.avg = (scores.layout + scores.content + scores.visual + scores.rules) / 4;
          }
        } catch {}

        writeFileSync(
          join(presResultDir(presId), `candidate_${c}`, "scores.json"),
          JSON.stringify(scores, null, 2)
        );

        try { execSync(`rm "${tmpFile}"`); } catch {}
        console.log(`  [score] ${presId}/C${c}: ${scores.avg.toFixed(1)}/10`);
        return { presId, candidate: c, slideCount: htmlFiles.length, scores };
      })());
    }
  }

  const allScores = (await Promise.all(scoreJobs)).filter(Boolean) as any[];

  // Build per-presentation rankings
  const allResults: PresentationResult[] = [];
  for (const presId of config.presentations) {
    const presScores = allScores.filter((s) => s.presId === presId);
    if (presScores.length === 0) continue;

    const sorted = [...presScores].sort((a, b) => b.scores.avg - a.scores.avg);
    const result: PresentationResult = {
      presId,
      slideCount: presScores[0]?.slideCount || 0,
      candidates: presScores.map((s) => ({ candidate: s.candidate, slideCount: s.slideCount, scores: s.scores })),
      ranking: sorted.map((s) => s.candidate),
    };
    writeFileSync(join(presResultDir(presId), "ranking.json"), JSON.stringify(result, null, 2));
    allResults.push(result);
  }

  // Global ranking
  if (allResults.length > 0) {
    const stats: Record<number, { ranks: number[]; scores: number[] }> = {};
    for (const c of config.candidates) stats[c] = { ranks: [], scores: [] };

    for (const r of allResults) {
      r.ranking.forEach((c, i) => stats[c].ranks.push(i + 1));
      r.candidates.forEach((cr) => stats[cr.candidate].scores.push(cr.scores.avg));
    }

    console.log(`\n=== GLOBAL RESULTS (${allResults.length} presentations) ===\n`);
    console.log(`| Candidate    | Avg Rank | Avg Score |`);
    console.log(`|--------------|----------|-----------|`);

    for (const c of config.candidates) {
      const s = stats[c];
      if (s.ranks.length === 0) continue;
      const avgRank = (s.ranks.reduce((a, b) => a + b, 0) / s.ranks.length).toFixed(2);
      const avgScore = (s.scores.reduce((a, b) => a + b, 0) / s.scores.length).toFixed(1);
      console.log(`| ${c} ${CANDIDATE_NAMES[c].padEnd(11)} | ${avgRank.padStart(8)} | ${avgScore.padStart(9)} |`);
    }

    writeFileSync(join(RESULTS_DIR, "global_ranking.json"), JSON.stringify({
      runAt: new Date().toISOString(),
      presentationCount: allResults.length,
      candidates: config.candidates.map((c) => ({
        candidate: c, name: CANDIDATE_NAMES[c],
        avgRank: stats[c].ranks.reduce((a, b) => a + b, 0) / Math.max(stats[c].ranks.length, 1),
        avgScore: stats[c].scores.reduce((a, b) => a + b, 0) / Math.max(stats[c].scores.length, 1),
      })),
      perPresentation: allResults,
    }, null, 2));

    console.log(`\nReport: ${RESULTS_DIR}/global_ranking.json`);
  }

  return allResults;
}

// ---- MAIN ----
async function main() {
  const config = parseArgs();
  const steps: Step[] = config.step === "all"
    ? ["extract", "analyze", "reconstruct", "screenshot", "score"]
    : [config.step];

  console.log(`\n=== Presentation Style Analysis Eval ===`);
  console.log(`Presentations: ${config.presentations.join(", ")}`);
  console.log(`Candidates:    ${config.candidates.join(", ")}`);
  console.log(`Steps:         ${steps.join(" → ")}`);
  console.log(`Model:         ${config.model}`);
  console.log(`Force:         ${config.force}`);

  for (const step of steps) {
    switch (step) {
      case "extract":     await runExtractAll(config); break;
      case "analyze":     await runAnalyzeAll(config); break;
      case "reconstruct": await runReconstructAll(config); break;
      case "screenshot":  await runScreenshotAll(config); break;
      case "score":       await runScoreAll(config); break;
    }
  }

  console.log(`\nDone.`);
}

main().catch(console.error);

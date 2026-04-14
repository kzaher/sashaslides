#!/usr/bin/env npx tsx
/**
 * run-layout-eval.ts — Eval pipeline for layout matching prompt candidates
 *
 * For each candidate (1-3), for each test slide:
 *   1. Describe the target slide (PNG → text)
 *   2. Describe all template slides (from other decks)
 *   3. Match target against templates → top-2
 *   4. Score: 1st match correct layout = 1.0, 2nd match = 0.6, else = 0
 *
 * Usage:
 *   npx tsx run-layout-eval.ts                         # all candidates, all decks
 *   npx tsx run-layout-eval.ts --candidate 2           # one candidate only
 *   npx tsx run-layout-eval.ts --target-deck airbnb-seed-2009  # one target deck
 *   npx tsx run-layout-eval.ts --max-targets 5         # limit target slides per deck
 *   npx tsx run-layout-eval.ts --force                 # re-run even if cached
 *   npx tsx run-layout-eval.ts --model sonnet          # use sonnet instead of haiku
 *   npx tsx run-layout-eval.ts --step describe         # only run describe step
 *   npx tsx run-layout-eval.ts --step match            # only run match step (uses cached descriptions)
 *   npx tsx run-layout-eval.ts --step score            # only score from cached match results
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";

const ANALYSIS_DIR = join(dirname(new URL(import.meta.url).pathname), "..");
const PRES_DIR = join(ANALYSIS_DIR, "presentations");
const PROMPTS_DIR = join(ANALYSIS_DIR, "prompts", "layout-matching");
const RESULTS_DIR = join(ANALYSIS_DIR, "layout-matching", "eval-results");
const GT_PATH = join(ANALYSIS_DIR, "layout-matching", "ground-truth.json");

const CANDIDATE_NAMES: Record<number, string> = {
  1: "structural",
  2: "semantic",
  3: "tag",
  4: "hybrid",
};

interface Config {
  candidates: number[];
  targetDeck: string | null;
  maxTargets: number;
  force: boolean;
  model: string;
  step: "all" | "describe" | "match" | "score";
  concurrency: number;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    candidates: [1, 2, 3, 4],
    targetDeck: null,
    maxTargets: Infinity,
    force: false,
    model: "haiku",
    step: "all",
    concurrency: 8,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--candidate": config.candidates = [parseInt(args[++i])]; break;
      case "--target-deck": config.targetDeck = args[++i]; break;
      case "--max-targets": config.maxTargets = parseInt(args[++i]); break;
      case "--force": config.force = true; break;
      case "--model": config.model = args[++i]; break;
      case "--step": config.step = args[++i] as Config["step"]; break;
      case "--concurrency": config.concurrency = parseInt(args[++i]); break;
    }
  }
  return config;
}

/** Get all decks that have slide PNGs */
function getDecks(): string[] {
  const manifest = JSON.parse(readFileSync(join(PRES_DIR, "manifest.json"), "utf-8"));
  return manifest.presentations.map((p: any) => p.id).filter((id: string) => {
    const dir = join(PRES_DIR, id);
    return existsSync(dir) && readdirSync(dir).some((f: string) => /^slide_\d+\.png$/.test(f));
  });
}

/** Get slide PNGs for a deck */
function getSlidePngs(deckId: string): string[] {
  const dir = join(PRES_DIR, deckId);
  return readdirSync(dir)
    .filter((f: string) => /^slide_\d+\.png$/.test(f))
    .sort()
    .map((f: string) => join(dir, f));
}

function slideId(pngPath: string): string {
  const parts = pngPath.split("/");
  const deck = parts[parts.length - 2];
  const slide = parts[parts.length - 1].replace(".png", "");
  return `${deck}/${slide}`;
}

/** Run claude -p — writes prompt to temp file for large inputs (>5KB stdin hangs) */
function runClaude(prompt: string, model: string, timeoutSec = 60): Promise<string> {
  const tmpDir = "/tmp/layout-eval";
  mkdirSync(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `prompt_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(tmpFile, prompt);

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `claude -p --model ${model} --dangerously-skip-permissions --allowedTools Read < "${tmpFile}"`], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutSec * 1000,
    });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("close", () => {
      try { execSync(`rm -f "${tmpFile}"`); } catch {}
      resolve(stdout.trim());
    });
    child.on("error", () => {
      try { execSync(`rm -f "${tmpFile}"`); } catch {}
      resolve(stdout.trim());
    });
  });
}

/** Describe a single slide */
async function describeOne(pngPath: string, candidateId: number, model: string): Promise<{ id: string; text: string }> {
  const name = CANDIDATE_NAMES[candidateId];
  const shared = readFileSync(join(PROMPTS_DIR, "shared-describe.md"), "utf-8");
  const candidate = readFileSync(join(PROMPTS_DIR, `candidate-${candidateId}-${name}-describe.md`), "utf-8");

  const prompt = `First, read the image at ${pngPath} using the Read tool, then follow these instructions:

${shared}

---

${candidate}

Analyze the slide image and produce the layout description in the specified format. Output ONLY the formatted description, no preamble.`;

  const text = await runClaude(prompt, model, 60);
  return { id: slideId(pngPath), text };
}

/** Run match: target description vs template descriptions → top-2 */
async function matchOne(
  target: { id: string; text: string },
  templates: { id: string; text: string }[],
  candidateId: number,
  model: string
): Promise<{ targetId: string; matches: { id: string; reason: string }[]; raw: string }> {
  const name = CANDIDATE_NAMES[candidateId];
  const shared = readFileSync(join(PROMPTS_DIR, "shared-match.md"), "utf-8");
  const candidate = readFileSync(join(PROMPTS_DIR, `candidate-${candidateId}-${name}-match.md`), "utf-8");

  const templateBlock = templates
    .map((t) => `### Template: ${t.id}\n${t.text}`)
    .join("\n\n");

  const prompt = `${shared}

---

${candidate}

---

## TARGET

### Target: ${target.id}
${target.text}

## TEMPLATES

${templateBlock}

---

Now find the 2 best-matching templates. Output ONLY the JSON.`;

  const raw = await runClaude(prompt, model, 45);

  let matches: { id: string; reason: string }[] = [];
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"matches"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      matches = parsed.matches || [];
    }
  } catch {
    console.error(`  [match] Parse failed for ${target.id}: ${raw.substring(0, 100)}`);
  }

  return { targetId: target.id, matches, raw };
}

/** Score a match result against ground truth */
function scoreMatch(
  targetId: string,
  matches: { id: string; reason: string }[],
  labels: Record<string, string>
): { score: number; detail: string } {
  const targetLabel = labels[targetId];
  if (!targetLabel) return { score: 0, detail: "no ground truth label for target" };

  if (matches.length >= 1 && labels[matches[0].id] === targetLabel) {
    return { score: 1.0, detail: `1st match ${matches[0].id} (${labels[matches[0].id]}) = correct` };
  }
  if (matches.length >= 2 && labels[matches[1].id] === targetLabel) {
    return { score: 0.6, detail: `2nd match ${matches[1].id} (${labels[matches[1].id]}) = correct` };
  }

  const matchLabels = matches.map((m) => `${m.id}(${labels[m.id] || "?"})`).join(", ");
  return { score: 0, detail: `no match — target=${targetLabel}, got=[${matchLabels}]` };
}

/** Run batched with concurrency limit */
async function batchRun<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ---- MAIN ----
async function main() {
  const config = parseArgs();
  const gt = JSON.parse(readFileSync(GT_PATH, "utf-8"));
  const labels: Record<string, string> = gt.layout_labels;
  const decks = getDecks();

  console.log(`Layout Matching Eval`);
  console.log(`  Decks: ${decks.join(", ")}`);
  console.log(`  Candidates: ${config.candidates.join(", ")}`);
  console.log(`  Model: ${config.model}`);
  console.log(`  Step: ${config.step}`);
  console.log();

  mkdirSync(RESULTS_DIR, { recursive: true });

  // Collect all slide PNGs grouped by deck
  const deckSlides: Record<string, string[]> = {};
  for (const d of decks) deckSlides[d] = getSlidePngs(d);

  // For each candidate
  for (const c of config.candidates) {
    const cName = CANDIDATE_NAMES[c];
    const cDir = join(RESULTS_DIR, `candidate_${c}`);
    mkdirSync(cDir, { recursive: true });

    const descCacheFile = join(cDir, "descriptions.json");
    let descriptions: Record<string, string> = {};

    // ---- DESCRIBE STEP ----
    if (config.step === "all" || config.step === "describe") {
      console.log(`=== DESCRIBE (Candidate ${c}: ${cName}) ===`);

      // Load cached descriptions
      if (!config.force && existsSync(descCacheFile)) {
        descriptions = JSON.parse(readFileSync(descCacheFile, "utf-8"));
        console.log(`  Loaded ${Object.keys(descriptions).length} cached descriptions`);
      }

      // Find slides that need describing
      const allPngs = decks.flatMap((d) => deckSlides[d]);
      const needDescribe = allPngs.filter((png) => !descriptions[slideId(png)]);

      if (needDescribe.length > 0) {
        console.log(`  Describing ${needDescribe.length} slides (concurrency=${config.concurrency})...`);
        const newDescs = await batchRun(
          needDescribe,
          async (png) => {
            const id = slideId(png);
            console.log(`    [describe] ${id}...`);
            const result = await describeOne(png, c, config.model);
            console.log(`    [describe] ${id}: ${result.text.length} chars`);
            return result;
          },
          config.concurrency
        );

        for (const d of newDescs) {
          descriptions[d.id] = d.text;
        }

        writeFileSync(descCacheFile, JSON.stringify(descriptions, null, 2));
        console.log(`  Saved ${Object.keys(descriptions).length} descriptions to cache`);
      } else {
        console.log(`  All slides already described`);
      }
    } else if (existsSync(descCacheFile)) {
      descriptions = JSON.parse(readFileSync(descCacheFile, "utf-8"));
    }

    if (config.step === "describe") continue;

    // ---- MATCH STEP ----
    const matchResultsFile = join(cDir, "match-results.json");
    let matchResults: Record<string, { matches: { id: string; reason: string }[]; raw: string }> = {};

    if (config.step === "all" || config.step === "match") {
      console.log(`\n=== MATCH (Candidate ${c}: ${cName}) ===`);

      if (!config.force && existsSync(matchResultsFile)) {
        matchResults = JSON.parse(readFileSync(matchResultsFile, "utf-8"));
        console.log(`  Loaded ${Object.keys(matchResults).length} cached match results`);
      }

      // Build test cases: for each deck, select targets; templates = slides from OTHER decks
      const testCases: { targetId: string; targetDesc: string; templates: { id: string; text: string }[] }[] = [];

      for (const targetDeck of decks) {
        if (config.targetDeck && targetDeck !== config.targetDeck) continue;

        const targetPngs = deckSlides[targetDeck].slice(0, config.maxTargets);
        const templateDecks = decks.filter((d) => d !== targetDeck);
        const templateDescs = templateDecks.flatMap((d) =>
          deckSlides[d].map((png) => {
            const id = slideId(png);
            return { id, text: descriptions[id] || "" };
          })
        ).filter((t) => t.text.length > 0);

        for (const png of targetPngs) {
          const id = slideId(png);
          if (matchResults[id] && !config.force) continue;
          if (!descriptions[id]) continue;

          testCases.push({
            targetId: id,
            targetDesc: descriptions[id],
            templates: templateDescs,
          });
        }
      }

      if (testCases.length > 0) {
        console.log(`  Matching ${testCases.length} targets against templates (concurrency=${config.concurrency})...`);
        const newMatches = await batchRun(
          testCases,
          async (tc) => {
            console.log(`    [match] ${tc.targetId} vs ${tc.templates.length} templates...`);
            const result = await matchOne(
              { id: tc.targetId, text: tc.targetDesc },
              tc.templates,
              c,
              config.model
            );
            const matchIds = result.matches.map((m) => m.id).join(", ");
            console.log(`    [match] ${tc.targetId} → [${matchIds}]`);
            return result;
          },
          config.concurrency
        );

        for (const m of newMatches) {
          matchResults[m.targetId] = { matches: m.matches, raw: m.raw };
        }

        writeFileSync(matchResultsFile, JSON.stringify(matchResults, null, 2));
        console.log(`  Saved ${Object.keys(matchResults).length} match results`);
      } else {
        console.log(`  All matches already computed`);
      }
    } else if (existsSync(matchResultsFile)) {
      matchResults = JSON.parse(readFileSync(matchResultsFile, "utf-8"));
    }

    if (config.step === "match") continue;

    // ---- SCORE STEP ----
    console.log(`\n=== SCORE (Candidate ${c}: ${cName}) ===`);

    let totalScore = 0;
    let totalTests = 0;
    const scoreDetails: { targetId: string; score: number; detail: string }[] = [];
    const perCategory: Record<string, { total: number; score: number }> = {};

    for (const [targetId, result] of Object.entries(matchResults)) {
      const { score, detail } = scoreMatch(targetId, result.matches, labels);
      scoreDetails.push({ targetId, score, detail });
      totalScore += score;
      totalTests++;

      const cat = labels[targetId] || "unknown";
      if (!perCategory[cat]) perCategory[cat] = { total: 0, score: 0 };
      perCategory[cat].total++;
      perCategory[cat].score += score;

      const icon = score === 1.0 ? "+" : score === 0.6 ? "~" : "-";
      console.log(`  [${icon}] ${targetId}: ${score} — ${detail}`);
    }

    const avgScore = totalTests > 0 ? totalScore / totalTests : 0;
    console.log(`\n  Candidate ${c} (${cName}): ${avgScore.toFixed(3)} avg score (${totalScore.toFixed(1)}/${totalTests} tests)`);
    console.log(`  Per-category:`);
    for (const [cat, { total, score }] of Object.entries(perCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`    ${cat}: ${(score / total).toFixed(2)} (${score.toFixed(1)}/${total})`);
    }

    // Save scores
    const scoresFile = join(cDir, "scores.json");
    writeFileSync(scoresFile, JSON.stringify({
      candidate: c,
      name: cName,
      avgScore,
      totalScore,
      totalTests,
      perCategory,
      details: scoreDetails,
    }, null, 2));
  }

  // ---- GLOBAL RANKING ----
  if (config.step === "all" || config.step === "score") {
    console.log(`\n=== GLOBAL RANKING ===`);

    const ranking: { candidate: number; name: string; avgScore: number; totalScore: number; totalTests: number }[] = [];

    for (const c of [1, 2, 3, 4]) {
      const scoresFile = join(RESULTS_DIR, `candidate_${c}`, "scores.json");
      if (existsSync(scoresFile)) {
        const scores = JSON.parse(readFileSync(scoresFile, "utf-8"));
        ranking.push({
          candidate: scores.candidate,
          name: scores.name,
          avgScore: scores.avgScore,
          totalScore: scores.totalScore,
          totalTests: scores.totalTests,
        });
      }
    }

    ranking.sort((a, b) => b.avgScore - a.avgScore);

    console.log(`\n  Rank | Candidate | Avg Score | Total`);
    console.log(`  -----|-----------|-----------|------`);
    for (let i = 0; i < ranking.length; i++) {
      const r = ranking[i];
      console.log(`  ${i + 1}    | C${r.candidate} ${r.name.padEnd(12)} | ${r.avgScore.toFixed(3)}     | ${r.totalScore.toFixed(1)}/${r.totalTests}`);
    }

    writeFileSync(join(RESULTS_DIR, "global_ranking.json"), JSON.stringify({
      runAt: new Date().toISOString(),
      model: parseArgs().model,
      ranking,
    }, null, 2));
  }
}

main().catch(console.error);

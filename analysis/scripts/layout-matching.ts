#!/usr/bin/env npx tsx
/**
 * layout-matching.ts — Library for slide layout description + matching
 *
 * Two operations:
 *   1. describe(slidePng, candidateId) → textual layout description
 *   2. match(targetDesc, templateDescs[], candidateId) → top-2 ranked template IDs
 *
 * Uses claude -p with haiku for cheap/fast inference.
 */

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";

const PROMPTS_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "prompts", "layout-matching");

const CANDIDATE_NAMES: Record<number, string> = {
  1: "structural",
  2: "semantic",
  3: "tag",
};

export interface LayoutDescription {
  id: string;          // e.g. "airbnb-seed-2009/slide_03"
  candidateId: number;
  text: string;        // raw description output
}

export interface MatchResult {
  targetId: string;
  matches: { id: string; reason: string }[];
  raw: string;
}

/** Run claude -p and return stdout */
function runClaude(prompt: string, model = "haiku", timeoutSec = 60): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--model", model, "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutSec * 1000,
    });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("close", () => resolve(stdout.trim()));
    child.on("error", () => resolve(stdout.trim()));

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Run claude -p with an image attachment */
function runClaudeWithImage(prompt: string, imagePath: string, model = "haiku", timeoutSec = 60): Promise<string> {
  return new Promise((resolve) => {
    // Write prompt to temp file, reference image inline
    const tmpDir = "/tmp/layout-match";
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, `prompt_${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt);

    const child = spawn("claude", [
      "-p", "--model", model, "--dangerously-skip-permissions",
      "--allowedTools", "Read",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutSec * 1000,
    });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("close", () => {
      try { execSync(`rm -f "${tmpFile}"`); } catch {}
      resolve(stdout.trim());
    });
    child.on("error", () => resolve(stdout.trim()));

    // Prompt includes instruction to read the image
    const fullPrompt = `First, read the image at ${imagePath} using the Read tool, then follow these instructions:\n\n${prompt}`;
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

/** Describe a single slide's layout */
export async function describeSlide(
  slidePng: string,
  candidateId: number,
  model = "haiku"
): Promise<LayoutDescription> {
  const name = CANDIDATE_NAMES[candidateId];
  const shared = readFileSync(join(PROMPTS_DIR, "shared-describe.md"), "utf-8");
  const candidate = readFileSync(join(PROMPTS_DIR, `candidate-${candidateId}-${name}-describe.md`), "utf-8");

  const prompt = `${shared}\n\n---\n\n${candidate}\n\nAnalyze the slide image and produce the layout description in the specified format. Output ONLY the formatted description, no preamble.`;

  const text = await runClaudeWithImage(prompt, slidePng, model);

  // Derive ID from path: .../airbnb-seed-2009/slide_03.png → airbnb-seed-2009/slide_03
  const parts = slidePng.split("/");
  const deck = parts[parts.length - 2];
  const slide = basename(slidePng, ".png");
  const id = `${deck}/${slide}`;

  return { id, candidateId, text };
}

/** Describe multiple slides in parallel */
export async function describeSlides(
  slidePngs: string[],
  candidateId: number,
  model = "haiku",
  concurrency = 5
): Promise<LayoutDescription[]> {
  const results: LayoutDescription[] = [];

  for (let i = 0; i < slidePngs.length; i += concurrency) {
    const batch = slidePngs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((png) => describeSlide(png, candidateId, model))
    );
    results.push(...batchResults);
  }

  return results;
}

/** Match a target description against template descriptions → top-2 */
export async function matchLayout(
  target: LayoutDescription,
  templates: LayoutDescription[],
  candidateId: number,
  model = "haiku"
): Promise<MatchResult> {
  const name = CANDIDATE_NAMES[candidateId];
  const shared = readFileSync(join(PROMPTS_DIR, "shared-match.md"), "utf-8");
  const candidate = readFileSync(join(PROMPTS_DIR, `candidate-${candidateId}-${name}-match.md`), "utf-8");

  const templateBlock = templates
    .map((t) => `### Template: ${t.id}\n${t.text}`)
    .join("\n\n");

  const prompt = `${shared}\n\n---\n\n${candidate}\n\n---\n\n## TARGET\n\n### Target: ${target.id}\n${target.text}\n\n## TEMPLATES\n\n${templateBlock}\n\n---\n\nNow find the 2 best-matching templates. Output ONLY the JSON.`;

  const raw = await runClaude(prompt, model, 30);

  // Parse JSON from response
  let matches: { id: string; reason: string }[] = [];
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"matches"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      matches = parsed.matches || [];
    }
  } catch {
    console.error(`  [match] Failed to parse JSON for ${target.id}: ${raw.substring(0, 200)}`);
  }

  return { targetId: target.id, matches, raw };
}

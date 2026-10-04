/**
 * The workflow this connector teaches its own client, returned as the MCP `instructions`
 * string in the `initialize` result.
 *
 * This is the "the skill ships with the connector" mechanism: the spec says a server MAY
 * return `instructions` describing how to use it, which clients place in the system prompt.
 * Measured against real Claude Code 2.1.285 in `e2e/connector-guidance-probe.ts`: it is
 * delivered, retained and acted on - which is why a user who adds the connector does not
 * also have to install a skill.
 *
 * **The text is NOT written here. It is `.claude/skills/sasha-slides/SKILL.md`, minus its
 * YAML frontmatter.** One source of truth, one place to edit: the local skill and the
 * connector cannot say different things, and "where do I change the instructions?" has
 * exactly one answer. Nothing in this file paraphrases, re-orders or re-authors that content
 * - the only transformations are dropping the frontmatter and dropping whole sections that do
 * not fit the client's budget. If something in the skill is wrong for a connector-only
 * reader, it is wrong in the skill too and is fixed there.
 *
 * **Read at startup, not inlined at build time.** This repository has no build step for the
 * server - `npx tsx server.ts` runs the sources - so a build-time inline would mean a
 * generator plus a freshness gate to catch a stale generated file: two more things that can
 * drift in exchange for nothing. The markdown sits next to the server in the same tree and is
 * read once per process, at `createSashaSlidesServer` time, never per request.
 *
 * **A missing file degrades, it does not crash.** The whole point of the feature is the user
 * who installed only the connector, so `loadWorkflowInstructions` falls back to
 * `FALLBACK_WORKFLOW_INSTRUCTIONS` - terse, but enough that the agent still gets the rules
 * whose violation costs the user real money. `test/workflow-guidance.test.ts` proves both
 * paths against a real `server.ts --stdio` subprocess, the fallback one via
 * `--skill-file <nonexistent>`.
 *
 * **The client's budget is 2048 characters, measured, and the server respects it rather than
 * being clipped by it.** See `CLAUDE_CODE_INSTRUCTIONS_BUDGET`. Left to itself Claude Code
 * cuts the string mid-sentence at that offset and appends "… [truncated]", which silently
 * threw away the whole second half of the skill - the 1-based rule, the loop and the Never
 * list all disappeared while the connector looked healthy. `fitInstructions` instead drops
 * whole sections, lowest-priority first, and says which ones it dropped.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type WorkflowInstructions = Readonly<{
  /** What the server returns in `initialize`. Never empty. */
  text: string;
  source: WorkflowInstructionsSource;
  /** Section headings the budget forced out, in document order. Empty when all of it fit. */
  omittedHeadings: readonly string[];
  /** Where it came from, or why it could not be read - for the startup banner. */
  detail: string;
}>;

export type WorkflowInstructionsSource = "skill-file" | "fallback";

/** Where the skill lives relative to the repository root. */
export const SKILL_RELATIVE_PATH = ".claude/skills/sasha-slides/SKILL.md";

/**
 * How many characters of `instructions` reach the model in Claude Code 2.1.285. **Measured,
 * not documented anywhere:** `e2e/connector-guidance-probe.ts` served a synthetic skill whose
 * lines are each exactly 16 characters (`L0001 ---------\n` …) and asked the client which line
 * was the last it could see. The answer was `L0128`, followed by a literal "… [truncated]"
 * marker - line 128 ends at byte 2048 exactly. The same cut was independently visible on the
 * real skill, whose served text stopped at offset 2048 mid-word ("one proposal at a tim…").
 *
 * So anything past 2048 characters is not guidance, it is a cost with no effect.
 */
export const CLAUDE_CODE_INSTRUCTIONS_BUDGET = 2048;

/**
 * Resolves the instructions, preferring the skill markdown. `readTextFile` is injected so the
 * decision logic is testable with no filesystem; `skillPaths` is tried in order and the first
 * readable one wins. `budget` of 0 means "serve it whole", for a client with no such limit.
 */
export function loadWorkflowInstructions(
  options: Readonly<{
    skillPaths: readonly string[];
    readTextFile: (path: string) => string;
    budget: number;
  }>,
): WorkflowInstructions {
  const { skillPaths, readTextFile, budget } = options;
  const failures: string[] = [];
  for (const path of skillPaths) {
    const read = tryReadTextFile({ path, readTextFile });
    if (read === null) {
      failures.push(path);
      continue;
    }
    const body = stripSkillFrontmatter(read);
    if (body === "") {
      failures.push(`${path} (no content below the frontmatter)`);
      continue;
    }
    const fitted = fitInstructions({ body, budget });
    return {
      text: fitted.text,
      source: "skill-file",
      omittedHeadings: fitted.omittedHeadings,
      detail:
        fitted.omittedHeadings.length === 0
          ? `${path} (${String(fitted.text.length)} chars, whole)`
          : `${path} (${String(fitted.text.length)}/${String(budget)} chars; omitted ${fitted.omittedHeadings.join(", ")})`,
    };
  }
  return {
    text: FALLBACK_WORKFLOW_INSTRUCTIONS,
    source: "fallback",
    omittedHeadings: [],
    detail: `built-in fallback; ${SKILL_RELATIVE_PATH} was not readable at ${failures.join(", ")}`,
  };
}

/**
 * Fits the skill body into `budget` characters by dropping whole sections, lowest priority
 * first, and appending one line naming what went. Sections that survive keep the skill's own
 * order and wording, so what the model reads is still the skill and not a summary of it.
 *
 * Whole sections rather than a character cut because a cut leaves the model with half a rule
 * and no way to know a rule is missing - which is exactly the failure mode the client's own
 * truncation produces.
 */
export function fitInstructions(
  options: Readonly<{ body: string; budget: number }>,
): Readonly<{ text: string; omittedHeadings: readonly string[] }> {
  const { body, budget } = options;
  const sections = splitSkillSections(body);
  if (budget <= 0) return { text: body, omittedHeadings: [] };

  // Drop the lowest-priority section until it fits. Iterative because the notice naming the
  // omissions grows as more are dropped, so the budget check has to be re-made each time.
  const dropOrder = [...sections].sort((left, right) => rankOf(right.heading) - rankOf(left.heading));
  const dropped = new Set<string>();
  for (const candidate of [null, ...dropOrder]) {
    if (candidate !== null) dropped.add(candidate.heading);
    const kept = sections.filter((section) => !dropped.has(section.heading));
    const omitted = sections.filter((section) => dropped.has(section.heading)).map((section) => section.heading);
    const text = renderInstructions({ kept, omitted, budget });
    if (text.length <= budget) return { text, omittedHeadings: omitted };
  }
  // Every section dropped and it still does not fit: the budget is smaller than the notice.
  // The fallback is the only honest thing left to serve.
  return { text: FALLBACK_WORKFLOW_INSTRUCTIONS.slice(0, budget), omittedHeadings: sections.map((section) => section.heading) };
}

export type SkillSection = Readonly<{ heading: string; text: string }>;

/**
 * Splits the markdown at its `##` headings. The leading block before the first `##` is a
 * section too, keyed by the document's own `#` title, because it says what the thing is and
 * nothing below it makes sense without it.
 */
export function splitSkillSections(body: string): readonly SkillSection[] {
  return body
    .split(/\n(?=## )/)
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .map((text) => ({ heading: (text.split("\n")[0] ?? "").trim(), text }));
}

/**
 * Heading prefixes in the order they earn their characters, most load-bearing first. The
 * ranking is by cost of the agent not knowing: breaking the file-path rule burns the user's
 * context window, re-indexing silently puts the wrong slide in their deck, and the Never list
 * is the shortest statement of both. The repo-local sections rank last because a
 * connector-only user cannot act on them at all.
 *
 * Prefixes, not full headings, so rewording a heading's tail does not silently re-rank it.
 * `test/workflow-guidance.test.ts` asserts every heading in the skill matches one of these,
 * so adding a section to the skill fails the build until someone ranks it.
 */
export const SECTION_PRIORITY: readonly string[] = [
  "# sasha-slides",
  "## The one rule that matters",
  // The loop is the PROCEDURE. It used to rank below "Get something on screen fast" and was
  // therefore the section the 2048-char budget dropped -- the connector taught the rules and
  // omitted how to actually run them. Advice ranks below instructions.
  "## The loop",
  "## Slides are 1-based",
  "## Candidates should differ",
  "## Never",
  "## Get something on screen fast",
  "## Anomalies and what cannot convert",
  // Ranked below the advice deliberately: these three tools are reached only once the user
  // has commented, and by then the agent has `read_feedback`'s own description in front of
  // it. The budget is better spent on the rules that stop the first call going wrong.
  "## Revise in place, clear loudly",
  "## Before the first call",
  "## Connecting the connector",
  "## Harness",
];

/**
 * The places the skill can be, in preference order: next to the server in its own checkout
 * first (that is the copy an operator edits), then the process's working directory, which is
 * how a deployment that unpacks the server elsewhere can still ship the file.
 *
 * `moduleDir` is this file's directory, two levels below the repository root
 * (`mcp/sasha-slides/`), and is passed in rather than read from `__dirname` here so the
 * composition root owns the one environment read.
 */
export function skillPathCandidates(
  options: Readonly<{ moduleDir: string; cwd: string; override: string | null }>,
): readonly string[] {
  const { moduleDir, cwd, override } = options;
  if (override !== null) return [isAbsolute(override) ? override : resolve(cwd, override)];
  return [resolve(moduleDir, "..", "..", SKILL_RELATIVE_PATH), join(cwd, SKILL_RELATIVE_PATH)];
}

/**
 * Drops a leading `---` … `---` YAML block. That block is Claude Code's skill metadata
 * (`name`, `description`, `user_invocable`) and is noise in a system prompt - the connector's
 * own name and description already reach the client through `serverInfo` and `tools/list`.
 * Markdown with no frontmatter is returned unchanged, so this is safe on either shape.
 */
export function stripSkillFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return normalized.trim();
  const afterOpen = normalized.indexOf("\n");
  if (afterOpen === -1) return normalized.trim();
  const close = normalized.indexOf("\n---", afterOpen);
  if (close === -1) return normalized.trim();
  const afterClose = normalized.indexOf("\n", close + 1);
  if (afterClose === -1) return "";
  return normalized.slice(afterClose + 1).trim();
}

/**
 * Used only when the skill markdown cannot be read. Deliberately the invariants and nothing
 * else: every rule here is one whose violation costs the user context or money, so a degraded
 * connector is still safe to use. It is not a summary of the skill and must not grow into one
 * - the skill is the source of truth, and a second full copy is the drift this design exists
 * to prevent.
 */
export const FALLBACK_WORKFLOW_INSTRUCTIONS = `sasha-slides offers the user a choice of candidate slides inside Google Slides and reports back which one they picked.

Its own usage guide could not be read, so these are the invariants only:

- Slide HTML travels by FILE PATH and is never read into context, going in or coming back. Write each candidate to its own file and pass the path. Never paste markup into a tool argument, never read a candidate back. Four candidates must cost the same context as one.
- Offer several candidates, not one; the user picks. The only slide text that crosses the boundary is the short \`label\` caption.
- Get something on screen fast: propose plausible candidates rather than polished ones, then think harder while the user looks. Only one proposal may be outstanding at a time.
- After \`propose_slides\`, call \`await_pick\` with the \`proposalId\`. It blocks, which is correct, and returns the pick plus any anomalies the user marked.
- Slides are 1-based everywhere, so "option 3" means the same slide to everyone.
- \`slide_images\` returns local paths, never image data. \`proposal_state\` reports markers and a manifest summary, never slide content.
- The user's review arrives as native Google Slides comments: \`read_feedback\`, \`await_feedback\`, \`reply_feedback\`, \`resolve_feedback\`. Answer where they asked.`;

/**
 * The composition root's reader: the one place that touches the filesystem and `__dirname`.
 * `__dirname` is correct under `tsx`, which emits CommonJS here because the root
 * package.json declares no `"type": "module"` (the same reason `server.ts` wraps its
 * top-level `await`).
 */
export function workflowInstructionsFromDisk(
  options: Readonly<{ cwd: string; override: string | null; budget: number }>,
): WorkflowInstructions {
  return loadWorkflowInstructions({
    skillPaths: skillPathCandidates({ moduleDir: __dirname, cwd: options.cwd, override: options.override }),
    readTextFile: (path) => readFileSync(path, "utf8"),
    budget: options.budget,
  });
}

/**
 * The kept sections in document order, plus one line saying the guide is abridged. The notice
 * matters: without it the model cannot tell an abridged guide from a complete one, and would
 * not know that there is more to ask the user for.
 *
 * It counts the omissions rather than naming them, because the names cost more than they buy
 * - listing six headings ran to 266 characters, which is more than a whole section, and spent
 * the budget on the sections that did NOT make it. The operator-facing list lives on
 * `WorkflowInstructions.detail`, which the startup banner prints.
 */
function renderInstructions(
  options: Readonly<{ kept: readonly SkillSection[]; omitted: readonly string[]; budget: number }>,
): string {
  const { kept, omitted, budget } = options;
  const body = kept.map((section) => section.text).join("\n\n");
  if (omitted.length === 0) return body;
  return (
    `${body}\n\n(Abridged to this client's ${String(budget)}-char limit; ` +
    `${String(omitted.length)} later section(s) of this guide were omitted.)`
  );
}

/** Lower is kept longer. An unranked heading sorts just after the ranked ones. */
function rankOf(heading: string): number {
  const at = SECTION_PRIORITY.findIndex((prefix) => heading.startsWith(prefix));
  return at === -1 ? SECTION_PRIORITY.length : at;
}

function tryReadTextFile(
  options: Readonly<{ path: string; readTextFile: (path: string) => string }>,
): string | null {
  try {
    return options.readTextFile(options.path);
  } catch {
    // Unreadable for any reason - absent, a directory, no permission - is one case here: the
    // caller's next candidate path, and ultimately the fallback. The reason is not actionable
    // by the server, and the startup banner already names every path that was tried.
    return null;
  }
}

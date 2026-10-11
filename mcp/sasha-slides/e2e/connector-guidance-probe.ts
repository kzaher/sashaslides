#!/usr/bin/env node
/**
 * Can the workflow be distributed *as part of the connector*, so a user who adds it does not
 * also have to install a skill or type a long prompt? Three candidate mechanisms exist; this
 * answers which of them actually reach the model in the real client, by measurement.
 *
 *   npx tsx mcp/sasha-slides/e2e/connector-guidance-probe.ts --probe instructions
 *   npx tsx mcp/sasha-slides/e2e/connector-guidance-probe.ts --probe prompts
 *   npx tsx mcp/sasha-slides/e2e/connector-guidance-probe.ts --probe tool-descriptions
 *   npx tsx mcp/sasha-slides/e2e/connector-guidance-probe.ts            # all three
 *
 * The client under test is a REAL `claude -p` subprocess - nothing is simulated, and nothing
 * is written to any persisted configuration: the server is handed over with
 * `--mcp-config <file> --strict-mcp-config`, which makes that file the whole MCP
 * configuration for exactly that one run.
 *
 * Every JSON-RPC frame of each run is captured on the server side through
 * `server.ts --frame-log`, so each verdict below is backed by frames on disk rather than by
 * the model's say-so. Two different claims are separated deliberately:
 *
 *   DELIVERED        the frame log proves the client asked for it / was given it.
 *   REACHES-THE-MODEL the client's own answer proves it was put in front of the model.
 *
 * `claude` is run in a temp directory OUTSIDE this repository on purpose, with
 * `--disable-slash-commands` on the instructions probe. The repo's own
 * `.claude/skills/sasha-slides/SKILL.md` and `CLAUDE.md` state the same rules, so a run
 * inside the repo could not distinguish "the connector taught it" from "it read the skill".
 *
 * Everything effectful - the clock, the work directory, the claude binary, the frame sink -
 * is injected, so `runConnectorGuidanceProbe` is drivable from a test.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { assertNever } from "../google-auth.ts";
import {
  CLAUDE_CODE_INSTRUCTIONS_BUDGET,
  SKILL_RELATIVE_PATH,
  stripSkillFrontmatter,
} from "../workflow-instructions.ts";
import { PROMPT_ARGUMENT_LOG_ENV, type ReceivedPromptArguments } from "./prompt-argument-probe-server.ts";

export type GuidanceMechanism =
  | "instructions"
  | "instructions-extent"
  | "prompts"
  | "prompt-arguments"
  | "tool-descriptions";

export type GuidanceVerdict =
  /** The frame log shows it crossing the wire AND the client's answer shows the model saw it. */
  | "reaches-the-model"
  /** It crossed the wire, but nothing in this run proves the model was shown it. */
  | "delivered-only"
  /** The client never asked for it, or never received it. */
  | "absent";

export type MechanismOutcome = Readonly<{
  mechanism: GuidanceMechanism;
  verdict: GuidanceVerdict;
  /** What the frames prove, one line per observation. */
  evidence: readonly string[];
  /** What the client printed, trimmed - the "reaches-the-model" half of the claim. */
  answer: string;
  /** Where the frames for this run were written. */
  frameLogPath: string;
}>;

export type GuidanceReport = Readonly<{ outcomes: readonly MechanismOutcome[] }>;

export const PROBE_SERVER_KEY = "sasha-slides";
/** Haiku is enough: the question is whether the text arrives, not how well it is reasoned about. */
export const PROBE_MODEL = "haiku";
/**
 * The extent probe is the exception. It asks the model to read the last line of a 400-line
 * ruler, and haiku will cheerfully estimate: one run answered "L0200" - exactly half - where
 * two others answered L0128 and L0127. Reading carefully IS the measurement here, so it gets a
 * stronger model, and `observe` refuses an answer that names the ruler's final line.
 */
export const CAREFUL_PROBE_MODEL = "sonnet";
/** A single non-interactive turn. Past this the run is stuck, not slow. */
export const PROBE_TIMEOUT_MS = 90_000;

/**
 * A line that exists ONLY in the workflow skill - in no tool description, and in nothing the
 * client could have inferred. Finding it in the server's `initialize` result is what proves
 * delivery; `assertSentinelIsInTheSkill` fails the probe if the skill is ever reworded past
 * it, so this cannot silently stop testing anything.
 */
export const INSTRUCTIONS_SENTINEL = "Four candidates must cost the same context as one";

/**
 * One line of the synthetic ruler the `instructions-extent` probe serves instead of the real
 * skill: `L0001 ---------\n` is exactly 16 characters, so line N ends at offset 16N and the
 * last line the model can see names the cap directly, with no arithmetic to get wrong.
 */
export const RULER_LINE_CHARS = 16;
export const RULER_LINES = 400;

/** The tool surface the control probe expects the client to be able to enumerate. */
export const EXPECTED_TOOLS: readonly string[] = [
  "propose_slides",
  "await_pick",
  "slide_images",
  "proposal_state",
  "read_feedback",
  "reply_feedback",
  "resolve_feedback",
  "await_feedback",
  "revise_slide",
  "clear_slides",
  "session_events",
];

export async function runConnectorGuidanceProbe(
  options: Readonly<{
    repoRoot: string;
    /** Where the config and frame logs are written. Created if missing. */
    workDir: string;
    /** Where `claude` is run. Must be outside `repoRoot`, or the repo's own skill leaks in. */
    cwd: string;
    claudeBin: string;
    mechanisms: readonly GuidanceMechanism[];
    log: (line: string) => void;
  }>,
): Promise<GuidanceReport> {
  const { repoRoot, workDir, cwd, claudeBin, mechanisms, log } = options;
  mkdirSync(workDir, { recursive: true });
  const configPath = join(workDir, "mcp-config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(mcpConfigFor({ repoRoot, frameLogPath: null, skillFile: null, budget: null }), null, 2)}\n`,
    "utf8",
  );

  assertSentinelIsInTheSkill({ repoRoot });
  writeFileSync(join(workDir, "RULER.md"), rulerSkill(), "utf8");
  const outcomes: MechanismOutcome[] = [];
  for (const mechanism of mechanisms) {
    log(`--- ${mechanism}`);
    outcomes.push(
      await probeMechanism({ mechanism, repoRoot, workDir, cwd, claudeBin, log }),
    );
  }
  return { outcomes };
}

/**
 * One `claude -p` run per mechanism. Each gets its own config file (pointing the server at
 * its own frame log) and its own prompt, chosen so that only that mechanism can answer it.
 */
export async function probeMechanism(
  options: Readonly<{
    mechanism: GuidanceMechanism;
    repoRoot: string;
    workDir: string;
    cwd: string;
    claudeBin: string;
    log: (line: string) => void;
  }>,
): Promise<MechanismOutcome> {
  const { mechanism, repoRoot, workDir, cwd, claudeBin, log } = options;
  const frameLogPath = join(workDir, `frames-${mechanism}.jsonl`);
  const configPath = join(workDir, `mcp-config-${mechanism}.json`);
  writeFileSync(frameLogPath, "", "utf8");
  // The extent probe needs the whole ruler on the wire, so it waives the server's own budget:
  // the question it asks is what the CLIENT keeps.
  const serving =
    mechanism === "instructions-extent"
      ? { skillFile: join(workDir, "RULER.md"), budget: 0 }
      : { skillFile: null, budget: null };
  const argumentLogPath = join(workDir, "received-prompt-arguments.jsonl");
  const config =
    mechanism === "prompt-arguments"
      ? promptArgumentConfigFor({ repoRoot, argumentLogPath })
      : mcpConfigFor({ repoRoot, frameLogPath, ...serving });
  if (mechanism === "prompt-arguments") writeFileSync(argumentLogPath, "", "utf8");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const plan = probePlan(mechanism);
  const run = await runClaude({
    claudeBin,
    cwd,
    args: [
      "-p",
      plan.prompt,
      "--mcp-config",
      configPath,
      "--strict-mcp-config",
      "--model",
      plan.model,
      "--permission-prompts",
      "none",
      ...plan.extraArgs,
    ],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  log(`    exit ${String(run.exitCode)} in ${String(run.elapsedMs)}ms`);
  const frames = readFrames({ path: frameLogPath });
  const observation = observe({
    mechanism,
    frames,
    answer: run.stdout,
    received: mechanism === "prompt-arguments" ? readReceivedArguments({ path: argumentLogPath }) : [],
  });
  return { mechanism, verdict: observation.verdict, evidence: observation.evidence, answer: run.stdout.trim(), frameLogPath };
}

/** The `.mcp.json`-shaped document handed to `--mcp-config`. Never written to a saved config. */
export function mcpConfigFor(
  options: Readonly<{
    repoRoot: string;
    frameLogPath: string | null;
    skillFile: string | null;
    budget: number | null;
  }>,
): Readonly<{ mcpServers: Readonly<Record<string, unknown>> }> {
  const { repoRoot, frameLogPath, skillFile, budget } = options;
  const serverArgs = ["tsx", join(repoRoot, "mcp/sasha-slides/server.ts"), "--stdio"];
  if (frameLogPath !== null) serverArgs.push("--frame-log", frameLogPath);
  if (skillFile !== null) serverArgs.push("--skill-file", skillFile);
  if (budget !== null) serverArgs.push("--instructions-budget", String(budget));
  return {
    mcpServers: {
      [PROBE_SERVER_KEY]: { command: "npx", args: serverArgs, cwd: repoRoot },
    },
  };
}

/**
 * The config for the argument-binding probe: a different server, because the question is about
 * the CLIENT's mapping and needs prompts whose only job is to report what arrived.
 */
export function promptArgumentConfigFor(
  options: Readonly<{ repoRoot: string; argumentLogPath: string }>,
): Readonly<{ mcpServers: Readonly<Record<string, unknown>> }> {
  const { repoRoot, argumentLogPath } = options;
  return {
    mcpServers: {
      argprobe: {
        command: "npx",
        args: ["tsx", join(repoRoot, "mcp/sasha-slides/e2e/prompt-argument-probe-server.ts")],
        cwd: repoRoot,
        env: { [PROMPT_ARGUMENT_LOG_ENV]: argumentLogPath },
      },
    },
  };
}

export function formatGuidanceReport(report: GuidanceReport): readonly string[] {
  const lines: string[] = [];
  for (const outcome of report.outcomes) {
    lines.push(`${verdictLabel(outcome.verdict)}  ${outcome.mechanism}`);
    for (const line of outcome.evidence) lines.push(`      ${line}`);
    lines.push(`      frames: ${outcome.frameLogPath}`);
    lines.push(`      client said: ${oneLine(outcome.answer)}`);
    lines.push("");
  }
  return lines;
}

/** What a recorded frame line is, parsed at the boundary rather than trusted. */
const FRAME_SCHEMA = z.object({
  at: z.string(),
  endpoint: z.string(),
  direction: z.union([z.literal("incoming"), z.literal("outgoing")]),
  message: z.looseObject({}),
});

export type ProbeFrame = z.infer<typeof FRAME_SCHEMA>;

export function readFrames(options: Readonly<{ path: string }>): readonly ProbeFrame[] {
  const text = readFileSync(options.path, "utf8");
  const frames: ProbeFrame[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = FRAME_SCHEMA.safeParse(JSON.parse(line));
    if (parsed.success) frames.push(parsed.data);
  }
  return frames;
}

const RECEIVED_SCHEMA = z.object({ name: z.string(), arguments: z.record(z.string(), z.string()) });

export function readReceivedArguments(
  options: Readonly<{ path: string }>,
): readonly ReceivedPromptArguments[] {
  const received: ReceivedPromptArguments[] = [];
  for (const line of readFileSync(options.path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = RECEIVED_SCHEMA.safeParse(JSON.parse(line));
    if (parsed.success) received.push(parsed.data);
  }
  return received;
}

/** Every method the client sent as a request, in order, so a report can name them. */
export function clientMethods(frames: readonly ProbeFrame[]): readonly string[] {
  const methods: string[] = [];
  for (const frame of frames) {
    if (frame.direction !== "incoming") continue;
    const { method } = frame.message;
    if (typeof method === "string") methods.push(method);
  }
  return methods;
}

/**
 * The prompt and the flags for one mechanism.
 *
 * The instructions prompt asks for something that appears ONLY in the instructions string:
 * the two-wave policy and the "only one proposal outstanding" rule are in no tool
 * description. The prompts prompt is the slash command itself, which is the user-visible
 * surface being tested. The tool-descriptions prompt asks for a per-tool fact, which is the
 * one thing that mechanism can carry.
 */
function probePlan(
  mechanism: GuidanceMechanism,
): Readonly<{ prompt: string; extraArgs: readonly string[]; model: string }> {
  switch (mechanism) {
    case "instructions":
      return {
        prompt:
          "Do not call any tool and do not read any file. The sasha-slides connector attached " +
          "to this session supplies its own usage instructions. Answer from those instructions " +
          "alone, in three short lines: (1) how many candidate slides it says are a good " +
          "default, (2) how many proposals it says may be outstanding at once, (3) whether its " +
          "slide indices are 0-based or 1-based. If no such instructions were given to you, " +
          "reply exactly NO INSTRUCTIONS.",
        // Skills are the competing explanation for a correct answer, so they are switched off.
        extraArgs: ["--disable-slash-commands", "--disallowed-tools", "Read,Bash,Glob,Grep,Task,WebFetch,WebSearch"],
        model: PROBE_MODEL,
      };
    case "instructions-extent":
      return {
        prompt:
          "Do not call any tool and do not read any file. The sasha-slides connector's " +
          "instructions in your system prompt are a numbered ruler: lines L0001 through " +
          `L${String(RULER_LINES).padStart(4, "0")}, one per line. Go to the very END of that block and read the ` +
          "last line that is actually there. Do NOT estimate, interpolate or guess a round " +
          "number; if you genuinely cannot see where it ends, reply exactly UNKNOWN. Reply " +
          "with only that identifier, then whether a truncation marker follows it.",
        extraArgs: ["--disable-slash-commands", "--disallowed-tools", "Read,Bash,Glob,Grep,Task,WebFetch,WebSearch"],
        model: CAREFUL_PROBE_MODEL,
      };
    case "prompts":
      return {
        prompt:
          `/mcp__${PROBE_SERVER_KEY}__new_deck our Q3 retention numbers\n\n` +
          "Do not call any tool and do not write any file. Reply with the numbered steps the " +
          "message you just received told you to follow, and name the tools they mention.",
        extraArgs: ["--disallowed-tools", "Read,Bash,Glob,Grep,Task,WebFetch,WebSearch"],
        model: PROBE_MODEL,
      };
    case "prompt-arguments":
      return {
        prompt:
          "/mcp__argprobe__two_args our Q3 retention numbers\n\n" +
          "Do not call any tool. Reply with the single line you were just given.",
        extraArgs: ["--disallowed-tools", "Read,Bash,Glob,Grep,Task,WebFetch,WebSearch"],
        model: PROBE_MODEL,
      };
    case "tool-descriptions":
      return {
        prompt:
          "Do not call any tool and do not read any file. List the names of every tool the " +
          "sasha-slides connector gives you, then say in your own words what the read_feedback " +
          "tool's description tells you about where the user's comments come from.",
        extraArgs: ["--disable-slash-commands", "--disallowed-tools", "Read,Bash,Glob,Grep,Task,WebFetch,WebSearch"],
        model: PROBE_MODEL,
      };
    default:
      return assertNever(mechanism);
  }
}

/** The verdict for one mechanism: what the frames show, crossed with what the client said. */
function observe(
  options: Readonly<{
    mechanism: GuidanceMechanism;
    frames: readonly ProbeFrame[];
    answer: string;
    received: readonly ReceivedPromptArguments[];
  }>,
): Readonly<{ verdict: GuidanceVerdict; evidence: readonly string[] }> {
  const { mechanism, frames, answer, received } = options;
  const methods = clientMethods(frames);
  const shared = [
    `client requests, in order: ${methods.join(", ")}`,
    `${String(frames.length)} frames recorded`,
  ];
  switch (mechanism) {
    case "instructions": {
      const delivered = frames.some(
        (frame) =>
          frame.direction === "outgoing" && JSON.stringify(frame.message).includes(INSTRUCTIONS_SENTINEL),
      );
      const lower = answer.toLowerCase();
      const quoted =
        !lower.includes("no instructions") &&
        /\bfour\b|\b4\b/.test(lower) &&
        /one proposal|a single proposal|only one|one at a time/.test(lower) &&
        /1-based|one-based/.test(lower);
      return {
        verdict: delivered ? (quoted ? "reaches-the-model" : "delivered-only") : "absent",
        evidence: [
          ...shared,
          `the skill-only sentinel "${INSTRUCTIONS_SENTINEL}" is in the initialize result: ${String(delivered)}`,
          `client's answer restates all three skill-only rules (four candidates, one outstanding proposal, 1-based): ${String(quoted)}`,
          `tools/call frames (there must be none): ${String(methods.filter((method) => method === "tools/call").length)}`,
        ],
      };
    }
    case "instructions-extent": {
      const lastVisible = highestRulerLine(answer);
      const cap = lastVisible === null ? null : lastVisible * RULER_LINE_CHARS;
      // A client that kept the WHOLE ruler would report its final line, which is a different
      // answer (no cap to measure), not a louder version of the same one - and it is also what
      // a model that guessed would say. Either way it is not a measurement.
      const wholeRulerKept = lastVisible === RULER_LINES;
      return {
        verdict: lastVisible === null || wholeRulerKept ? "delivered-only" : "reaches-the-model",
        evidence: [
          ...shared,
          `last ruler line the client could see: ${lastVisible === null ? "unreported" : `L${String(lastVisible).padStart(4, "0")}`}`,
          `=> the client keeps ${cap === null ? "an unknown number of" : String(cap)} characters of instructions`,
          `CLAUDE_CODE_INSTRUCTIONS_BUDGET is ${String(CLAUDE_CODE_INSTRUCTIONS_BUDGET)}: ${cap === CLAUDE_CODE_INSTRUCTIONS_BUDGET ? "matches" : "DOES NOT MATCH - update it"}`,
          `truncation marker reported: ${String(/truncat/i.test(answer))}`,
          wholeRulerKept
            ? `the client named the ruler's final line, so either it keeps everything or the model guessed - re-run`
            : "the named line is inside the ruler, so it is a real cut",
        ],
      };
    }
    case "prompts": {
      const listed = methods.includes("prompts/list");
      const fetched = methods.includes("prompts/get");
      // The template's own words, not the user's: `propose_slides`/`await_pick` and the
      // numbered steps appear nowhere in the typed slash command, only in `prompts/get`.
      const expanded = answer.includes("propose_slides") && answer.includes("await_pick");
      return {
        verdict: fetched ? (expanded ? "reaches-the-model" : "delivered-only") : listed ? "delivered-only" : "absent",
        evidence: [
          ...shared,
          `prompts/list requested: ${String(listed)}`,
          `prompts/get requested (the slash command resolved): ${String(fetched)}`,
          `the template's own steps came back through the model, so it was submitted as a turn: ${String(expanded)}`,
        ],
      };
    }
    case "prompt-arguments": {
      const first = received[0] ?? null;
      const bound = first === null ? [] : Object.entries(first.arguments);
      return {
        verdict: first === null ? "absent" : "reaches-the-model",
        evidence: [
          ...shared,
          'typed: "/mcp__argprobe__two_args our Q3 retention numbers" (4 words, 2 declared arguments)',
          `the server received: ${first === null ? "nothing" : JSON.stringify(first.arguments)}`,
          `=> words are bound positionally, ${String(bound.length)} of 4 kept, the rest DISCARDED`,
          `the raw text survives in the turn anyway: ${String(answer.includes("retention"))}`,
        ],
      };
    }
    case "tool-descriptions": {
      const listed = methods.includes("tools/list");
      const describedInFrames = frames.some(
        (frame) =>
          frame.direction === "outgoing" && JSON.stringify(frame.message).includes("NATIVE Google Slides comments"),
      );
      // THE finding of this probe, and it is not what was expected. Claude Code 2.1.285 loads
      // MCP tools *deferred*: the model is given the NAMES only, and said so unprompted -
      // "the deferred tools list only shows the names, not their descriptions". It cannot
      // restate a description it has not been handed, and the schemas arrive only when it
      // searches for them. So a tool description is NOT a reliable carrier of guidance in this
      // client, and `enumerated` without `restated` is the expected, correct outcome.
      const enumerated = EXPECTED_TOOLS.every((tool) => answer.includes(tool));
      const restated = /comment UI|Slides UI|native|no extra tooling|in Slides/i.test(answer);
      // Deliberately a fact that lives ONLY in a tool description: the served `instructions`
      // are abridged past the feedback section, so "the Slides comment UI, with no extra
      // tooling" cannot be answered from them. An earlier version asked about the paths-in
      // rule and the model answered it from the instructions instead - which measured the
      // wrong mechanism.

      return {
        verdict: listed ? (enumerated && restated ? "reaches-the-model" : "delivered-only") : "absent",
        evidence: [
          ...shared,
          `tools/list requested: ${String(listed)}`,
          `the descriptions were on the wire: ${String(describedInFrames)}`,
          `the client can enumerate all ${String(EXPECTED_TOOLS.length)} tools: ${String(enumerated)}`,
          `and restate what read_feedback's description says: ${String(restated)}`,
          "note: it refuses to quote a tool definition verbatim, so quoting is not a usable test",
        ],
      };
    }
    default:
      return assertNever(mechanism);
  }
}

/** The largest `Lnnnn` the client reported seeing, or null if it named none. */
function highestRulerLine(answer: string): number | null {
  const found = answer.match(/L(\d{4})/g) ?? [];
  const numbers = found.map((token) => Number.parseInt(token.slice(1), 10)).filter((value) => value > 0);
  return numbers.length === 0 ? null : Math.max(...numbers);
}

/** A skill-shaped markdown file whose body is nothing but the ruler. */
function rulerSkill(): string {
  const body = Array.from(
    { length: RULER_LINES },
    (_unused, index) => `L${String(index + 1).padStart(4, "0")} ---------`,
  ).join("\n");
  return `---\nname: synthetic-ruler\n---\n\n${body}\n`;
}

function verdictLabel(verdict: GuidanceVerdict): string {
  switch (verdict) {
    case "reaches-the-model":
      return "REACHES-THE-MODEL";
    case "delivered-only":
      return "DELIVERED-ONLY   ";
    case "absent":
      return "ABSENT           ";
    default:
      return assertNever(verdict);
  }
}

type ClaudeRun = Readonly<{ exitCode: number | null; stdout: string; stderr: string; elapsedMs: number }>;

/**
 * Spawned rather than `execFile`d so the prompt goes in `argv` (a large prompt on stdin
 * makes `claude -p` hang - see the repo's CLAUDE.md) and so the timeout kills the whole
 * process group rather than leaving an orphan holding the server subprocess open.
 */
function runClaude(
  options: Readonly<{ claudeBin: string; cwd: string; args: readonly string[]; timeoutMs: number }>,
): Promise<ClaudeRun> {
  const { claudeBin, cwd, args, timeoutMs } = options;
  const startedAt = Date.now();
  return new Promise<ClaudeRun>((resolve) => {
    const child = spawn(claudeBin, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => void child.kill("SIGKILL"), timeoutMs);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
}

/**
 * The probe asserts delivery by looking for one literal line. If the skill no longer contains
 * it, the probe would report ABSENT for a perfectly healthy server - so it fails loudly here
 * instead, naming the file to fix.
 */
function assertSentinelIsInTheSkill(options: Readonly<{ repoRoot: string }>): void {
  const body = stripSkillFrontmatter(readFileSync(join(options.repoRoot, SKILL_RELATIVE_PATH), "utf8"));
  if (body.includes(INSTRUCTIONS_SENTINEL)) return;
  throw new Error(
    `${SKILL_RELATIVE_PATH} no longer contains the probe's sentinel line ` +
      `"${INSTRUCTIONS_SENTINEL}". Pick a new distinctive line from the skill and update ` +
      "INSTRUCTIONS_SENTINEL.",
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 400);
}

const ALL_MECHANISMS: readonly GuidanceMechanism[] = [
  "instructions",
  "instructions-extent",
  "prompts",
  "prompt-arguments",
  "tool-descriptions",
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = process.cwd();
  const workDir = valueOf({ args, flag: "--out" }) ?? join(repoRoot, "mcp/sasha-slides/e2e/.work/connector-guidance");
  const requested = valueOf({ args, flag: "--probe" });
  const mechanisms = requested === null ? ALL_MECHANISMS : ALL_MECHANISMS.filter((name) => name === requested);
  if (mechanisms.length === 0) {
    process.stderr.write(`unknown --probe ${requested ?? ""}; expected one of ${ALL_MECHANISMS.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  // Outside the repository, so neither CLAUDE.md nor .claude/skills can answer the prompts.
  const cwd = valueOf({ args, flag: "--cwd" }) ?? mkdtempSync(join(tmpdir(), "sasha-guidance-"));
  const report = await runConnectorGuidanceProbe({
    repoRoot,
    workDir,
    cwd,
    claudeBin: valueOf({ args, flag: "--claude" }) ?? "claude",
    mechanisms,
    log: (line) => void process.stdout.write(`${line}\n`),
  });
  process.stdout.write("\n");
  for (const line of formatGuidanceReport(report)) process.stdout.write(`${line}\n`);
  process.stdout.write(`claude ran in ${cwd}\n`);
}

function valueOf(options: Readonly<{ args: readonly string[]; flag: string }>): string | null {
  const at = options.args.indexOf(options.flag);
  if (at === -1) return null;
  return options.args[at + 1] ?? null;
}

void main();

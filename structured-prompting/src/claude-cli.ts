import { join } from "node:path";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import type { ClaudeModel } from "./types.js";
import { realIO, type IO } from "./io.js";

export interface ClaudeCallOptions {
  prompt: string;
  model?: ClaudeModel;
  resume?: string | null;     // existing session_id to continue
  fork?: boolean;             // --fork-session (pairs with --resume)
  cwd?: string;
  timeoutMs?: number;         // total time budget
  attachments?: string[];     // base64-encoded files -> materialised on disk and referenced in the prompt
  appendSystemPrompt?: string;
  /** Optional JSON Schema object; passed to `claude -p --json-schema <json>` so the CLI enforces structured output. */
  jsonSchema?: object;
  /** Injected IO module — default `realIO`. Tests pass a MockIO. */
  io?: IO;
}

/**
 * Per-call token + USD accounting. Sourced from the CLI's `usage` block and
 * `modelUsage[<model>]` entry. Populated for every send (including failures
 * with isError=true if the model still consumed tokens before erroring).
 *
 * Cached input tokens come in two forms:
 *   * cacheReadInputTokens  — server hit a cache (cheapest tier, ~10% of
 *                              the input price)
 *   * cacheCreationInputTokens — server wrote a new cache entry (full
 *                              input price + 25% on top)
 * The CLI returns these on the `usage` block too; we surface both so the
 * monitor's per-node rollup can choose which counter to display.
 */
export interface TokenUsage {
  /** Non-cached input tokens (full input rate). */
  inputTokens: number;
  /** Cache-read input tokens (cheap rate). */
  cacheReadInputTokens: number;
  /** Cache-creation input tokens (full rate + 25%). */
  cacheCreationInputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Total USD for this single call (sum across all token classes). */
  costUsd: number;
}

export interface ClaudeCallResult {
  text: string;             // the `result` field from --output-format json
  sessionId: string | null;
  durationMs: number;
  model: string | null;
  costUsd: number | null;
  /** Per-call token + USD breakdown. Null if the CLI returned no usage block
   * (e.g. spawn failure before any model contact). */
  usage: TokenUsage | null;
  /** Populated by the CLI when `--json-schema` was passed: the model's
   * structured reply, already parsed into an object. Undefined otherwise. */
  structuredOutput: unknown;
  raw: unknown;
  stderr: string;
  isError: boolean;
  errorMessage: string | null;
}

// Single long-running bug_solving send commonly takes 10-20 min because the
// worker records pptx, compacts, writes analysis.md, and iterates on the fix
// before returning. 5 min is too tight; 30 min leaves headroom without letting
// runaway Bash steps hang the graph forever.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeCallResult> {
  const {
    prompt,
    model,
    resume,
    fork,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attachments = [],
    appendSystemPrompt,
    jsonSchema,
    io = realIO,
  } = opts;

  // Dump attachments to a per-call temp dir and reference them by absolute
  // path in the prompt. The directory is removed at the end of this call
  // (success, error, or timeout) via the `finally` below.
  const attachPaths: string[] = [];
  let scratchDir: string | null = null;
  if (attachments.length > 0) {
    scratchDir = io.mkdtempSync(join(tmpdir(), "sp-attach-"));
    attachments.forEach((b64, i) => {
      const p = join(scratchDir!, `att_${i}.bin`);
      io.writeFileSync(p, Buffer.from(b64, "base64"));
      attachPaths.push(p);
    });
  }
  const fullPrompt =
    attachPaths.length > 0
      ? `${prompt}\n\nAttachments (absolute paths): ${attachPaths.join(", ")}`
      : prompt;

  const procArgs = [
    "-p",
    fullPrompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
  ];
  if (model) procArgs.push("--model", model);
  if (resume) {
    procArgs.push("--resume", resume);
    if (fork) procArgs.push("--fork-session");
  }
  if (appendSystemPrompt) procArgs.push("--append-system-prompt", appendSystemPrompt);
  if (jsonSchema) procArgs.push("--json-schema", JSON.stringify(jsonSchema));

  const started = io.now();
  try {
    const { stdout, stderr, exitCode, timedOut, spawnError } = await io.spawnCapture({
      command: "claude",
      args: procArgs,
      cwd,
      timeoutMs,
    });

    if (spawnError) {
      return {
        text: "",
        sessionId: null,
        durationMs: io.now() - started,
        model: model ?? null,
        costUsd: null,
        usage: null,
        structuredOutput: undefined,
        raw: null,
        stderr,
        isError: true,
        errorMessage: `claude spawn failed: ${spawnError}`,
      };
    }

    // The CLI sometimes prefixes stdout with a stderr warning line ("no stdin
    // data received..."); find the JSON start before parsing.
    /** Subset of the CLI's JSON result-frame shape that we read from. */
    interface CliUsage {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }
    interface CliModelUsageEntry {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
    interface CliResultFrame {
      type?: string;
      is_error?: boolean;
      result?: string;
      session_id?: string;
      duration_ms?: number;
      modelUsage?: Record<string, CliModelUsageEntry>;
      total_cost_usd?: number;
      structured_output?: unknown;
      usage?: CliUsage;
      api_error_status?: string;
    }
    let parsed: CliResultFrame | null = null;
    const jsonStart = stdout.indexOf('{"type"');
    const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
    try {
      parsed = JSON.parse(jsonText) as CliResultFrame;
    } catch {
      // non-JSON output; fall through with parsed=null
    }
    const ok = parsed != null && parsed.type === "result" && parsed.is_error === false;
    // Pull token + cost numbers. Prefer modelUsage (per-model rollup that
    // already includes prompt-cache surcharges and gives the authoritative
    // costUSD); fall back to the top-level `usage` block if modelUsage is
    // absent. Both are guarded with finite-number checks so a missing
    // field defaults to 0 instead of NaN-poisoning the rollups.
    const usage: TokenUsage | null = (() => {
      if (parsed == null) return null;
      const modelEntry = parsed.modelUsage
        ? Object.values(parsed.modelUsage)[0]
        : undefined;
      const u = parsed.usage;
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return {
        inputTokens: num(modelEntry?.inputTokens ?? u?.input_tokens),
        cacheReadInputTokens: num(modelEntry?.cacheReadInputTokens ?? u?.cache_read_input_tokens),
        cacheCreationInputTokens: num(modelEntry?.cacheCreationInputTokens ?? u?.cache_creation_input_tokens),
        outputTokens: num(modelEntry?.outputTokens ?? u?.output_tokens),
        costUsd: num(modelEntry?.costUSD ?? parsed.total_cost_usd),
      };
    })();
    return {
      text: parsed?.result ?? "",
      sessionId: parsed?.session_id ?? null,
      durationMs: parsed?.duration_ms ?? io.now() - started,
      model: parsed?.modelUsage ? Object.keys(parsed.modelUsage)[0] ?? null : model ?? null,
      costUsd: typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null,
      usage,
      structuredOutput: parsed?.structured_output,
      raw: parsed,
      stderr,
      isError: !ok,
      errorMessage: ok
        ? null
        : parsed?.api_error_status ||
          parsed?.result ||
          (stderr && stderr.trim()) ||
          (timedOut ? `claude timed out after ${timeoutMs}ms` : `claude exited with code ${exitCode}`),
    };
  } finally {
    // Always remove the per-call scratch dir, regardless of outcome.
    if (scratchDir) {
      try { io.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Ask the model to respond with JSON matching a schema, using Claude CLI's
 * native `--json-schema` flag. The CLI hands the schema to the model as a
 * `StructuredOutput` tool; the parsed reply comes back on the result event's
 * `structured_output` field. No prompt-tail injection, no local JSON-regex
 * extraction.
 */
export async function callClaudeFormatted<R>(
  opts: ClaudeCallOptions & { jsonSchema: object },
): Promise<ClaudeCallResult & { parsed: R | null; parseError: string | null }> {
  const r = await callClaude(opts);
  let parsed: R | null = null;
  let parseError: string | null = null;
  if (!r.isError) {
    if (r.structuredOutput != null) {
      parsed = r.structuredOutput as R;
    } else {
      parseError =
        "Claude CLI returned no structured_output. " +
        "Check that `--json-schema` was forwarded and that the model used the StructuredOutput tool.";
    }
  }
  return { ...r, parsed, parseError };
}


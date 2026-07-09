import { join } from "node:path";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { realIO, type IO } from "./io.js";
import type { ModelDriver } from "./model-driver.js";

export interface ClaudeCallOptions {
  prompt: string;
  /** Model id forwarded verbatim to the CLI's `--model`. Widened to string
   *  (was ClaudeModel) so this shape doubles as the provider-agnostic
   *  ModelCallOptions; the typed ClaudeModel selection lives at the Session
   *  layer. */
  model?: string;
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
  /** Owning graph node id — propagated to spawnCapture so /api/cancel can
   *  target this branch's claude subprocess. */
  nodeId?: string;
  /** Opt-in overlay branch id. Forwarded to spawnCapture, which re-wraps the
   *  CLI invocation to run INSIDE that overlayfs branch. The branch runner sets
   *  cwd = merged working-tree root, so claude needs no `--cd` (it has none).
   *  Undefined = normal spawn. */
  branchId?: string;
  /**
   * Streaming hooks. When `onPartialText` is set, this call switches the
   * CLI to `--output-format stream-json` (which requires `--verbose`),
   * parses each newline-delimited JSON event, and invokes `onPartialText`
   * with the accumulated assistant-text so far on every assistant chunk.
   * `onPartialUsage` fires whenever usage numbers are present in an
   * event (e.g. cache-creation events have early input_tokens hints).
   *
   * On exit the result frame is parsed and returned as the normal
   * ClaudeCallResult — same shape callers see today. Streaming is purely
   * additive.
   */
  onPartialText?: (textSoFar: string) => void;
  onPartialUsage?: (usage: TokenUsage) => void;
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

// Single long-running bug_solving send commonly takes 20-40 min because the
// worker records pptx, compacts, writes analysis.md, and iterates on the fix
// before returning. 5 min is too tight; 60 min leaves headroom for multi-slide
// clusters without letting runaway Bash steps hang the graph forever.
//
// Override at runtime via env `CLAUDE_TIMEOUT_MS=<ms>` — handy when a single
// wave needs a longer budget without rebuilding the dist. Per-send override is
// also available via `CommonSendArguments.timeout` in session.ts.
const DEFAULT_TIMEOUT_MS = (() => {
  const fromEnv = process.env.CLAUDE_TIMEOUT_MS;
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60 * 60 * 1000;
})();

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

  const streaming = !!opts.onPartialText || !!opts.onPartialUsage;
  // argv has a per-string cap (~128KB MAX_ARG_STRLEN on Linux); a big prompt (an
  // LLM merge over full source files) blows it → `spawn E2BIG`. Above a safe
  // threshold, feed the prompt on STDIN via a temp FILE (`claude -p` reads it) —
  // a file, not a pipe, so it can't fill the pipe buffer and hang.
  const PROMPT_ARGV_LIMIT = 96 * 1024;
  let promptFile: string | null = null;
  const procArgs = ["-p"];
  if (Buffer.byteLength(fullPrompt, "utf8") > PROMPT_ARGV_LIMIT) {
    if (!scratchDir) scratchDir = io.mkdtempSync(join(tmpdir(), "sp-prompt-"));
    promptFile = join(scratchDir, "prompt.txt");
    io.writeFileSync(promptFile, fullPrompt);
    // no positional prompt → claude reads it from stdin (the file)
  } else {
    procArgs.push(fullPrompt);
  }
  procArgs.push(
    "--output-format",
    streaming ? "stream-json" : "json",
    "--dangerously-skip-permissions",
  );
  if (streaming) procArgs.push("--verbose"); // claude requires --verbose with stream-json
  if (model) procArgs.push("--model", model);
  if (resume) {
    procArgs.push("--resume", resume);
    if (fork) procArgs.push("--fork-session");
  }
  if (appendSystemPrompt) procArgs.push("--append-system-prompt", appendSystemPrompt);
  if (jsonSchema) procArgs.push("--json-schema", JSON.stringify(jsonSchema));

  const started = io.now();
  // Streaming state — only populated when streaming=true. Buffered chunk
  // accumulator (chunks can split mid-line, so we split on \n). The
  // final `result` event is what we return; intermediate `assistant`
  // events feed onPartialText.
  let textSoFar = "";
  let streamBuffer = "";
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const handleStreamLine = (line: string): void => {
    if (!line) return;
    let evt: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; usage?: Record<string, number> };
    try { evt = JSON.parse(line); } catch { return; }
    if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      for (const part of evt.message.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          textSoFar += part.text;
        }
      }
      if (opts.onPartialText) {
        try { opts.onPartialText(textSoFar); } catch { /* listener errors don't abort the call */ }
      }
    }
    if (evt.usage && opts.onPartialUsage) {
      const u = evt.usage;
      try {
        opts.onPartialUsage({
          inputTokens: num(u.input_tokens),
          cacheReadInputTokens: num(u.cache_read_input_tokens),
          cacheCreationInputTokens: num(u.cache_creation_input_tokens),
          outputTokens: num(u.output_tokens),
          costUsd: 0, // per-event cost isn't surfaced; final result frame has the total
        });
      } catch { /* listener errors don't abort the call */ }
    }
  };
  const onStdout = streaming
    ? (chunk: string) => {
        streamBuffer += chunk;
        let nl = streamBuffer.indexOf("\n");
        while (nl >= 0) {
          handleStreamLine(streamBuffer.slice(0, nl));
          streamBuffer = streamBuffer.slice(nl + 1);
          nl = streamBuffer.indexOf("\n");
        }
      }
    : undefined;
  try {
    const { stdout, stderr, exitCode, timedOut, spawnError } = await io.spawnCapture({
      command: "claude",
      args: procArgs,
      cwd,
      timeoutMs,
      branchId: opts.branchId,
      onStdout,
      stdinFile: promptFile ?? undefined,
    });
    // Drain any trailing buffered line (last event might not end in \n).
    if (streaming && streamBuffer) {
      handleStreamLine(streamBuffer);
      streamBuffer = "";
    }

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
    if (streaming) {
      // stream-json mode: stdout is NDJSON, one event per line. We want the
      // FINAL `{"type":"result", ...}` frame (the only one carrying total
      // usage, cost, session_id, and the structured_output payload). Walk
      // lines bottom-up and parse the first one whose type is "result".
      const lines = stdout.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as CliResultFrame;
          if (frame.type === "result") { parsed = frame; break; }
        } catch { /* keep scanning */ }
      }
    } else {
      // Non-streaming: single JSON frame, possibly prefixed by a stderr
      // warning line. Find the first '{"type"' and JSON.parse from there.
      const jsonStart = stdout.indexOf('{"type"');
      const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
      try {
        parsed = JSON.parse(jsonText) as CliResultFrame;
      } catch {
        // non-JSON output; fall through with parsed=null
      }
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
      // Report the model that did the MAIN work, not modelUsage's first key.
      // `claude --model fable` also invokes haiku for a sub-task, so modelUsage
      // has both keys and [0] was wrongly reporting haiku. Prefer the key that
      // matches the requested model token, else the heaviest by output tokens.
      model: ((): string | null => {
        const mu = parsed?.modelUsage;
        if (!mu) return model ?? null;
        const keys = Object.keys(mu);
        if (keys.length <= 1) return keys[0] ?? model ?? null;
        if (model) { const m = keys.find((k) => k.includes(model)); if (m) return m; }
        return keys.slice().sort((a, b) => (mu[b]?.outputTokens ?? 0) - (mu[a]?.outputTokens ?? 0))[0] ?? null;
      })(),
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

/**
 * The Claude backend for the engine — a thin adapter over the functions
 * above. Composed into `Engine` (see model-driver.ts / engine.ts) so the
 * engine logic stays provider-agnostic. Compaction is Claude-CLI's `/compact`
 * slash command sent into the resumed conversation.
 */
export const claudeDriver: ModelDriver = {
  name: "claude",
  call: (opts) => callClaude(opts),
  callFormatted: (opts) => callClaudeFormatted(opts),
  compact: (opts) => callClaude({ ...opts, prompt: "/compact" }),
  // Claude associates a resumable session with the project (cwd), so cd there
  // first when known. `claude --resume <id>` reopens that conversation.
  resumeCommand: (id, cwd) =>
    id ? (cwd ? `(cd ${cwd} && claude --resume ${id})` : `claude --resume ${id}`) : null,
};


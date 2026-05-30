import { join } from "node:path";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { realIO } from "./io.js";
import type { ClaudeCallOptions, ClaudeCallResult, TokenUsage } from "./claude-cli.js";
import type { FormattedResult, ModelDriver } from "./model-driver.js";

/**
 * codex-cli.ts — the OpenAI Codex CLI counterpart of claude-cli.ts.
 *
 * Mirrors claude-cli's structure exactly: spawn the CLI through the injected
 * `io` (default `realIO`), materialise base64 attachments into a per-call
 * scratch dir, parse the CLI's JSON output, and clean up in a `finally`.
 *
 * The option/result shapes are provider-neutral, so we reuse claude-cli's
 * directly rather than redeclaring them. The differences from Claude are:
 *   * subcommand is `codex exec` (non-interactive/headless), not `claude -p`.
 *   * Codex has NO `--json-schema` flag, so structured output is achieved by
 *     injecting the schema into the prompt and extracting the JSON locally.
 *   * Codex has no `/compact`, so compaction is a no-op.
 * All uncertain CLI-interface details are flagged with `// VERIFY:` comments.
 */
export type CodexCallOptions = ClaudeCallOptions;
export type CodexCallResult = ClaudeCallResult;

// Same rationale as claude-cli's DEFAULT_TIMEOUT_MS: a single bug_solving send
// can run 20-40 min. Override at runtime via `CODEX_TIMEOUT_MS=<ms>`.
const DEFAULT_TIMEOUT_MS = (() => {
  const fromEnv = process.env.CODEX_TIMEOUT_MS;
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60 * 60 * 1000;
})();

/**
 * Extract the first balanced top-level JSON object from a string. Codex has no
 * schema flag, so `callCodexFormatted` asks the model for raw JSON and we slice
 * it back out here — tolerant of leading prose or stray code fences. Returns the
 * object substring (still a string; caller JSON.parses it) or null if none
 * found. Scans for the first `{`, then walks counting brace depth while
 * skipping over string literals (so braces inside strings don't miscount).
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export async function callCodex(opts: CodexCallOptions): Promise<CodexCallResult> {
  const {
    prompt,
    model,
    resume,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attachments = [],
    io = realIO,
  } = opts;

  // Dump attachments to a per-call temp dir and reference them by absolute
  // path in the prompt. The directory is removed at the end of this call
  // (success, error, or timeout) via the `finally` below. Identical to
  // claude-cli's attachment handling.
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

  // Build the argv for `codex exec`. Claude pipes the prompt to stdin; the
  // shared `io.spawnCapture` uses stdio:["ignore",...] (no stdin write), so we
  // pass the prompt as the trailing positional arg instead.
  // VERIFY: `codex exec "<prompt>"` is Codex's non-interactive/headless mode,
  //         with the prompt as the last positional argument.
  const procArgs: string[] = ["exec"];

  // VERIFY: resume support. Codex's resume interface is uncertain. The
  //         best-known form is `codex exec resume <sessionId>` as a leading
  //         subcommand. If the installed CLI doesn't support it the run will
  //         error out (captured, not thrown) and the caller sees isError; we
  //         deliberately do NOT crash the process. If your Codex build uses a
  //         flag instead (e.g. `--session <id>` / `-c <id>`), swap it here.
  if (resume) {
    procArgs.push("resume", resume);
  }

  // VERIFY: `--json` makes `codex exec` emit newline-delimited JSON events on
  //         stdout (last message/result event carries the final text). If your
  //         build uses a different flag (e.g. `--output-format json`), change
  //         it here. We parse defensively and fall back to raw stdout.
  procArgs.push("--json");

  // VERIFY: `--model <m>` / `-m <m>` selects the model. Forward when set.
  if (model) procArgs.push("--model", model);

  // Skip interactive approval prompts so the headless run can't block on a
  // confirmation. VERIFY: flag name — Codex uses an approval/sandbox policy
  //         flag; `--dangerously-bypass-approvals-and-sandbox` is the
  //         best-known fully-non-interactive switch. Adjust if your build
  //         exposes `--full-auto` / `--ask-for-approval never` instead.
  procArgs.push("--dangerously-bypass-approvals-and-sandbox");

  // Prompt is the trailing positional arg.
  procArgs.push(fullPrompt);

  const started = io.now();
  try {
    const { stdout, stderr, exitCode, timedOut, spawnError } = await io.spawnCapture({
      command: "codex",
      args: procArgs,
      cwd,
      timeoutMs,
      nodeId: opts.nodeId,
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
        errorMessage: `codex spawn failed: ${spawnError}`,
      };
    }

    // ----- Parse the `codex exec --json` event stream --------------------
    // VERIFY: event-stream shape. Codex emits NDJSON events; the final
    //         assistant/result message holds the answer text. We scan all
    //         lines, keeping the LAST event that carries assistant/result
    //         text, and (if present) the last event carrying token usage and
    //         a session id. Field names below are best-known guesses and are
    //         all optional + guarded, so a schema mismatch degrades to the
    //         raw-stdout fallback rather than crashing.
    interface CodexTokenUsage {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      cache_creation_input_tokens?: number;
      total_tokens?: number;
    }
    interface CodexEvent {
      // Discriminator. VERIFY: values like "item.completed" / "agent_message" /
      //   "message" / "result" / "turn.completed" depending on the build.
      type?: string;
      // Final answer text may live under any of these depending on the build.
      text?: string;
      message?: string | { content?: string; text?: string };
      result?: string;
      last_agent_message?: string;
      role?: string;
      // Session / conversation id.
      session_id?: string;
      conversation_id?: string;
      id?: string;
      // Token accounting.
      usage?: CodexTokenUsage;
      token_usage?: CodexTokenUsage;
      // Total USD if the build surfaces it.
      cost_usd?: number;
      total_cost_usd?: number;
      // Error signalling.
      error?: string | { message?: string };
    }

    const pickText = (e: CodexEvent): string | null => {
      if (typeof e.text === "string" && e.text.length > 0) return e.text;
      if (typeof e.result === "string" && e.result.length > 0) return e.result;
      if (typeof e.last_agent_message === "string" && e.last_agent_message.length > 0) {
        return e.last_agent_message;
      }
      if (typeof e.message === "string" && e.message.length > 0) return e.message;
      if (e.message && typeof e.message === "object") {
        if (typeof e.message.text === "string" && e.message.text.length > 0) return e.message.text;
        if (typeof e.message.content === "string" && e.message.content.length > 0) {
          return e.message.content;
        }
      }
      return null;
    };

    let finalText: string | null = null;
    let sessionId: string | null = null;
    let usageEvt: CodexTokenUsage | undefined;
    let costUsd: number | null = null;
    let streamErr: string | null = null;
    let sawAnyEvent = false;

    const lines = stdout.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line[0] !== "{") continue;
      let evt: CodexEvent;
      try {
        // Untyped-JSON boundary: the CLI's event shape is external and only
        // best-known, so we parse to `unknown` and assert the optional-field
        // interface; every field access below is guarded.
        evt = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }
      sawAnyEvent = true;
      const t = pickText(evt);
      if (t != null) finalText = t; // keep the last text-bearing event
      const sid = evt.session_id ?? evt.conversation_id ?? evt.id;
      if (typeof sid === "string" && sid.length > 0) sessionId = sid;
      const u = evt.usage ?? evt.token_usage;
      if (u) usageEvt = u;
      const c = evt.cost_usd ?? evt.total_cost_usd;
      if (typeof c === "number" && Number.isFinite(c)) costUsd = c;
      if (evt.error != null) {
        streamErr = typeof evt.error === "string" ? evt.error : (evt.error.message ?? "codex error");
      }
    }

    // Fallback: if the output wasn't the expected JSON event stream at all,
    // treat the whole stdout as the answer text (defensive — matches the
    // spec's "if JSON parse fails, fall back to raw stdout as text").
    if (!sawAnyEvent && stdout.trim().length > 0) {
      finalText = stdout.trim();
    }

    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const usage: TokenUsage | null = usageEvt
      ? {
          inputTokens: num(usageEvt.input_tokens),
          cacheReadInputTokens: num(usageEvt.cached_input_tokens),
          cacheCreationInputTokens: num(usageEvt.cache_creation_input_tokens),
          outputTokens: num(usageEvt.output_tokens),
          costUsd: num(costUsd),
        }
      : null;

    // The run is an error if: the CLI signalled an error event, the process
    // exited non-zero, it timed out, or we got no usable text at all.
    const exitedClean = exitCode === 0 && !timedOut && streamErr == null;
    const haveText = finalText != null && finalText.length > 0;
    const ok = exitedClean && haveText;

    return {
      text: finalText ?? "",
      sessionId,
      durationMs: io.now() - started,
      model: model ?? null,
      costUsd,
      usage,
      structuredOutput: undefined, // Codex has no native structured-output channel
      raw: stdout,
      stderr,
      isError: !ok,
      errorMessage: ok
        ? null
        : streamErr ||
          (stderr && stderr.trim()) ||
          (timedOut ? `codex timed out after ${timeoutMs}ms` : null) ||
          (!haveText ? "codex produced no output" : null) ||
          `codex exited with code ${exitCode}`,
    };
  } finally {
    // Always remove the per-call scratch dir, regardless of outcome.
    if (scratchDir) {
      try {
        io.rmSync(scratchDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * Schema-constrained send for Codex. Unlike Claude there's no `--json-schema`
 * flag, so we inject the schema into the prompt and extract the first balanced
 * JSON object from the reply text. `parsed` is populated on success,
 * `parseError` on failure (never both).
 */
export async function callCodexFormatted<R>(
  opts: CodexCallOptions & { jsonSchema: object },
): Promise<FormattedResult<R>> {
  const schemaInstruction =
    `\n\nRespond with ONLY a JSON object matching this JSON Schema:\n` +
    `${JSON.stringify(opts.jsonSchema)}\n` +
    `No prose, no explanation, no code fences — just the raw JSON object.`;
  const r = await callCodex({ ...opts, prompt: opts.prompt + schemaInstruction });

  let parsed: R | null = null;
  let parseError: string | null = null;
  if (r.isError) {
    parseError = r.errorMessage ?? "codex call failed before producing output";
  } else {
    const jsonText = extractFirstJsonObject(r.text);
    if (jsonText == null) {
      parseError = "codex reply contained no JSON object to parse";
    } else {
      try {
        // Untyped-JSON boundary: the model's reply is external; we assert it
        // matches the requested schema R. Callers that need stronger
        // guarantees should validate `parsed` against the schema themselves.
        parsed = JSON.parse(jsonText) as R;
      } catch (e) {
        parseError = `failed to parse codex JSON reply: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  return { ...r, parsed, parseError };
}

/**
 * The Codex backend for the engine — a thin adapter over the functions above,
 * structurally identical to `claudeDriver`.
 *
 * Compaction: Codex has no `/compact` equivalent. We make `compact` a no-op
 * that returns a successful empty result whose `sessionId` echoes the incoming
 * `resume` id, so the engine keeps resuming the SAME conversation afterwards
 * (the contract `ModelDriver.compact` documents: the returned `sessionId` is
 * what to resume from). No model tokens are spent.
 */
export const codexDriver: ModelDriver = {
  name: "codex",
  call: (opts) => callCodex(opts),
  callFormatted: (opts) => callCodexFormatted(opts),
  compact: (opts) => {
    const io = opts.io ?? realIO;
    const result: CodexCallResult = {
      text: "",
      sessionId: opts.resume ?? null, // preserve the conversation to resume from
      durationMs: 0,
      model: opts.model ?? null,
      costUsd: null,
      usage: null,
      structuredOutput: undefined,
      raw: null,
      stderr: "",
      isError: false,
      errorMessage: null,
    };
    // Touch io.now() only to keep the field referenced for the no-op; avoids
    // an unused-var lint while honouring the IO-discipline rule.
    void io;
    return Promise.resolve(result);
  },
};

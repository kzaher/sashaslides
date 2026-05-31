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
 *   * resume is the `codex exec resume <sessionId> [PROMPT]` subcommand form.
 *   * structured output uses codex's native `--output-schema <FILE>` flag
 *     (a JSON Schema file) — the final agent message is then pure JSON, which
 *     we parse directly (a balanced-JSON extractor is kept only as a fallback).
 *   * Codex has no `/compact`, so compaction is a no-op.
 *
 * All CLI-interface details below were verified against `codex 0.135.0`
 * (`codex exec --help`, `codex exec resume --help`, and live `--json` runs).
 * The real `--json` event shape observed:
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *                                     "output_tokens":N,"reasoning_output_tokens":N}}
 *
 * We read the final text from the `agent_message` item on the event stream
 * (not `-o/--output-last-message`) so the whole call stays mockable through
 * `io.spawnCapture`'s stdout — the only external surface tests can stub.
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
 * Extract the first balanced top-level JSON object from a string. Used as a
 * FALLBACK in `callCodexFormatted`: with `--output-schema` the final message is
 * already pure JSON, but if a model wraps it in prose / code fences we slice the
 * object back out here. Returns the object substring (still a string; caller
 * JSON.parses it) or null if none found. Scans for the first `{`, then walks
 * counting brace depth while skipping string literals (so braces inside strings
 * don't miscount).
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

/** Codex `--json` token-usage block (from `turn.completed`). All optional. */
interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * One Codex `--json` event line. Only the fields we read are declared; every
 * one is optional and guarded at the use site, so a schema drift across codex
 * versions degrades to the raw-stdout fallback rather than crashing.
 *
 * Observed event types: `thread.started` (carries `thread_id`),
 * `turn.started`, `item.completed` (carries `item`), `turn.completed`
 * (carries `usage`).
 */
interface CodexItem {
  id?: string;
  // "agent_message" carries the assistant text in `text`. Other item types
  // (reasoning, command_execution, ...) are ignored.
  type?: string;
  text?: string;
}
interface CodexEvent {
  type?: string;
  // session id lives here (verified field name on `thread.started`); also
  // tolerate older/alternate names defensively.
  thread_id?: string;
  session_id?: string;
  conversation_id?: string;
  id?: string;
  // `item.completed` payload.
  item?: CodexItem;
  // `turn.completed` payload.
  usage?: CodexTokenUsage;
  // error signalling (best-effort; not observed in normal runs).
  error?: string | { message?: string };
}

/**
 * The structured-prompting graph injects Claude model identifiers (`opus`,
 * `sonnet`, `haiku`, or full `claude-…` ids) via switchModel and its defaults.
 * Those are meaningless to codex, and a ChatGPT-account codex rejects them with
 * a 400 ("The 'opus' model is not supported when using Codex with a ChatGPT
 * account."). So we translate: a Claude-family token means "engine default",
 * which for codex is "let codex pick its account default" — i.e. omit `--model`
 * entirely (returns null). A non-Claude token (e.g. `gpt-5-codex`) is a genuine
 * codex model the caller pinned, so it passes through unchanged.
 */
const CLAUDE_MODEL_TOKENS = new Set(["opus", "sonnet", "haiku"]);
export function codexModelArg(model: string | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (CLAUDE_MODEL_TOKENS.has(m) || m.startsWith("claude")) return null;
  return model;
}

export async function callCodex(opts: CodexCallOptions): Promise<CodexCallResult> {
  return callCodexInternal(opts, null);
}

/**
 * Shared implementation for `callCodex` and `callCodexFormatted`. `schemaPath`,
 * when non-null, is forwarded as `--output-schema <FILE>` so codex constrains
 * the final message to that JSON Schema.
 */
async function callCodexInternal(
  opts: CodexCallOptions,
  schemaPath: string | null,
): Promise<CodexCallResult> {
  const {
    prompt,
    model,
    resume,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attachments = [],
    io = realIO,
  } = opts;

  // Per-call scratch dir holding materialised attachments. Removed in the
  // `finally` below. Created lazily — only when there are attachments.
  let scratchDir: string | null = null;
  const attachPaths: string[] = [];
  if (attachments.length > 0) {
    scratchDir = io.mkdtempSync(join(tmpdir(), "sp-codex-"));
    attachments.forEach((b64, i) => {
      const p = join(scratchDir!, `att_${i}.bin`);
      io.writeFileSync(p, Buffer.from(b64, "base64"));
      attachPaths.push(p);
    });
  }
  // Attachments are passed natively via `-i/--image`, so the prompt itself is
  // left unmodified (codex attaches them to the initial prompt for us).
  const fullPrompt = prompt;

  // ----- Build argv for `codex exec` (+ optional `resume` subcommand) -------
  // Forms:
  //   fresh:   codex exec [OPTIONS] <PROMPT>
  //   resume:  codex exec resume <SESSION_ID> [OPTIONS] <PROMPT>
  const procArgs: string[] = ["exec"];

  // Resume a prior conversation by id. Note: `codex 0.135.0` does NOT error on
  // an unknown id — it starts a fresh thread instead — so we don't rely on a
  // non-zero exit to detect a bad resume; we simply capture whatever thread id
  // the run reports so the engine resumes the correct conversation next turn.
  if (resume) {
    procArgs.push("resume", resume);
  }

  // `--json` → NDJSON events on stdout. We parse the final `agent_message`
  // item from this stream (verified shape) — going through stdout (the one
  // thing `io.spawnCapture` returns) keeps the whole call mockable, which a
  // separate `--output-last-message` file read would break.
  procArgs.push("--json");

  // Structured-output: constrain the final message to a JSON Schema file.
  if (schemaPath) {
    procArgs.push("--output-schema", schemaPath);
  }

  // Forward the model when set (`-m/--model`) — but only after translating
  // away Claude-family identifiers the graph injects (see codexModelArg).
  const codexModel = codexModelArg(model);
  if (codexModel) procArgs.push("--model", codexModel);

  // Codex-native working root. spawnCapture's `cwd` already sets the process
  // cwd, but `-C/--cd` is how codex itself scopes the workspace. NOTE: the
  // `exec resume` subcommand rejects `--cd` ("unexpected argument '--cd'") —
  // a resumed session inherits its recorded cwd, and spawnCapture still sets
  // the process cwd — so only pass `--cd` on a FRESH exec.
  if (cwd && !resume) procArgs.push("--cd", cwd);

  // Headless run: never block on an approval/sandbox prompt, and allow running
  // outside a git repo (workers may run in arbitrary scratch dirs).
  procArgs.push("--dangerously-bypass-approvals-and-sandbox");
  procArgs.push("--skip-git-repo-check");

  // Attach images natively (repeatable `-i/--image <FILE>`).
  for (const p of attachPaths) {
    procArgs.push("--image", p);
  }

  // Prompt is the trailing positional arg (both for fresh and resume forms).
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
        model: codexModelArg(model),
        costUsd: null,
        usage: null,
        structuredOutput: undefined,
        raw: null,
        stderr,
        isError: true,
        errorMessage: `codex spawn failed: ${spawnError}`,
      };
    }

    // ----- Parse the `codex exec --json` NDJSON event stream ----------------
    const pickItemText = (e: CodexEvent): string | null => {
      // Final answer lives on an `item.completed` event whose item is an
      // `agent_message`. Keep the LAST such item's text.
      if (e.item && e.item.type === "agent_message" && typeof e.item.text === "string" && e.item.text.length > 0) {
        return e.item.text;
      }
      return null;
    };

    let eventText: string | null = null;
    let sessionId: string | null = null;
    let usageEvt: CodexTokenUsage | undefined;
    let streamErr: string | null = null;
    let sawAnyEvent = false;

    const lines = stdout.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line[0] !== "{") continue;
      let evt: CodexEvent;
      try {
        // Untyped-JSON boundary: codex's event shape is external; we parse to
        // the optional-field `CodexEvent` interface and guard every access.
        evt = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }
      sawAnyEvent = true;
      const t = pickItemText(evt);
      if (t != null) eventText = t; // keep the last agent_message text
      const sid = evt.thread_id ?? evt.session_id ?? evt.conversation_id ?? evt.id;
      if (typeof sid === "string" && sid.length > 0) sessionId = sid;
      if (evt.usage) usageEvt = evt.usage;
      if (evt.error != null) {
        streamErr = typeof evt.error === "string" ? evt.error : (evt.error.message ?? "codex error");
      }
    }

    // Final text: prefer the parsed `agent_message` event; fall back to raw
    // stdout only if we never saw a structured event at all.
    let finalText: string | null = null;
    if (eventText != null && eventText.length > 0) {
      finalText = eventText;
    } else if (!sawAnyEvent && stdout.trim().length > 0) {
      finalText = stdout.trim();
    }

    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    // Codex reports cached input separately from fresh input; map onto our
    // TokenUsage shape (cacheReadInputTokens). Codex has no cache-creation
    // counter or per-call USD, so those are 0/null.
    const usage: TokenUsage | null = usageEvt
      ? {
          inputTokens: num(usageEvt.input_tokens),
          cacheReadInputTokens: num(usageEvt.cached_input_tokens),
          cacheCreationInputTokens: 0,
          outputTokens: num(usageEvt.output_tokens),
          costUsd: 0,
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
      model: codexModelArg(model),
      costUsd: null, // codex --json does not surface per-call USD
      usage,
      structuredOutput: undefined, // structured value is parsed in callCodexFormatted
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
 * Schema-constrained send for Codex. Uses codex's native `--output-schema`
 * flag: we write `opts.jsonSchema` to a temp `.json` file and pass it through,
 * so the final agent message is pure JSON we can parse directly. The balanced
 * JSON-object extractor is used only as a fallback when the message isn't
 * already pure JSON. `parsed` is populated on success, `parseError` on failure
 * (never both).
 */
export async function callCodexFormatted<R>(
  opts: CodexCallOptions & { jsonSchema: object },
): Promise<FormattedResult<R>> {
  const io = opts.io ?? realIO;
  // Write the schema to a temp file for `--output-schema`. Kept in its own
  // scratch dir so it survives the call (callCodexInternal manages its OWN
  // scratch dir for attachments / last-message) and is cleaned up here.
  const schemaDir = io.mkdtempSync(join(tmpdir(), "sp-codex-schema-"));
  const schemaPath = join(schemaDir, "schema.json");
  io.writeFileSync(schemaPath, JSON.stringify(opts.jsonSchema));

  let r: CodexCallResult;
  try {
    r = await callCodexInternal(opts, schemaPath);
  } finally {
    try {
      io.rmSync(schemaDir, { recursive: true, force: true });
    } catch {}
  }

  let parsed: R | null = null;
  let parseError: string | null = null;
  if (r.isError) {
    parseError = r.errorMessage ?? "codex call failed before producing output";
  } else {
    // With --output-schema the text should already be pure JSON; try that
    // first, then fall back to extracting the first balanced object.
    const tryParse = (s: string): boolean => {
      try {
        // Untyped-JSON boundary: the model's reply is external; we assert it
        // matches the requested schema R. Callers needing stronger guarantees
        // should validate `parsed` against the schema themselves.
        parsed = JSON.parse(s) as R;
        return true;
      } catch {
        return false;
      }
    };
    const direct = r.text.trim();
    if (!tryParse(direct)) {
      const sliced = extractFirstJsonObject(r.text);
      if (sliced == null || !tryParse(sliced)) {
        parsed = null;
        parseError = "codex reply could not be parsed as JSON matching the schema";
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
    const result: CodexCallResult = {
      text: "",
      sessionId: opts.resume ?? null, // preserve the conversation to resume from
      durationMs: 0,
      model: codexModelArg(opts.model),
      costUsd: null,
      usage: null,
      structuredOutput: undefined,
      raw: null,
      stderr: "",
      isError: false,
      errorMessage: null,
    };
    return Promise.resolve(result);
  },
  // `codex resume <id>` (interactive viewer; the `exec resume` variant needs a
  // prompt). Codex filters its session picker by cwd and these sessions ran in
  // a per-task worktree, so cd there first to make the session resolvable.
  resumeCommand: (id, cwd) =>
    id ? (cwd ? `(cd ${cwd} && codex resume ${id})` : `codex resume ${id}`) : null,
};

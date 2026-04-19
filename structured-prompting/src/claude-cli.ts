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

export interface ClaudeCallResult {
  text: string;             // the `result` field from --output-format json
  sessionId: string | null;
  durationMs: number;
  model: string | null;
  costUsd: number | null;
  /** Populated by the CLI when `--json-schema` was passed: the model's
   * structured reply, already parsed into an object. Undefined otherwise. */
  structuredOutput: unknown;
  raw: any;
  stderr: string;
  isError: boolean;
  errorMessage: string | null;
}

const DEFAULT_TIMEOUT_MS = 300_000;

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
        structuredOutput: undefined,
        raw: null,
        stderr,
        isError: true,
        errorMessage: `claude spawn failed: ${spawnError}`,
      };
    }

    // The CLI sometimes prefixes stdout with a stderr warning line ("no stdin
    // data received..."); find the JSON start before parsing.
    let parsed: any = null;
    const jsonStart = stdout.indexOf('{"type"');
    const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      // non-JSON output; fall through with parsed=null
    }
    const ok = parsed && parsed.type === "result" && parsed.is_error === false;
    return {
      text: parsed?.result ?? "",
      sessionId: parsed?.session_id ?? null,
      durationMs: parsed?.duration_ms ?? io.now() - started,
      model: parsed?.modelUsage ? Object.keys(parsed.modelUsage)[0] ?? null : model ?? null,
      costUsd: typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null,
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


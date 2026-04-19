---
name: structured-prompting
description: Declare LLM orchestrations in TypeScript (send / fork / compact / parallelFork / try / tryMultipleTimes / combineWith / switchModel / executeShell) instead of free-form natural-language steps. Every operation is a node in a live HTTP-monitored computation graph.
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
user_invocable: true
---

The `structured-prompting` library at `/workspaces/sashaslides/structured-prompting/` is a typed, graph-aware wrapper around the Claude Code CLI. Use it when a task is too branchy or retry-heavy for a single prose prompt — it lets you express forks, parallel work, typed JSON responses, retries with fallback, and shell steps as code, and renders every node of the run in a browser monitor.

## When to reach for it

- Multiple sub-tasks that should run in parallel (N bugs, N slides, N fixtures).
- Retry loops where the fallback needs a different model or a compacted context.
- Pipelines that mix model calls with shell measurement (`executeShell`) or structured JSON parsing (`send({format})`).
- Anything where you want to click into "which node failed and what did the model see there" instead of scrolling a long transcript.

If the task is one prompt, do not use this. If it has a shape, do.

## Project convention

Every project that uses the library keeps a **`structured-prompts/`** directory at its root (sibling of `structured-prompting/`). Each file inside is one reusable TS entry point for a task shape. Both the user and Claude Code edit these — treat them like source code, not throwaway prompts. When iterating, add a new file or refine an existing one; do not paste ad-hoc variants into the chat.

Layout:

```
<project>/
  structured-prompting/          # the library (do not edit without reason)
  structured-prompts/
    fix-bug-in-parallel.ts       # one entry point per task shape
    rerank-goldens.ts
    ...
```

## Authoring an entry point

Each file exports a `main` that takes `{session, ...args}` and returns a `SessionWithResult<T>`. Build up the graph by chaining operations on the session — nothing runs until you hand the whole thing to the engine.

```ts
// structured-prompts/fix-bugs.ts
import { sharedClaudeEngine, Session, Claude } from "../structured-prompting/src/index.js";

type Measured = { measuredValue: string };

export function main({ session, tasks }: {
  session: Session;
  tasks: { workspace_dir: string; bug: string }[];
}) {
  const tryWithModel = (s: Session, t: typeof tasks[number]) =>
    // Note the generic on .send<...>. The build step's transformer rewrites
    // this to inject typia.json.schema<Measured>() and typia inlines the
    // literal JSON Schema — no runtime reflection, no wrapper type.
    s.send<Measured>({
        prompt: `Task: ${t.bug}. Write code that measures the property proving the fix works, run it, return the measurement.`,
      })
      .combineWith(
        (s2) =>
          s2.send({ prompt: "Now perform the changes to fix the bug." })
            .send<Measured>({
              prompt: "Use the same method to measure the property again.",
            }),
        (before, after) => {
          if (before.measuredValue === after.measuredValue) {
            throw new Error(`Measurement did not change: ${before.measuredValue}`);
          }
          return { before, after };
        },
      );

  // parallelFork uses Promise.all semantics — a thrown child cancels
  // siblings. Terminate each branch in a fallback that calls
  // `materializeError(msg)` so per-task failures become Result<T> values.
  return session.fork().compact().parallelFork(tasks, (s, t) =>
    s.switchModel(Claude.sonnet).tryMultipleTimes<Result<{ before: Measured; after: Measured }>>(
      3,
      (s2) => tryWithModel(s2, t) as any, // widens FinalResult → Result<FinalResult>
      (s2, e) =>
        s2.fork().compact()
          .switchModel(Claude.opus)
          .prependToNextPrompt(`Previous attempt failed: ${JSON.stringify(e)}`)
          .tryMultipleTimes(3,
            (s3) => tryWithModel(s3, t) as any,
            (s3, e2) => s3.materializeError(JSON.stringify(e2)),
          ),
    ),
  );
}

// Run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  sharedClaudeEngine
    .execute(new Session({ sessionId: crypto.randomUUID() }), (s) =>
      main({ session: s, tasks: [/* ... */] }))
    .then((r) => console.log(JSON.stringify(r, null, 2)));
}
```

## Operation cheat sheet

From `src/types.ts` and the README:

- `session.send<T>({prompt, base64_attachments?, timeout?})` -> `SessionWithResult<T>` — `prompt` may be a literal string OR `(upstream) => string`. The build step's transformer injects `schema: typia.json.schema<T>()` automatically; typia's esbuild plugin then inlines a JSON Schema literal. At exec time the engine forwards the schema to the CLI via `--json-schema` and reads `result.structured_output` for the parsed value. Omit the generic to get raw text (`SessionWithResult<string>`). You can also pass `schema` yourself: `session.send({schema: typia.json.schema<T>(), prompt})` — the first overload picks that up and inference still works via `__type`.
- `session.fork()` -> `ForkedSession` (safe to branch from)
- `forked.compact()` -> `CompactedSession` (runs `/compact` before continuing)
- `compacted.switchModel(Claude.haiku | Claude.sonnet | Claude.opus)` -> `Session`
- `session.parallelFork(items, (s, item) => ...)` -> `SessionWithResult<R[]>` — each branch gets its own claude session id. **Throws propagate and cancel siblings (Promise.all semantics)** — wrap branches in a try/tryMultipleTimes + materializeError fallback to get per-branch error isolation
- `session.try(body, fallback)` / `session.tryMultipleTimes(max, body, fallback?)` -> retries; throw `InterruptException` inside `body` to skip remaining retries
- `result.combineWith(execution, combine?)` -> run a second pipeline from the same result, merge with `combine`
- `result.executeShell((r) => string)` -> run a shell command (stdout becomes the new result)
- `result.assert((r) => void)` -> throw inside to fail the node
- `session.materializeError<T>(errorString)` -> `SessionWithResult<Result<T>>` — constructs `{error: errorString}` as the current node's result. Available on plain Session too (for use inside try/tryMultipleTimes fallbacks that receive a bare Session)
- `session.prependToNextPrompt(str)` / `appendToNextPrompt(str)` -> inject context into the next `send`
- `session.newSession()` -> fresh conversation, same model

Errors carry the session snapshot (`StructuredError` in `errors.ts`); failure info is left on the graph node for debugging.

## Structured output (`send<T>({prompt})`)

You want typed JSON back? Write a plain TypeScript type and pass it as the generic on `send`:

```ts
type Measured = { measuredValue: string };

s.send<Measured>({ prompt: "…" });
// result: SessionWithResult<Measured>
```

No `schema: ...` argument, no Zod, no runtime builder. This works because the build step (`structured-prompting/build.ts`) chains two transformations inside one `esbuild` onLoad hook:

1. **`src/transformer.ts`** (AST rewrite) finds every `.send<T>({...})` call with a single object-literal argument and no `schema:` property, and injects `schema: typia.json.schema<T>()` into the literal. If `typia` wasn't imported, it prepends `import typia from "typia";`.
2. **`@typia/unplugin/api`'s `transformTypia`** (called in the same hook) then sees `typia.json.schema<T>()` at a concrete type — typia's own compiler pass — and inlines a literal JSON Schema object with full `$ref` / `components` structure.

At execution time the engine flattens typia's `{schema: {$ref}, components}` unit into a standalone JSON Schema and forwards it to the CLI via **`claude -p --json-schema <json>`**. Claude Code handles the schema internally (exposes a `StructuredOutput` tool to the model) and returns the parsed object on the result event's `structured_output` field — no prompt-tail tricks, no local JSON-regex extraction.

By the time `node dist/…mjs` runs, there is **no typia at runtime and no reflection** — the schemas are static data embedded in the bundle.

Why a transformer is necessary: TypeScript generics are type-erased. `s.send<Measured>({...})` compiles to `s.send({...})` — the `<Measured>` is gone. Something has to run before type-erasure to turn that generic into a runtime value. Typia is that "something" for `typia.xxx<T>()` syntax, and `src/transformer.ts` is the glue that adapts our `.send<T>(...)` syntax to what typia recognizes.

Opt-outs / alternatives:

- **Explicit schema**: write `s.send({ schema: typia.json.schema<Measured>(), prompt: "…" })` yourself. The first `send` overload picks this up and `R` is inferred from the schema's phantom `__type`. No `src/transformer.ts` needed — only `@typia/unplugin`.
- **Plain text**: `s.send({ prompt: "…" })` with no type argument returns `SessionWithResult<string>`.

## Building and running

The engine owns its HTTP monitor. You do not start or stop a server manually.

Every entry point must go through `build.ts` because of the transformer + typia passes:

```
npx tsx structured-prompting/build.ts <entry.ts> [outfile.mjs]
```

If `outfile` is omitted the default is `dist/<basename>.mjs`. Then `node <outfile>`.

- Canonical demo: `cd structured-prompting && npm run example` — builds `example/main-scaffolding.ts` then runs `node dist/main-scaffolding.mjs`.
- Your own entry point: `cd <project> && npx tsx structured-prompting/build.ts structured-prompts/<name>.ts && node dist/<name>.mjs`.
- Open **http://127.0.0.1:4711/** in a browser while the run is live. Click any node to see input args, raw response, parsed structured output, and validation errors on the right pane.
- The UI keeps showing the final state after the run finishes. Starting a new run replaces it.
- When Claude Code itself exits, the engine's `SIGTERM` / `SIGINT` hooks shut the monitor down. If a stray process is still bound to 4711, `lsof -ti:4711 | xargs -r kill`.

Model selection via the `Claude` namespace (`src/types.ts`): `Claude.haiku`, `Claude.sonnet`, `Claude.opus` — chain after `.compact()` with `.switchModel(...)`.

## Iteration workflow

1. Write or edit a file under `<project>/structured-prompts/`.
2. Run it (`npx tsx structured-prompts/<name>.ts`).
3. Open the monitor, find the red node, read its input + model output.
4. Edit the same file (tighten the prompt, add an `assert`, swap the fallback model, increase retries, split a `combineWith` into two nodes) and rerun.
5. Commit the file — it is the durable artifact, not the transcript.

## References

- `structured-prompting/README.md` — design spec (charitable reading; some typos).
- `structured-prompting/src/types.ts` — authoritative option and model types.
- `structured-prompting/src/graph.ts` — node kinds rendered by the monitor.
- `structured-prompting/src/claude-cli.ts` — CLI adapter (`--output-format json`, `--resume`, `--fork-session`, `--append-system-prompt`, attachments via tempfiles).
- `structured-prompting/src/transformer.ts` — the AST rewrite that makes `.send<T>({...})` structured-output work without passing schema explicitly.
- `structured-prompting/build.ts` — single-pass esbuild build that chains the transformer and `@typia/unplugin`'s `transformTypia`. Accepts any entry file.
- `structured-prompting/example/main.ts` — runnable demo; start here when writing a new entry point.

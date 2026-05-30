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
import { ClaudeEngine, Session, Claude } from "../structured-prompting/src/index.js";

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
  new ClaudeEngine()
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

## File conventions (main.ts + main-scaffolding.ts)

Non-trivial entry points split into **two files** — it keeps the reusable
prompt logic separate from per-run task data.

- **`main.ts`** — the structured prompt. Pure graph construction. Takes
  `{session, tasks}` (or similar), returns `SessionWithResult<...>`. Does
  NOT import `ClaudeEngine`, does NOT open ports, does NOT spawn
  long-lived subprocesses. Its top comment block is mandatory and must
  contain:

    ```ts
    /**
     * <name> — one-line purpose.
     *
     * ## How to use
     *   1. cd <project-root>
     *   2. Edit main-scaffolding.ts: fill in the task list (the default
     *      is an unresolved import so the build fails until you do).
     *   3. Build: `npx tsx structured-prompting/build.ts structured-prompts/<name>/main-scaffolding.ts`
     *   4. Run:   `node structured-prompting/dist/main-scaffolding.mjs`
     *   5. Monitor URL is printed on the first two lines of stderr.
     *
     * ## Per-task pipeline (what main.ts actually does)
     *   1. <describe step 1>
     *   2. ...
     *
     * ## Return type
     *   SessionWithResult<Array<Result<TaskResult>>> — one entry per task.
     *   Each TaskResult carries enough for main-scaffolding to launch
     *   follow-up side effects (e.g. a rating-server per task) AFTER the
     *   structured prompt finishes. main.ts itself does not start them.
     */
    ```

- **`main-scaffolding.ts`** — the runner that owns the process. It:
  * instantiates `ClaudeEngine` (or `CodexEngine`),
  * builds the task list (often via a sibling `workspace-setup.ts`),
  * calls `engine.execute(session, (s) => main({session: s, tasks}))`,
  * launches any post-run subprocesses as **direct `child_process.spawn`
    children of this Node process** (NOT `nohup … & disown`), tracks
    their PIDs in a Set, and registers `process.on('exit' | 'SIGINT' |
    'SIGTERM', …)` handlers that `child.kill('SIGTERM')` each one. This
    is how "when the main process dies, subprocesses die with it" is
    achieved on POSIX — orphaned children get re-parented to init and
    would otherwise linger.

### Default: scaffolding MUST NOT build without real data

Leave `main-scaffolding.ts` in a state that refuses to compile when the
file is freshly checked out or left at its template. The enforced pattern:

```ts
// ❌ DO NOT REMOVE the following import until you've created
// `./clusters.ts` with your actual task data. The build will fail —
// that's by design; it prevents accidental "smoke-test" runs.
import { CLUSTERS } from "./clusters.js";
```

`esbuild` refuses to resolve a non-existent import and aborts the build.
Once the user writes their `clusters.ts` (or whatever the sibling file is
named), the build succeeds. Don't ship a default stub that happens to
compile — that's what led to smoke runs happening by accident.

## Engine URL visibility

`ClaudeEngine.start()` prints the monitor URL to stderr the moment the
HTTP server binds:

```
┌── structured-prompting monitor
│ http://127.0.0.1:4711/
└──
```

That message is always visible when you start the structured prompt —
it's the first thing stderr emits. Do NOT add custom `console.log`
wrappers that could eat it. `main-scaffolding.ts` should echo the URL
one more time at the end (after `engine.execute` resolves) alongside any
per-task server URLs, so a reviewer scrolling to the bottom sees both
without searching back through logs.

## Subprocess lifetime

The `main.ts` structured prompt does NOT spawn long-lived external
processes. If a task needs a server (e.g. a per-task rating-server),
`main.ts` emits a spec in its `TaskResult` (`{port, slides, paths…}`)
and `main-scaffolding.ts` spawns the actual process AFTER
`engine.execute` resolves. The contract is: **once `main()` returns,
the scaffolding is done — it does not wait on servers**. Servers live
as independent detached processes the user kills manually when the
review is over.

```ts
for (const r of results) {
  if ("error" in r) continue;
  const ch = spawn("npx", ["tsx", "path/to/server.ts", ...args], {
    detached: true,             // new process group, own session
    stdio: ["ignore", "ignore", "ignore"],
  });
  ch.unref();                   // remove from Node's event-loop refcount
}
// main() returned; the servers are detached; Node's event loop has no
// more work → the scaffolding exits naturally (non-zero iff any task
// failed). Ctrl-C on the scaffolding does NOT reach the servers; user
// kills them with e.g. `lsof -ti:<port range> | xargs -r kill`.
if (anyFailures) process.exit(1);
```

Why this pattern:
- `engine.execute` returning is the "main script finished" signal. The
  scaffolding printing a summary and exiting is correct — a zombie
  scaffolding holding open a file descriptor to a long-dead engine
  isn't useful to anyone.
- `detached: true` + `child.unref()` makes the servers genuinely
  independent. They keep running when the scaffolding exits and survive
  the terminal closing.
- The earlier pattern (`detached: false` + `process.on("SIGINT", kill
  children)`) tied servers to the scaffolding lifecycle; that turned
  out wrong for the "fire + review + kill when done" flow of
  `bug_solving`-style tasks.
- `nohup … & disown` in an `executeShell` call from `main.ts` is still
  banned — it couples long-lived processes to the STRUCTURED-PROMPT's
  execution graph, which is the wrong layer. Keep the split clean:
  main.ts describes work, scaffolding owns processes.

## Surfacing per-task servers back to the user

When `main-scaffolding.ts` boots one rating/SxS server per task, the
user won't know when each one is ready — the servers come up in
parallel, sometimes minutes into a long run, and the user has probably
moved on to another window. Pair the scaffolding with a **port-range
notifier** consumed by the harness's `Monitor` tool so each new server
produces one chat message the moment it starts listening.

A minimal notifier (see
`renderer/structured-prompts/bug_solving/scripts/notify-new-servers.sh`
for the production version):

```bash
#!/usr/bin/env bash
set -u
PORT_FROM=${1:-4720}; PORT_TO=${2:-4800}
STATE=""
while :; do
  active=""
  for p in $(seq "$PORT_FROM" "$PORT_TO"); do
    lsof -ti tcp:"$p" -sTCP:LISTEN >/dev/null 2>&1 && active+="$p"$'\n'
  done
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if ! grep -qxF "$p" <<< "$STATE"; then
      title=$(curl -fsS -m 2 "http://localhost:$p/" 2>/dev/null \
              | grep -oE '<title>[^<]*</title>' | head -1 | sed -E 's#</?title>##g')
      printf 'NEW http://localhost:%s — %s\n' "$p" "${title:-(no title)}"
      STATE+="$p"$'\n'
    fi
  done <<< "$active"
  # drop ports that disappeared so a re-launch is re-announced
  STATE=$(while IFS= read -r p; do [[ -n "$p" ]] && grep -qxF "$p" <<< "$active" && echo "$p"; done <<< "$STATE")
  sleep 3
done
```

Start it once per session under `Monitor` with `persistent: true`:

```
Monitor({
  command: "bash path/to/notify-new-servers.sh",
  description: "new SxS servers on :4720-4800",
  persistent: true,
  timeout_ms: 3600000,
})
```

Every emitted `NEW http://localhost:<port>` line becomes one notification
so the user can click straight into a new server's UI. The script drops
a port from its internal state when the listener goes away, so if a task
retries and re-binds the same port, the rebind is re-announced.

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

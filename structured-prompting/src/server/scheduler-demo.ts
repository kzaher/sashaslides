/**
 * scheduler-demo.ts — a runnable, persistent demo of the graph-driven
 * scheduler (src/server/scheduler.ts) with RESTART-FROM-NODE, against either
 * the real Claude or the real Codex CLI.
 *
 * Run:
 *   npx tsx src/server/scheduler-demo.ts --engine claude --port 4799
 *   npx tsx src/server/scheduler-demo.ts --engine codex  --port 4799
 *
 *   --engine  claude | codex   (default: claude)   which ModelDriver/engine
 *   --port    N                (default: 4799)      persistent monitor port
 *
 * What it does:
 *   1. Builds the chosen engine (ClaudeEngine | CodexEngine) with
 *      `useScheduler = true` and a PERSISTENT monitor on `--port` (persist:true
 *      so the monitor stays up after the run — the listening socket keeps the
 *      event loop alive). The monitor URL is printed on startup.
 *   2. Builds a small REAL graph via the Session API:
 *        send "say hi" → executeShell "echo step …" → send "summarize"
 *      and runs it to completion under the scheduler (uses the real
 *      claude/codex CLI — tiny graph, so the cost is trivial). Because
 *      `useScheduler = true`, the send nodes go through the scheduler's send
 *      handler, which routes every model call through the engine's injected
 *      ModelDriver — so `--engine codex` actually spawns `codex exec`.
 *   3. RESTART DEMO (timer-loop fallback): every RESTART_PERIOD_MS it picks the
 *      middle executeShell node, `resetSubtree`s it (→ that node + the final
 *      send flip ok→pending), and re-drives the scheduler on the SAME graph
 *      with the SAME values map. The monitor visibly cycles those nodes
 *      ok→pending→ok on each tick, and the node id being restarted is printed.
 *
 * NOTE on live monitor-triggered restart: this worktree's monitor server
 * (server.ts) re-runs a node IN-PLACE via POST /api/retry using callClaude
 * directly — it does NOT re-drive the scheduler, and there is no /api/inject
 * endpoint here. Wiring a live scheduler re-drive into the server (threading
 * the registry + values map through startMonitor) is a larger change than this
 * demo warrants, so per the task we use the programmatic timer-loop fallback
 * below. The restart mechanism it exercises (resetSubtree + re-runScheduler on
 * the same graph/values) is exactly what a live /api/inject would call.
 */
import { ClaudeEngine, CodexEngine } from "./engine.js";
import { Session } from "./session.js";
import { runScheduler, defaultKindRegistry } from "./scheduler.js";
import { claudeDriver } from "./claude-cli.js";
import { codexDriver } from "./codex-cli.js";
import type { ModelDriver } from "./model-driver.js";
import type { ComputationGraph } from "./graph.js";

const RESTART_PERIOD_MS = 20_000;

function parseArgs(argv: string[]): { engine: "claude" | "codex"; port: number } {
  let engine: "claude" | "codex" = "claude";
  let port = 4799;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") {
      const v = argv[++i];
      if (v !== "claude" && v !== "codex") {
        throw new Error(`--engine must be "claude" or "codex" (got ${JSON.stringify(v)})`);
      }
      engine = v;
    } else if (a === "--port") {
      const n = parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--port must be a positive integer (got ${argv[i]})`);
      port = n;
    }
  }
  return { engine, port };
}

function log(msg: string): void {
  console.error(`[scheduler-demo] ${msg}`);
}

async function main(): Promise<void> {
  const { engine: engineName, port } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  // A real model the engine's driver will accept. For codex, codexModelArg
  // drops claude-family tokens and lets codex pick its account default, so
  // "haiku" is harmless either way (small/cheap on claude).
  const model = "haiku" as const;

  // Build the chosen engine + its driver. persist:true keeps the monitor up.
  const engine = engineName === "codex"
    ? new CodexEngine({ port, persist: true, log: true })
    : new ClaudeEngine({ port, persist: true, log: true });
  engine.useScheduler = true;
  const driver: ModelDriver = engineName === "codex" ? codexDriver : claudeDriver;
  log(`engine=${engineName} (driver=${driver.name}) useScheduler=true persist=true port=${port}`);

  // A tiny real graph: send → executeShell → send.
  const root = new Session({ model, cwd });
  let shellNodeId = "";
  await engine.execute(root, (s) => {
    const said = s.send({ prompt: "Reply with exactly the two words: say hi" });
    const stepped = said.executeShell(() => "echo demo-shell-step");
    shellNodeId = stepped.tipNodeId;
    return stepped.send({ prompt: (shellOut: unknown) => `Summarize this shell output in one short sentence: ${String(shellOut)}` });
  });

  log(`initial scheduler run complete. monitor: ${engine.monitorUrl ?? "(none)"}`);
  log(`open the monitor URL above; the restart loop will cycle node ${shellNodeId} (+ its successor) ok→pending→ok every ${RESTART_PERIOD_MS / 1000}s.`);

  const graph = engine.currentGraph as ComputationGraph;

  // ----- Restart loop (timer-loop fallback) ---------------------------------
  // Re-drive the scheduler on the SAME graph with a FRESH registry/values map
  // each cycle (a fresh values map is fine: un-reset upstream nodes still carry
  // their resolved outputs in their stored `output`, and the scheduler's
  // deriveCtx reads `output.ctxPatch` for session/model, so the reset send
  // re-resumes correctly; the shell node's command comes from its saved
  // node.input.cmd). The driver is threaded so a codex demo re-drives codex.
  let cycle = 0;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // never overlap re-drives
    running = true;
    cycle++;
    try {
      const reset = graph.resetSubtree(shellNodeId);
      log(`restart #${cycle}: resetSubtree(${shellNodeId}) → reset ${reset.length} node(s): ${reset.join(", ")} — re-driving scheduler…`);
      const { registry, values } = defaultKindRegistry(engine.io, driver);
      await runScheduler(graph, registry, {
        io: engine.io,
        values,
        driver,
        seedCtx: { model, cwd },
      });
      log(`restart #${cycle}: re-drive complete — nodes back to ok.`);
    } catch (err) {
      log(`restart #${cycle} failed: ${(err as Error)?.message ?? err}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, RESTART_PERIOD_MS);
  // Keep the process alive even if the monitor socket ever closes.
  timer.unref?.();

  // The persistent monitor keeps the event loop alive; print where to look.
  log(`process staying alive (Ctrl-C to stop). Monitor: ${engine.monitorUrl ?? "(none)"}`);
}

main().catch((e) => {
  console.error("[scheduler-demo] fatal:", e);
  process.exit(1);
});

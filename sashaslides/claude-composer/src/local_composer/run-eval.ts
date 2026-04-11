/**
 * run-eval.ts — Node CLI that drives the browser harness via CDP.
 *
 * Pipeline:
 *   1. Bundle `browser-harness.ts` → `browser-harness.bundle.js` (esbuild).
 *   2. Serve src/local_composer over a local HTTP server.
 *   3. Attach to Chrome via CDP (either an existing tab on --cdp-url, or the
 *      devcontainer's Chrome on http://127.0.0.1:9222 by default).
 *   4. Navigate to browser-harness.html.
 *   5. Call window.__localComposer.runEval({ modelId, adapterKind, limit }).
 *   6. Await the Promise via Runtime.awaitPromise.
 *   7. Write <modelId>.json to --out.
 *   8. Print a comparison table across all reports in --out.
 *
 * Usage:
 *   # Smoke test the full pipeline with the mock adapter (works on CPU, no GPU needed):
 *   tsx src/local_composer/run-eval.ts --adapter mock --model mock-vlm --limit 10 --out results/
 *
 *   # Real run (requires a host with WebGPU):
 *   tsx src/local_composer/run-eval.ts --adapter transformers-js \
 *     --model onnx-community/Qwen2.5-VL-7B-Instruct --out results/
 *
 *   # Just compare existing reports in --out without running anything:
 *   tsx src/local_composer/run-eval.ts --compare-only --out results/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ModelReport } from "./eval-types.js";

type AdapterKind = "webllm" | "transformers-js" | "mock";

type Args = {
  model: string;
  adapter: AdapterKind;
  out: string;
  cdpUrl: string;
  limit?: number;
  port: number;
  compareOnly?: boolean;
  timeoutMs: number;
};

function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = {
    out: "results",
    cdpUrl: "http://127.0.0.1:9222",
    port: 0, // 0 → pick any free port
    timeoutMs: 30 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i];
    else if (a === "--adapter") out.adapter = argv[++i] as AdapterKind;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--cdp-url") out.cdpUrl = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--compare-only") out.compareOnly = true;
  }
  if (!out.compareOnly) {
    if (!out.model) throw new Error("--model is required");
    if (!out.adapter) throw new Error("--adapter is required (webllm | transformers-js | mock)");
  }
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });

  if (args.compareOnly) {
    await printComparison(outDir);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));

  console.log(`[run-eval] bundling browser harness…`);
  await bundleHarness(here);

  const { stop, port } = await startStaticServer(here, args.port);
  try {
    console.log(`[run-eval] serving ${here} on http://127.0.0.1:${port}`);
    const url = `http://127.0.0.1:${port}/browser-harness.html`;

    console.log(`[run-eval] attaching to CDP at ${args.cdpUrl}`);
    const report = await driveViaCdp({
      cdpUrl: args.cdpUrl,
      pageUrl: url,
      modelId: args.model,
      adapterKind: args.adapter,
      limit: args.limit,
      timeoutMs: args.timeoutMs,
    });

    const safeId = args.model.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const suffix = args.limit ? `.limit${args.limit}` : "";
    const outPath = join(outDir, `${safeId}${suffix}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log(`[run-eval] wrote ${outPath}`);
    await printComparison(outDir);
  } finally {
    stop();
  }
}

async function bundleHarness(here: string): Promise<string> {
  const entry = resolve(here, "browser-harness.ts");
  const outfile = resolve(here, "browser-harness.bundle.js");
  // @ts-ignore — optional dep, loaded only on the driver host
  const esbuild = await import("esbuild").catch((e) => {
    throw new Error(`esbuild not installed: ${String(e)}`);
  });
  // `@huggingface/transformers` and `@mlc-ai/web-llm` are optional: they live
  // on the real GPU host, loaded via an import map at runtime. Keep them
  // external so the bundle builds even when they aren't installed (e.g. in
  // this devcontainer, where we only ever exercise the mock path).
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile,
    sourcemap: "inline",
    external: ["@huggingface/transformers", "@mlc-ai/web-llm"],
    logLevel: "warning",
  });
  return outfile;
}

/** Minimal static file server. No directory listing, no fancy MIME. */
async function startStaticServer(
  root: string,
  requestedPort: number,
): Promise<{ stop: () => void; port: number }> {
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const rel = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, "");
      const filePath = resolve(root, rel || "browser-harness.html");
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const st = await stat(filePath).catch(() => null);
      if (!st || !st.isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        "content-type": mime[extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (e) {
      res.writeHead(500).end(`server error: ${String(e)}`);
    }
  });

  await new Promise<void>((r) => server.listen(requestedPort, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    stop: () => server.close(),
  };
}

type DriveOpts = {
  cdpUrl: string;
  pageUrl: string;
  modelId: string;
  adapterKind: AdapterKind;
  limit?: number;
  timeoutMs: number;
};

async function driveViaCdp(opts: DriveOpts): Promise<ModelReport> {
  // @ts-ignore — dynamic because package exports only CJS
  const CDPmod = await import("chrome-remote-interface");
  const CDP = (CDPmod as unknown as { default: (o: object) => Promise<CdpClient> }).default ??
    (CDPmod as unknown as (o: object) => Promise<CdpClient>);
  const parsed = new URL(opts.cdpUrl);

  // Create a fresh tab for the eval so we don't interfere with anything else.
  // @ts-ignore
  const newTarget: { id: string; webSocketDebuggerUrl: string } = await (
    CDP as unknown as { New: (o: object) => Promise<{ id: string; webSocketDebuggerUrl: string }> }
  ).New({ host: parsed.hostname, port: Number(parsed.port || 9222), url: "about:blank" });

  const client: CdpClient = await CDP({
    host: parsed.hostname,
    port: Number(parsed.port || 9222),
    target: newTarget.id,
  });

  try {
    const { Page, Runtime, Log } = client;
    await Promise.all([Page.enable(), Runtime.enable(), Log.enable()]);

    Log.entryAdded(({ entry }: { entry: { level: string; text: string } }) => {
      if (entry.level === "error" || entry.level === "warning") {
        console.log(`[chrome:${entry.level}] ${entry.text}`);
      }
    });
    Runtime.consoleAPICalled(
      (ev: { type: string; args: Array<{ value?: unknown; description?: string }> }) => {
        const parts = ev.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? ""));
        console.log(`[chrome:${ev.type}] ${parts.join(" ")}`);
      },
    );
    Runtime.exceptionThrown((ev: { exceptionDetails: { text: string; exception?: { description?: string } } }) => {
      console.log(
        `[chrome:exception] ${ev.exceptionDetails.text} ${ev.exceptionDetails.exception?.description ?? ""}`,
      );
    });

    console.log(`[run-eval] navigating to ${opts.pageUrl}`);
    await Page.navigate({ url: opts.pageUrl });
    await Page.loadEventFired();

    // Wait until window.__localComposer is defined (bundle finished executing).
    const ready = await Runtime.evaluate({
      expression: `new Promise((r) => {
        const start = Date.now();
        (function tick(){
          if (window.__localComposer && typeof window.__localComposer.runEval === 'function') return r(true);
          if (Date.now() - start > 10000) return r(false);
          setTimeout(tick, 50);
        })();
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (!ready.result.value) {
      throw new Error("window.__localComposer.runEval did not appear within 10s. Check bundle errors above.");
    }

    const optsJson = JSON.stringify({
      modelId: opts.modelId,
      adapterKind: opts.adapterKind,
      limit: opts.limit,
    });
    console.log(`[run-eval] calling window.__localComposer.runEval(${optsJson})`);

    const evalResult = await Runtime.evaluate({
      expression: `window.__localComposer.runEval(${optsJson}).then(r => JSON.stringify(r))`,
      awaitPromise: true,
      returnByValue: true,
      timeout: opts.timeoutMs,
    });

    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails;
      throw new Error(`runEval threw: ${ex.text} ${ex.exception?.description ?? ""}`);
    }
    const jsonStr = evalResult.result.value as string;
    return JSON.parse(jsonStr) as ModelReport;
  } finally {
    await client.close().catch(() => {});
    // Close the tab we created so repeated runs don't leak.
    // @ts-ignore
    await (CDP as unknown as { Close: (o: object) => Promise<void> })
      .Close({ host: parsed.hostname, port: Number(parsed.port || 9222), id: newTarget.id })
      .catch(() => {});
  }
}

/** Minimal shape of chrome-remote-interface client we use. */
type CdpClient = {
  Page: {
    enable: () => Promise<void>;
    navigate: (o: { url: string }) => Promise<unknown>;
    loadEventFired: () => Promise<unknown>;
  };
  Runtime: {
    enable: () => Promise<void>;
    evaluate: (o: {
      expression: string;
      awaitPromise?: boolean;
      returnByValue?: boolean;
      timeout?: number;
    }) => Promise<{
      result: { value: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>;
    consoleAPICalled: (fn: (ev: { type: string; args: Array<{ value?: unknown; description?: string }> }) => void) => void;
    exceptionThrown: (fn: (ev: { exceptionDetails: { text: string; exception?: { description?: string } } }) => void) => void;
  };
  Log: {
    enable: () => Promise<void>;
    entryAdded: (fn: (ev: { entry: { level: string; text: string } }) => void) => void;
  };
  close: () => Promise<void>;
};

async function printComparison(outDir: string): Promise<void> {
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("[run-eval] no result files in", outDir);
    return;
  }
  const reports: ModelReport[] = [];
  for (const f of files) {
    const text = await readFile(join(outDir, f), "utf8");
    reports.push(JSON.parse(text) as ModelReport);
  }
  reports.sort((a, b) => b.summary.scoreMean - a.summary.scoreMean);

  const fmt = (n: number, w: number): string => n.toFixed(3).padStart(w);
  const row = (m: ModelReport): string =>
    `${m.modelDisplayName.slice(0, 32).padEnd(32)} ${fmt(m.summary.scoreMean, 6)} ${String(m.summary.passed).padStart(4)}/${String(m.summary.total).padStart(4)}  vis=${fmt(m.summary.byCategory.visual.scoreMean, 5)} act=${fmt(m.summary.byCategory.action.scoreMean, 5)} prefix_hit=${fmt(m.summary.avgPrefixHitRate, 5)} lat_total=${Math.round(m.summary.totalLatencyMs / 1000)}s`;

  console.log("\n=== model comparison ===");
  console.log("model".padEnd(32) + "  score   pass     visual action prefix    latency");
  for (const r of reports) console.log(row(r));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

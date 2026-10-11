// The VM boundary.
//
// Two implementations behind ONE interface so the app (and the tested sync engine) don't care which
// is running:
//
//   interface Vm {
//     exec(cmdline): Promise<{ stdout, stderr, code }>   // run a shell command
//     pullTar(vmPath): Promise<Uint8Array>               // tar of vmPath's contents
//     applyTar(vmPath, tarBytes): Promise<void>          // make vmPath's contents == tar (replace)
//     onOutput(cb): void                                 // stream interactive terminal output
//     input(text): void                                  // feed interactive terminal input
//   }
//
//   FakeVm       — in-memory, runs in any browser today. Proves the whole loop (mount as home,
//                  edit in a shell, sync back to real files) WITHOUT CheerpX. `claude` and `codex`
//                  are "preinstalled" here (canned shims) so demo.html works with zero setup.
//   CheerpxVm    — real Debian in WASM + Tailscale egress. Scaffolded with ⚠ ADAPT regions where
//                  the CheerpX console/device API must be wired; it does NOT silently fake success.
//
// VmStore wraps a Vm as a FileStore for one mount (one vmPath), using tar as the transport. runSync
// drives VmStore exactly like MemStore; the only VM-specific calls are pull()/commit().

import { MemStore } from "../lib/store.js";
import { buildTar, parseTar } from "../lib/tar.js";
import { normAbs } from "../lib/util.js";

// ---------------------------------------------------------------------------
// VmStore: FileStore view of one mounted vmPath, backed by an in-memory cache.
// ---------------------------------------------------------------------------
export class VmStore {
  constructor(vm, vmPath) {
    this.vm = vm;
    this.vmPath = normAbs(vmPath);
    this.cache = new MemStore();
  }
  // Refresh the cache from the VM (call before computing a sync).
  async pull() {
    const tar = await this.vm.pullTar(this.vmPath);
    this.cache = new MemStore();
    for (const e of parseTar(tar)) {
      if (e.type === "dir") await this.cache.mkdir(e.path);
      else await this.cache.write(e.path, e.data, e.mtime);
    }
  }
  // Flush the cache back into the VM (call after applying a sync).
  async commit() {
    const snap = await this.cache.snapshot();
    const entries = [];
    for (const [path, entry] of snap) {
      if (entry.type === "dir") entries.push({ path, type: "dir" });
      else entries.push({ path, type: "file", data: await this.cache.read(path), mtime: entry.mtime });
    }
    await this.vm.applyTar(this.vmPath, buildTar(entries));
  }
  // FileStore interface — delegates to the cache.
  snapshot() { return this.cache.snapshot(); }
  read(p) { return this.cache.read(p); }
  write(p, d, m) { return this.cache.write(p, d, m); }
  mkdir(p) { return this.cache.mkdir(p); }
  remove(p) { return this.cache.remove(p); }
}

// ---------------------------------------------------------------------------
// FakeVm: a good-enough in-memory Linux for the browser demo.
// ---------------------------------------------------------------------------
export function createFakeVm() {
  const mounts = new Map();          // vmPath -> MemStore
  let cwd = "/root";
  let outputCb = () => {};
  const store = (vmPath) => {
    vmPath = normAbs(vmPath);
    if (!mounts.has(vmPath)) mounts.set(vmPath, new MemStore());
    return mounts.get(vmPath);
  };
  // Resolve an absolute-ish path to [mountPath, relPathWithinMount].
  const locate = (p) => {
    let abs = p.startsWith("/") ? p : (cwd === "/" ? "/" + p : cwd + "/" + p);
    abs = normAbs(abs);
    let best = null;
    for (const mp of mounts.keys()) if (abs === mp || abs.startsWith(mp + "/")) {
      if (!best || mp.length > best.length) best = mp;
    }
    if (!best) return null;
    const rel = abs.slice(best.length).replace(/^\/+/, "");
    return { mount: best, rel };
  };

  const CLAUDE = "claude 2.0.0 (nanobox demo shim)\nUsage: claude [prompt]   — Anthropic Claude Code";
  const CODEX = "codex-cli 0.30.0 (nanobox demo shim)\nUsage: codex exec \"...\"  — OpenAI Codex CLI";

  async function exec(cmdline) {
    const line = cmdline.trim();
    if (!line) return { stdout: "", stderr: "", code: 0 };
    // very small shell: cmd args, plus `echo x > file`
    const redir = line.match(/^(.*?)>\s*(\S+)\s*$/);
    if (redir) {
      const m = redir[1].trim().match(/^echo\s+(.*)$/);
      const loc = locate(redir[2]);
      if (m && loc) { await store(loc.mount).write(loc.rel, m[1].replace(/^["']|["']$/g, "") + "\n"); return { stdout: "", stderr: "", code: 0 }; }
    }
    const [cmd, ...args] = line.split(/\s+/);
    const p = args[0];
    switch (cmd) {
      case "whoami": return { stdout: "root\n", stderr: "", code: 0 };
      case "pwd": return { stdout: cwd + "\n", stderr: "", code: 0 };
      case "cd": { if (p) cwd = normAbs(p.startsWith("/") ? p : cwd + "/" + p); return { stdout: "", stderr: "", code: 0 }; }
      case "claude": return { stdout: CLAUDE + "\n", stderr: "", code: 0 };
      case "codex": return { stdout: CODEX + "\n", stderr: "", code: 0 };
      case "which": return { stdout: p === "claude" ? "/usr/local/bin/claude\n" : p === "codex" ? "/usr/local/bin/codex\n" : "", stderr: "", code: p ? 0 : 1 };
      case "ls": {
        const loc = locate(p || ".");
        if (!loc) return { stdout: "", stderr: `ls: ${p}: not mounted\n`, code: 1 };
        const snap = await store(loc.mount).snapshot();
        const prefix = loc.rel ? loc.rel + "/" : "";
        const names = new Set();
        for (const key of snap.keys()) if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length).split("/")[0];
          if (rest) names.add(rest);
        }
        return { stdout: [...names].sort().join("\n") + (names.size ? "\n" : ""), stderr: "", code: 0 };
      }
      case "cat": {
        const loc = locate(p);
        if (!loc) return { stdout: "", stderr: `cat: ${p}: No such file\n`, code: 1 };
        try { return { stdout: new TextDecoder().decode(await store(loc.mount).read(loc.rel)), stderr: "", code: 0 }; }
        catch { return { stdout: "", stderr: `cat: ${p}: No such file\n`, code: 1 }; }
      }
      case "mkdir": { const loc = locate(p); if (loc) await store(loc.mount).mkdir(loc.rel); return { stdout: "", stderr: "", code: 0 }; }
      case "rm": { const loc = locate(args[args.length - 1]); if (loc) await store(loc.mount).remove(loc.rel); return { stdout: "", stderr: "", code: 0 }; }
      case "echo": return { stdout: args.join(" ") + "\n", stderr: "", code: 0 };
      default: return { stdout: "", stderr: `${cmd}: command not found\n`, code: 127 };
    }
  }

  return {
    kind: "fake",
    async exec(cmd) { return exec(cmd); },
    async pullTar(vmPath) {
      const s = store(vmPath);
      const snap = await s.snapshot();
      const entries = [];
      for (const [path, e] of snap) {
        if (e.type === "dir") entries.push({ path, type: "dir" });
        else entries.push({ path, type: "file", data: await s.read(path), mtime: e.mtime });
      }
      return buildTar(entries);
    },
    async applyTar(vmPath, tarBytes) {
      const fresh = new MemStore();
      for (const e of parseTar(tarBytes)) {
        if (e.type === "dir") await fresh.mkdir(e.path);
        else await fresh.write(e.path, e.data, e.mtime);
      }
      mounts.set(normAbs(vmPath), fresh);
    },
    onOutput(cb) { outputCb = cb; },
    async input(text) {
      const { stdout, stderr } = await exec(text);
      outputCb((stdout || "") + (stderr || ""));
    },
    setCwd(p) { cwd = normAbs(p); },
    getCwd() { return cwd; },
  };
}

// ---------------------------------------------------------------------------
// CheerpxVm: the real thing. SCAFFOLD — wire the ⚠ ADAPT regions against current CheerpX.
// Reference implementation for boot + Tailscale + terminal: github.com/leaningtech/webvm.
// ---------------------------------------------------------------------------
export async function createCheerpxVm(opts = {}) {
  // ⚠ ADAPT #1 — import + version. Confirm the current module URL/version at cheerpx.io/docs.
  const CheerpX = await import(/* @vite-ignore */ "https://cxrtnc.leaningtech.com/1.1.5/cx.js");

  // ⚠ ADAPT #2 — disk image + persistence. WebVM boots a hosted Debian ext2 over CloudDevice and
  // layers a persistent IDBDevice overlay. Grab the CURRENT disk URL from WebVM's config_*.js.
  const cloud = await CheerpX.CloudDevice.create("wss://disks.webvm.io/debian_large_20230522_5044875331.ext2");
  const overlay = await CheerpX.OverlayDevice.create(cloud, await CheerpX.IDBDevice.create("nanobox-overlay"));

  // ⚠ ADAPT #3 — Tailscale egress. Browsers can't open raw sockets; CheerpX tunnels via Tailscale.
  // Field names/flow drift — cross-check WebVM's networking setup. An auth key is required.
  const networkInterface = opts.tailscaleAuthKey
    ? { authKey: opts.tailscaleAuthKey, controlUrl: opts.controlUrl || "https://controlplane.tailscale.com" }
    : undefined;

  const cx = await CheerpX.Linux.create({
    mounts: [
      { type: "ext2", path: "/", dev: overlay },
      { type: "devs", path: "/dev" },
      { type: "proc", path: "/proc" },
    ],
    networkInterface,
  });

  // ⚠ ADAPT #4 — console + programmatic exec. WebVM wires cx to an xterm via a custom console.
  // To capture a command's stdout for pullTar/exec you attach a custom console buffer around a
  // cx.run(...) and read it back. This is the fiddliest part; port WebVM's console wiring.
  throw new Error(
    "CheerpxVm scaffold: wire ADAPT #1–#4 (see comments) against current CheerpX / WebVM source, " +
    "then implement exec/pullTar/applyTar/onOutput/input. Until then use createFakeVm()."
  );
}

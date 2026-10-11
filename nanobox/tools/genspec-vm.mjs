#!/usr/bin/env node
// genspec-vm.mjs <config.json> <out.json> [--shim] [--persist usr/local] [--state root,home,var]
// Variants of a runtime spec for the sandbox / system-node pages:
//   --shim     the "system node" delta (docs/system-node.md): the second virtio console /dev/hvc1 (char
//              229:1) — the host channel the guest-side node shim (nbnode) talks to the runtime worker
//              over — and PATH=/bundle/nb:... so `#!/usr/bin/env node` resolves to the shim served in the
//              bundle share as /bundle/nb/node. (This is exactly the delta between
//              web/images/claude-npm/config.json and config-vm.json.)
//   --persist  bind mounts of the persistent host-side tree (web/sandbox.html): the VM worker serves
//              bundle/persist/<p> over the built-in virtio-9p root device (wasi0, cache=loose), the guest
//              init mounts that device at /mnt/wasi0, and runc bind-mounts /mnt/wasi0/bundle/persist/<p>
//              onto /<p> in the container — writes go through the 9p share into the host tree (journaled
//              to OPFS).
//   --state    the same through the second virtio-9p device ("pack" preopen, wasi1): runc bind-mounts
//              /mnt/wasi1/<p> onto /<p> (unused by default: everything is on the bundle share)
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const [inFile, outFile] = args.filter((a) => !a.startsWith("--"));
if (!inFile || !outFile) { console.error("usage: genspec-vm.mjs <config.json> <out.json> [--shim] [--persist a,b,c]"); process.exit(2); }
const shim = args.includes("--shim");
const pi = args.indexOf("--persist"); const persist = pi >= 0 ? (args[pi + 1] || "").split(",").filter(Boolean) : [];
const si = args.indexOf("--state"); const state = si >= 0 ? (args[si + 1] || "").split(",").filter(Boolean) : [];
const spec = JSON.parse(readFileSync(inFile, "utf8"));
if (shim) {
  spec.process.env = spec.process.env.map((kv) => (kv.startsWith("PATH=") && !kv.startsWith("PATH=/bundle/nb:") ? "PATH=/bundle/nb:" + kv.slice(5) : kv));
  spec.linux = spec.linux || {};
  spec.linux.resources = spec.linux.resources || {};
  spec.linux.resources.devices = [...(spec.linux.resources.devices || []).filter((d) => !(d.major === 229 && d.minor === 1)), { allow: true, type: "c", major: 229, minor: 1, access: "rwm" }];
  spec.linux.devices = [...(spec.linux.devices || []).filter((d) => d.path !== "/dev/hvc1"), { path: "/dev/hvc1", type: "c", major: 229, minor: 1, fileMode: 384, uid: 0, gid: 0 }];
}
if (persist.length || state.length) {
  spec.mounts = (spec.mounts || []).filter((m) => !(m.source || "").startsWith("/mnt/wasi0/bundle/persist/") && !(m.source || "").startsWith("/mnt/wasi1/"));
  for (const p of persist) spec.mounts.push({ destination: "/" + p, type: "bind", source: "/mnt/wasi0/bundle/persist/" + p, options: ["rbind", "rw"] });
  for (const p of state) spec.mounts.push({ destination: "/" + p, type: "bind", source: "/mnt/wasi1/" + p, options: ["rbind", "rw"] });
}
writeFileSync(outFile, JSON.stringify(spec));
console.log(`spec: ${outFile} (${shim ? "shim: PATH=" + spec.process.env.find((k) => k.startsWith("PATH=")) + ", /dev/hvc1; " : ""}persist: ${persist.join(",") || "none"}; state: ${state.join(",") || "none"})`);

#!/usr/bin/env node
// genspec-vm.mjs <config.json> <config-vm.json>
// The "system node" variant of a runtime spec (docs/system-node.md): the same OCI runtime spec plus
//   * the second virtio console /dev/hvc1 (char 229:1) — the host channel the guest-side node shim
//     (nbnode) talks to the runtime worker over,
//   * PATH=/bundle/nb:... so the shim (served in the bundle share as /bundle/nb/node) is the `node`
//     that `#!/usr/bin/env node` scripts resolve to.
// This is exactly the delta between web/images/claude-npm/config.json and config-vm.json.
import { readFileSync, writeFileSync } from "node:fs";
const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error("usage: genspec-vm.mjs <config.json> <config-vm.json>"); process.exit(2); }
const spec = JSON.parse(readFileSync(inFile, "utf8"));
spec.process.env = spec.process.env.map((kv) => (kv.startsWith("PATH=") && !kv.startsWith("PATH=/bundle/nb:") ? "PATH=/bundle/nb:" + kv.slice(5) : kv));
spec.linux = spec.linux || {};
spec.linux.resources = spec.linux.resources || {};
spec.linux.resources.devices = [...(spec.linux.resources.devices || []).filter((d) => !(d.major === 229 && d.minor === 1)), { allow: true, type: "c", major: 229, minor: 1, access: "rwm" }];
spec.linux.devices = [...(spec.linux.devices || []).filter((d) => d.path !== "/dev/hvc1"), { path: "/dev/hvc1", type: "c", major: 229, minor: 1, fileMode: 384, uid: 0, gid: 0 }];
writeFileSync(outFile, JSON.stringify(spec));
console.log(`vm spec: ${outFile} (PATH=${spec.process.env.find((k) => k.startsWith("PATH="))}, /dev/hvc1)`);

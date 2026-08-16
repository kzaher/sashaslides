// node test: load an image layout into the NanoboxFs tree and check a few paths (incl. symlinks)
globalThis.self = globalThis;
await import("../web/wasifs.js"); await import("../web/oci.js");
const base = process.argv[2] || "http://localhost:8093/c2w/images/codex/";
const t0 = performance.now();
const img = await NanoboxOci.load(base, { onProgress: (p) => console.log(JSON.stringify(p)) });
console.log(`loaded ${img.files} entries from ${(img.compressedBytes / 1e6).toFixed(1)} MB compressed in ${(performance.now() - t0).toFixed(0)} ms`);
const F = NanoboxFs;
for (const p of ["bin", "bin/sh", "usr/local/bin/codex", "usr/bin/busybox", "lib", "lib64", "etc/passwd", "root", "proc", "dev", "sys", "tmp", "etc/ssl/certs"]) {
  const n = F.lookup(img.rootfs, p);
  console.log(p.padEnd(24), n ? (n.t === "l" ? `symlink -> ${n.target}` : n.t === "d" ? `dir (${n.e.size} entries)` : `file ${n.data.byteLength} bytes`) : "MISSING");
}

#!/usr/bin/env node
// Recompress an OCI Image Layout's layers with gzip, in place.
//
//   node vm-build/oci-gzip.mjs public/c2w/images/claude
//
// `docker save` writes uncompressed layers (mediaType .tar). container2wasm's in-browser
// imagemounter tries eStargz, then gzip, then plain tar — but its browser-side gzip step, when it
// fails, never marks the layer done, so an uncompressed layer wedges the boot instead of falling
// through to tar mode. Publishing gzipped layers keeps it on the path that works (and the transfer
// is ~3x smaller). diff_ids in the image config stay untouched: those are digests of the
// *uncompressed* layers, which is exactly what they still are.
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: oci-gzip.mjs <oci-layout-dir>"); process.exit(2); }

const blobPath = (digest) => join(dir, "blobs", "sha256", digest.split(":")[1]);
const readJSON = (digest) => JSON.parse(readFileSync(blobPath(digest), "utf8"));
const writeBlob = (buf) => {
  const digest = "sha256:" + createHash("sha256").update(buf).digest("hex");
  writeFileSync(blobPath(digest), buf);
  return { digest, size: buf.length };
};

const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
let changed = false;

for (const entry of index.manifests) {
  const manifest = readJSON(entry.digest);
  const oldManifestBlob = blobPath(entry.digest);
  let touched = false;

  for (const layer of manifest.layers) {
    if (layer.mediaType.endsWith("+gzip") || layer.mediaType.endsWith(".gzip")) continue;
    const raw = readFileSync(blobPath(layer.digest));
    // level 6: level 9 costs minutes on a 300 MB layer for ~1% less to transfer over localhost.
    const gz = gzipSync(raw, { level: 6 });
    const old = blobPath(layer.digest);
    const { digest, size } = writeBlob(gz);
    unlinkSync(old);
    console.log(`  ${layer.digest.slice(7, 19)} ${(raw.length / 1e6).toFixed(1)}MB -> ${(size / 1e6).toFixed(1)}MB gzip`);
    layer.digest = digest;
    layer.size = size;
    layer.mediaType = layer.mediaType.replace(/\.tar$/, ".tar+gzip");
    touched = true;
  }

  if (!touched) continue;
  const buf = Buffer.from(JSON.stringify(manifest));
  const { digest, size } = writeBlob(buf);
  unlinkSync(oldManifestBlob);
  entry.digest = digest;
  entry.size = size;
  changed = true;
}

if (changed) {
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
  console.log(`  rewrote ${join(dir, "index.json")}`);
} else {
  console.log("  already gzipped; nothing to do");
}

// leave no orphan blobs behind (they'd just be served-but-unreferenced bytes)
const referenced = new Set();
for (const entry of index.manifests) {
  referenced.add(entry.digest.split(":")[1]);
  const m = readJSON(entry.digest);
  referenced.add(m.config.digest.split(":")[1]);
  for (const l of m.layers) referenced.add(l.digest.split(":")[1]);
}
for (const f of readdirSync(join(dir, "blobs", "sha256"))) {
  if (!referenced.has(f)) { unlinkSync(join(dir, "blobs", "sha256", f)); console.log(`  pruned orphan blob ${f.slice(0, 12)}`); }
}

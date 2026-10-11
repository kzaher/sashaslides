#!/usr/bin/env node
// genspec.mjs <oci-layout-dir> <template config.json> <out-dir>
// Writes <out-dir>/imageconfig.json (the image config blob) and <out-dir>/config.json: the OCI
// runtime spec container2wasm's imagemounter would generate for the image — the template (an
// existing web/images/<image>/config.json, produced by work/c2w-src/extras/imagemounter/genspec)
// with process.args/env/cwd replaced from the image config, exactly as genspec's main.go does
// (WithEnv(image Env) + WithTTY's TERM=xterm, args = Entrypoint+Cmd, cwd = WorkingDir).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const [dir, template, out] = process.argv.slice(2);
if (!dir || !template || !out) { console.error("usage: genspec.mjs <oci-dir> <template config.json> <out-dir>"); process.exit(2); }
const blob = (d) => readFileSync(join(dir, "blobs", "sha256", d.split(":")[1]));
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const manifest = JSON.parse(blob(index.manifests[0].digest).toString());
const configBytes = blob(manifest.config.digest);
const image = JSON.parse(configBytes.toString());
const spec = JSON.parse(readFileSync(template, "utf8"));
const ic = image.config || {};
spec.process.env = [...(ic.Env || []), "TERM=xterm"];
const args = [...(ic.Entrypoint || []), ...(ic.Cmd || [])];
if (args.length) spec.process.args = args;
if (ic.WorkingDir) spec.process.cwd = ic.WorkingDir;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "imageconfig.json"), configBytes);
writeFileSync(join(out, "config.json"), JSON.stringify(spec));
console.log(`spec: args=${JSON.stringify(spec.process.args)} cwd=${spec.process.cwd} env=${spec.process.env.length} layers=${manifest.layers.length}`);

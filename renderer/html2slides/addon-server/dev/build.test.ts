// THE PAGE BUILD (build.ts) and THE IMAGE THAT RUNS IT (../Dockerfile): every bundle builds, carries
// what it must, and every source file it reads is copied into the image's build stage, so a deploy
// cannot fail on a file that only exists on a laptop.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { pageBundles } from "./build.ts";

const SITE_DIR = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(SITE_DIR, "../../..");
const DOCKERFILE = readFileSync(join(SITE_DIR, "Dockerfile"), "utf8");

type Built = Readonly<{ name: string; text: string; inputs: readonly string[] }>;

let builtOnce: Promise<readonly Built[]> | null = null;

/** Every bundle, in memory, with the repository-relative paths of its inputs. */
function builtBundles(): Promise<readonly Built[]> {
  builtOnce ??= Promise.all(
    pageBundles().map(async (bundle) => {
      const result = await build({ ...bundle.options, write: false, metafile: true, outfile: join(SITE_DIR, "public", bundle.name) });
      const inputs = Object.keys(result.metafile.inputs).map((input) => relative(REPOSITORY_ROOT, resolve(process.cwd(), input)));
      return { name: bundle.name, text: result.outputFiles[0]?.text ?? "", inputs };
    }),
  );
  return builtOnce;
}

/** The repository paths the build stage copies (`COPY <source…> <destination>` before the runtime stage). */
function builderCopySources(): readonly string[] {
  const builder = DOCKERFILE.split(/^FROM .* AS runtime$|^FROM --platform/m)[0] ?? "";
  return [...builder.matchAll(/^COPY (?!--from)(.+)$/gm)].flatMap((match) => {
    const parts = (match[1] ?? "").trim().split(/\s+/);
    return parts.slice(0, -1).map((part) => part.replace(/\/$/, ""));
  });
}

test("the three bundles build, and the page carries the product converter and the compiled extractor", async () => {
  const bundles = await builtBundles();
  assert.deepEqual(bundles.map((bundle) => bundle.name), ["dev.js", "dev-pptx.js", "e2e-drawio.js"]);
  const page = bundles.find((bundle) => bundle.name === "dev.js");
  assert.ok(page !== undefined);
  assert.ok(page.inputs.includes("mcp/sasha-slides/converter/convert-html-to-slide-requests.ts"), "the product converter");
  assert.ok(page.inputs.includes("mcp/sasha-slides/converter/drawio-embed.ts"), "the draw.io renderer");
  assert.match(page.text, /__H2S_EXTRACT__/, "the extractor is inlined");
  assert.doesNotMatch(page.text, /__SASHA_EXTRACTOR_JS__/, "and its placeholder replaced");
  assert.ok(!page.inputs.some((input) => input.includes("convert-pptx-lib")), "the .pptx converter stays out of the page");
});

test("the .pptx bundle uses OUR pptxgenjs fork from source, and the command-line browser core", async () => {
  const pptx = (await builtBundles()).find((bundle) => bundle.name === "dev-pptx.js");
  assert.ok(pptx !== undefined);
  assert.ok(pptx.inputs.includes("deps/pptxgenjs/src/pptxgen.ts"), "the fork's source");
  assert.ok(!pptx.inputs.some((input) => input.startsWith("node_modules/pptxgenjs")), "never the npm release");
  assert.ok(pptx.inputs.includes("renderer/html2slides/browser/convert-core.ts"));
  assert.match(pptx.text, /SashaDevPptx/);
  assert.doesNotMatch(pptx.text, /__EXTRACT_JS_LITERAL__/);
});

test("every file a bundle reads is copied into the image's build stage", async () => {
  const copied = builderCopySources();
  const uncovered = new Set<string>();
  for (const bundle of await builtBundles()) {
    for (const input of bundle.inputs) {
      // Installed packages come from `npm ci`, not from a COPY.
      if (input.split("/").includes("node_modules")) continue;
      if (!copied.some((source) => input === source || input.startsWith(`${source}/`))) uncovered.add(input);
    }
  }
  assert.deepEqual([...uncovered], [], `add these to the Dockerfile's builder stage (and deploy/publish.sh's site tarball): ${[...uncovered].join(", ")}`);
});

test("the image builds the page with dev/build.ts and never runs the old add-on build", () => {
  assert.match(DOCKERFILE, /npm run build/);
  for (const file of filesUnder(SITE_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /build-addon|pptxgen\.bundle\.js|convert-bundle\.js/, relative(SITE_DIR, file));
  }
});

/** Text files of the site, outside node_modules and built output. */
function filesUnder(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return name === "walkthroughs" ? [] : filesUnder(path);
    if (!/\.(ts|tsx|html|css|json|md|yml|conf)$|^Dockerfile$/.test(name)) return [];
    return /^(dev|dev-pptx|e2e-drawio)\.js$/.test(name) ? [] : [path];
  });
}


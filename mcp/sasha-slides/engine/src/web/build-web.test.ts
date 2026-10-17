// THE WEB BUILD (acceptance 11): build-web.ts writes a manifest that parses as `WebBuildManifest`,
// names every asset by its content, sends exactly SPEC.md 21.8's policy (the embedded variant
// differing only in `frame-ancestors`), and ships the runner page with its policy. One real build
// into a temporary directory, minified as in production.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ASSETS_DIRECTORY, buildWeb, MANIFEST_FILE, RUNNER_DIRECTORY } from "../../build-web.ts";
import { ADDON_FRAME_ANCESTORS, type WebBuildManifest } from "../contracts/deck-api.ts";
import { PRESENTER_INLINE_STYLE_TEXTS } from "./content-security-policy.ts";
import { arrayAt, parseOrNull, parseStructuredText, recordOf, stringAt } from "../shared/untrusted-values.ts";

/** The presenter's fixed style elements, by hash: the only inline stylesheets the pages accept. */
const PRESENTER_STYLE_HASHES = PRESENTER_INLINE_STYLE_TEXTS.map((text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`).join(" ");
const SPEC_POLICY =
  `default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com ${PRESENTER_STYLE_HASHES}; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

describe("11. build-web.ts", () => {
  let directory = "";
  let manifest: WebBuildManifest | null = null;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "sasha-web-build-"));
    await buildWeb({ outputDirectory: directory, minify: true, now: () => new Date("2026-10-15T00:00:00Z") });
    manifest = parseManifest(readFileSync(join(directory, MANIFEST_FILE), "utf8"));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes dist/web/manifest.json that parses as a WebBuildManifest", () => {
    assert.ok(manifest !== null, "the manifest parses");
    assert.equal(manifest.builtAt, "2026-10-15T00:00:00.000Z");
    for (const page of [manifest.listPage, manifest.deckPage]) assert.ok(existsSync(join(directory, page)), page);
  });

  it("names every asset by its content and lists exactly the assets directory", () => {
    assert.ok(manifest !== null);
    assert.ok(manifest.assets.length >= 4, manifest.assets.join(", "));
    for (const asset of manifest.assets) {
      assert.match(asset, /-[A-Za-z0-9]{8,}\.(js|css|js\.map)$/, `${asset} carries a content hash`);
      assert.ok(existsSync(join(directory, ASSETS_DIRECTORY, asset)), asset);
    }
    for (const page of [manifest.listPage, manifest.deckPage]) {
      const shell = readFileSync(join(directory, page), "utf8");
      const referenced = [...shell.matchAll(/(?:href|src)="\/deck-app\/([^"]+)"/g)].map((match) => match[1] ?? "");
      assert.equal(referenced.length, 2, `${page}: one stylesheet and one script`);
      for (const file of referenced) assert.ok(manifest.assets.includes(file), `${page} references ${file}, which is in the manifest`);
      assert.doesNotMatch(shell, /<script>(?!\s*<\/script>)|<script(?![^>]*(src=|type="application\/json"))[^>]*>/, `${page}: no inline executable script`);
      assert.doesNotMatch(shell, /<style/, `${page}: no inline style element`);
    }
  });

  it("sends exactly the SPEC 21.8 policy, and the embedded variant differs only in frame-ancestors", () => {
    assert.ok(manifest !== null);
    assert.equal(manifest.contentSecurityPolicy, SPEC_POLICY);
    const plain = manifest.contentSecurityPolicy.split("; ");
    const embedded = manifest.embeddedContentSecurityPolicy.split("; ");
    assert.equal(embedded.length, plain.length);
    const differing = plain.flatMap((directive, index) => (directive === embedded[index] ? [] : [{ plain: directive, embedded: embedded[index] }]));
    assert.deepEqual(differing, [{ plain: "frame-ancestors 'none'", embedded: `frame-ancestors ${ADDON_FRAME_ANCESTORS.join(" ")}` }]);
  });

  it("ships the runner page and its policy", () => {
    assert.ok(manifest !== null);
    assert.ok(existsSync(join(directory, RUNNER_DIRECTORY, manifest.runnerPage)), "the runner page");
    assert.match(manifest.runnerContentSecurityPolicy, /default-src 'none'/);
    const deckShell = readFileSync(join(directory, manifest.deckPage), "utf8");
    assert.ok(deckShell.includes(`/deck-app/${RUNNER_DIRECTORY}/${manifest.runnerPage}`), "the deck page is configured with the runner's address");
  });
});

/** The manifest as the connector would read it, checked field by field. */
function parseManifest(text: string): WebBuildManifest | null {
  return parseOrNull(() => {
    const record = recordOf(parseStructuredText(text), "manifest");
    return {
      listPage: stringAt(record, "listPage"),
      deckPage: stringAt(record, "deckPage"),
      assets: arrayAt(record, "assets").map((asset) => stringAt({ asset }, "asset")),
      contentSecurityPolicy: stringAt(record, "contentSecurityPolicy"),
      embeddedContentSecurityPolicy: stringAt(record, "embeddedContentSecurityPolicy"),
      runnerPage: stringAt(record, "runnerPage"),
      runnerContentSecurityPolicy: stringAt(record, "runnerContentSecurityPolicy"),
      builtAt: stringAt(record, "builtAt"),
    };
  });
}

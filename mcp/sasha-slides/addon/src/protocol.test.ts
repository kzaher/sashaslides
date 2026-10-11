// The parse boundary: READY, manifest.json, the Slides URL, and the 1280x720 self-containment check.
// Everything here is pure, so an untrusted-input case costs nothing to cover.

import assert from "node:assert/strict";
import test from "node:test";
import { checkSlideHtml, type ParsedSlideDocument } from "./html-check.ts";
import { parseManifest, parseReadyMarker } from "./protocol.ts";
import { presentationIdOf, explainHostFailure } from "./bridge.ts";

test("a well-formed READY parses", () => {
  const parsed = parseReadyMarker('{"protocolVersion":1,"proposalId":"p_1","count":4,"manifestFileId":"1Mno"}');
  assert.deepEqual(parsed, {
    kind: "ok",
    value: { protocolVersion: 1, proposalId: "p_1", count: 4, manifestFileId: "1Mno" },
  });
});

test("an unknown protocolVersion is reported as such, never guessed at", () => {
  const parsed = parseReadyMarker('{"protocolVersion":2,"proposalId":"p_1","count":1,"manifestFileId":"m"}');
  assert.deepEqual(parsed, { kind: "unsupported-version", protocolVersion: 2 });
});

test("malformed READY bodies are invalid, not thrown", () => {
  for (const body of ["", "null", "[]", "{}", '{"protocolVersion":1}', '{"protocolVersion":1,"proposalId":"p","count":0,"manifestFileId":"m"}']) {
    assert.equal(parseReadyMarker(body).kind, "invalid", JSON.stringify(body));
  }
});

test("a manifest's slides must be 1..count in order, because the picker numbers off them", () => {
  const ok = parseManifest(manifestJson([1, 2, 3]));
  assert.equal(ok.kind, "ok");
  assert.equal(ok.kind === "ok" ? ok.value.count : 0, 3);

  for (const indices of [[0, 1, 2], [1, 3, 2], [1, 2, 4], [2, 3, 4]]) {
    assert.equal(parseManifest(manifestJson(indices)).kind, "invalid", JSON.stringify(indices));
  }
});

test("a manifest whose count disagrees with its slides is invalid", () => {
  assert.equal(parseManifest(manifestJson([1, 2, 3], 4)).kind, "invalid");
});

test("presentationId may be null but not a number", () => {
  assert.equal(parseManifest(manifestJson([1], 1, "null")).kind, "ok");
  assert.equal(parseManifest(manifestJson([1], 1, "7")).kind, "invalid");
});

test("presentationIdOf accepts only the Slides editor URL", () => {
  assert.equal(presentationIdOf("https://docs.google.com/presentation/d/1AbCdEfGhIjK/edit#slide=id.p"), "1AbCdEfGhIjK");
  assert.equal(presentationIdOf("https://docs.google.com/presentation/d/1AbCdEfGhIjK"), "1AbCdEfGhIjK");
  // Multi-login accounts: getUrl() keeps the /u/<n>/ segment. Regression from the live add-on.
  assert.equal(presentationIdOf("https://docs.google.com/u/0/presentation/d/1AbCdEfGhIjK/edit"), "1AbCdEfGhIjK");
  assert.equal(presentationIdOf("https://docs.google.com/u/3/presentation/d/1AbCdEfGhIjK/edit#slide=id.p"), "1AbCdEfGhIjK");
  assert.equal(presentationIdOf("https://docs.google.com/u/0/document/d/1AbCdEfGhIjK/edit"), null);
  // The legacy Drive form is what SlidesApp.getActivePresentation().getUrl() really returns.
  assert.equal(presentationIdOf("https://docs.google.com/open?id=1AbCdEfGhIjK"), "1AbCdEfGhIjK");
  assert.equal(presentationIdOf("https://docs.google.com/open?id=1AbCdEfGhIjK&usp=drive_fs"), "1AbCdEfGhIjK");
  assert.equal(presentationIdOf("https://evil.example/open?id=1AbCdEfGhIjK"), null);
  assert.equal(presentationIdOf("http://docs.google.com/open?id=1AbCdEfGhIjK"), null);
  assert.equal(presentationIdOf("https://docs.google.com/document/d/1AbCdEfGhIjK/edit"), null);
  assert.equal(presentationIdOf("https://evil.example/presentation/d/1AbCdEfGhIjK/edit"), null);
  assert.equal(presentationIdOf("http://docs.google.com/presentation/d/1AbCdEfGhIjK/edit"), null);
});

test("a self-contained 1280x720 document passes with no warnings", () => {
  const checked = checkSlideHtml({
    html: "ignored -- the parse is injected",
    parse: () =>
      stubDocument({ styleText: "body { margin: 0; width: 1280px; height: 720px; }", title: "Timeline" }),
  });
  assert.deepEqual(checked, { title: "Timeline", declaredWidthPx: 1280, declaredHeightPx: 720, warnings: [] });
});

test("the declared size is read out of the stylesheet, not from a computed style", () => {
  const inline = checkSlideHtml({
    html: "",
    parse: () => stubDocument({ bodyInlineStyle: "width:1280px;height:720px" }),
  });
  assert.deepEqual(inline.warnings, []);
  const wrongSize = checkSlideHtml({ html: "", parse: () => stubDocument({ styleText: "body{width:960px;height:540px}" }) });
  assert.deepEqual(wrongSize.warnings, ["body width is 960px, expected 1280px", "body height is 540px, expected 720px"]);
});

test("a fragment and an external dependency are both reported", () => {
  const checked = checkSlideHtml({
    html: "",
    parse: () =>
      stubDocument({
        hasHead: false,
        styleText: "",
        externalUrls: ["https://cdn.example/chart.png"],
      }),
  });
  assert.ok(checked.warnings.some((warning) => warning.includes("looks like a fragment")));
  assert.ok(checked.warnings.some((warning) => warning.includes("no inline <style>")));
  assert.ok(checked.warnings.some((warning) => warning.includes("https://cdn.example/chart.png")));
});

test("something that is not a document at all is one warning, not a crash", () => {
  const checked = checkSlideHtml({ html: "", parse: () => null });
  assert.deepEqual(checked.warnings, ["the file did not parse as an HTML document"]);
  assert.equal(checked.title, null);
});

function stubDocument(overrides: Partial<ParsedSlideDocument> = {}): ParsedSlideDocument {
  return {
    title: "",
    hasHead: true,
    styleText: "body { width: 1280px; height: 720px; }",
    bodyInlineStyle: "",
    externalUrls: [],
    ...overrides,
  };
}

function manifestJson(indices: readonly number[], count = indices.length, presentationId = '"deck_1"'): string {
  const slides = indices.map(
    (index) => `{"index":${index},"fileId":"f${index}","name":"0${index}.html","label":"option ${index}"}`,
  );
  return (
    `{"protocolVersion":1,"proposalId":"p_1","createdAt":"2026-10-03T12:00:00.000Z",` +
    `"presentationId":${presentationId},"count":${count},"slides":[${slides.join(",")}]}`
  );
}

test("explainHostFailure turns Google's opaque host errors into instructions", () => {
  // The exact string the live add-on produced in a multi-account browser.
  const storage = explainHostFailure(
    "We're sorry, a server error occurred while reading from storage. Error code PERMISSION_DENIED.",
  );
  assert.ok(storage !== null);
  assert.match(storage, /more than one Google account/i);
  assert.match(storage, /Incognito|default/i);

  assert.match(explainHostFailure("Authorization is required to perform that action.") ?? "", /authorising|authorizing/i);
  assert.match(explainHostFailure("Script function not found: sashaInsert") ?? "", /older than this picker/i);
  assert.match(
    explainHostFailure('Google Slides API has not been used in project 342987503423 before') ?? "",
    /ADVANCED SERVICE/,
  );

  // Anything unrecognised is passed through untouched by the caller.
  assert.equal(explainHostFailure("some other failure"), null);
  // A storage error WITHOUT the permission code is not the multi-account case.
  assert.equal(explainHostFailure("error occurred while reading from storage"), null);
});

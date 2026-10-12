// REMOTE CLIENTS SEND MARKUP: claude.ai and ChatGPT reach the connector over HTTPS and cannot put a file
// on its disk, so a slide can arrive as `html`. Measured 2026-10-12 on https://sashaslides.com: claude.ai
// wrote two candidates in its own sandbox and propose_slides answered "not a readable file:
// /home/claude/slides/title_dark_centered.html" twice. On the remote server `path` is also refused,
// because it would let any signed-in caller upload any file on the server into their own Drive.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createProposal, MAX_INLINE_HTML_BYTES, reviseSlide, type ProposalEnvironment } from "../proposal";
import { slideSourcesFrom } from "../server";
import { createFakeDrive } from "./fake-drive";

const SLIDE = "<!doctype html><html><body style=\"width:1280px;height:720px\"><h1>Q3 Infrastructure Spend</h1></body></html>";

function environment(): Readonly<{ env: ProposalEnvironment; fake: ReturnType<typeof createFakeDrive>; statted: string[] }> {
  const fake = createFakeDrive();
  const statted: string[] = [];
  return {
    fake,
    statted,
    env: {
      drive: fake.channel,
      now: () => new Date("2026-10-12T12:00:00.000Z"),
      randomSuffix: () => "aaa111",
      sleep: () => Promise.resolve(),
      statFile: (path) => {
        statted.push(path);
        return { bytes: 2048 };
      },
      warn: () => undefined,
    },
  };
}

describe("inline slide HTML", () => {
  test("is staged as NN.html with exactly the markup sent, and no file is looked up", async () => {
    const { env, fake, statted } = environment();
    const outcome = await createProposal({
      env,
      slides: [{ html: SLIDE, label: "dark" }, { html: SLIDE.replace("Q3", "Third quarter"), label: "light" }],
      presentationId: "deck-1",
    });
    assert.equal(outcome.kind, "ok");
    assert.equal(fake.find({ name: "01.html" })?.text, SLIDE);
    assert.match(fake.find({ name: "02.html" })?.text ?? "", /Third quarter/);
    assert.equal(fake.find({ name: "01.html" })?.mimeType, "text/html");
    assert.deepEqual(statted, [], "inline HTML never touches the filesystem");
  });

  test("empty or oversized markup is refused before anything reaches Drive", async () => {
    const rows: readonly { html: string; reason: RegExp }[] = [
      { html: "   ", reason: /empty/ },
      { html: "x".repeat(MAX_INLINE_HTML_BYTES + 1), reason: /too large/ },
    ];
    for (const row of rows) {
      const { env, fake } = environment();
      const outcome = await createProposal({ env, slides: [{ html: row.html, label: null }], presentationId: null });
      assert.equal(outcome.kind, "invalid-input");
      assert.match(outcome.kind === "invalid-input" ? outcome.reason : "", row.reason);
      assert.equal(fake.calls().length, 0, "nothing was written");
    }
  });

  test("a revision can be sent as markup too, and replaces the same file", async () => {
    const { env, fake } = environment();
    const staged = await createProposal({ env, slides: [{ html: SLIDE, label: null }], presentationId: null });
    assert.equal(staged.kind, "ok");
    const before = fake.find({ name: "01.html" });
    const revised = await reviseSlide({
      env,
      proposalId: staged.kind === "ok" ? staged.proposalId : "",
      slideIndex: 1,
      html: SLIDE.replace("Spend", "Costs"),
      label: null,
      answeredCommentIds: [],
    });
    assert.equal(revised.kind, "ok");
    const after = fake.find({ name: "01.html" });
    assert.equal(after?.id, before?.id, "same Drive file, so comment threads stay attached");
    assert.match(after?.text ?? "", /Costs/);
  });
});

describe("slideSourcesFrom (the propose_slides argument boundary)", () => {
  test("each slide must carry exactly one of path or html", () => {
    for (const remote of [false, true]) {
      const both = slideSourcesFrom({ slides: [{ path: "/a.html", html: SLIDE }], remote });
      assert.equal(both.kind, "error");
      const neither = slideSourcesFrom({ slides: [{ label: "x" }], remote });
      assert.equal(neither.kind, "error");
    }
  });

  test("the local connector accepts paths and markup", () => {
    const sources = slideSourcesFrom({ slides: [{ path: "/a.html", label: "a" }, { html: SLIDE }], remote: false });
    assert.equal(sources.kind, "ok");
    assert.deepEqual(sources.kind === "ok" ? sources.sources : [], [
      { path: "/a.html", label: "a" },
      { html: SLIDE, label: null },
    ]);
  });

  test("the remote connector refuses paths, naming html as the fix", () => {
    const refused = slideSourcesFrom({ slides: [{ path: "/data/oauth-store.json" }], remote: true });
    assert.equal(refused.kind, "error");
    assert.match(refused.kind === "error" ? refused.message : "", /html/);
    assert.doesNotMatch(refused.kind === "error" ? refused.message : "", /oauth-store/, "does not echo server paths back");
    const accepted = slideSourcesFrom({ slides: [{ html: SLIDE, label: "a" }], remote: true });
    assert.equal(accepted.kind, "ok");
  });
});

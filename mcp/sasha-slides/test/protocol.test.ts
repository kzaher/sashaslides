/**
 * The staging protocol of PROTOCOL.md, asserted end to end against the in-memory Drive.
 * No credentials, no network, no real files: every effect is injected.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/protocol.test.ts
 *
 * Ordered to follow proposal.ts and server.ts so the two can be read side by side.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  awaitPick,
  clearSlides,
  createProposal,
  downloadSlideImages,
  findCandidate,
  readProposalLog,
  readProposalState,
  reviseSlide,
  slideFileName,
  type ProposalEnvironment,
} from "../proposal";
import {
  awaitPickPayload,
  proposalStatePayload,
  proposeSlidesPayload,
  slideImagesPayload,
  toCallToolResult,
} from "../server";
import { createFakeDrive, type FakeDrive } from "./fake-drive";

describe("createProposal", () => {
  test("writes READY last: after every slide HTML and the manifest", async () => {
    const harness = createHarness();
    const outcome = await createProposal({
      env: harness.env,
      slides: [pathFor(1), pathFor(2), pathFor(3)],
      presentationId: "deck-1",
    });
    assert.equal(outcome.kind, "ok");

    // The whole transcript, not just the final set of files: ordering IS the invariant.
    assert.deepEqual(
      harness.fake.calls().map((call) => `${call.op}:${call.name}`),
      [
        "listFiles:name=Sasha Slides Inbox sashaSlides=inbox trashed=false",
        "createFolder:Sasha Slides Inbox",
        "createFolder:p_1759492800000_aaa111",
        "createFile:01.html",
        "createFile:02.html",
        "createFile:03.html",
        // The session log before the manifest: a reader woken by `revision` must already be
        // able to see the line that explains where these candidates came from.
        "listFiles:name=events parent=fake-2 trashed=false",
        "createFolder:events",
        "createFile:1759492800000-aaa111-slides-staged.json",
        "createFile:manifest.json",
        "createFile:READY",
      ],
    );

    const writes = harness.fake.calls().filter((call) => call.op === "createFile");
    const readyAt = writes.findIndex((call) => call.name === "READY");
    assert.equal(readyAt, writes.length - 1, "READY is the final write");
    for (const earlier of writes.slice(0, readyAt)) {
      assert.notEqual(earlier.name, "READY");
    }
  });

  test("enumerates 1-based with zero-padded NN.html names", async () => {
    const harness = createHarness();
    const outcome = await createProposal({
      env: harness.env,
      slides: [pathFor(1), pathFor(2), pathFor(3)],
      presentationId: null,
    });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(
      outcome.slides.map((slide) => ({ index: slide.index, name: slide.name })),
      [
        { index: 1, name: "01.html" },
        { index: 2, name: "02.html" },
        { index: 3, name: "03.html" },
      ],
    );
    // Two digits up to 99; wider only if a proposal ever needs it.
    assert.equal(slideFileName({ index: 9, count: 9 }), "09.html");
    assert.equal(slideFileName({ index: 7, count: 100 }), "007.html");
  });

  test("tags every file with the appProperties PROTOCOL.md specifies", async () => {
    const harness = createHarness();
    const outcome = await createProposal({
      env: harness.env,
      slides: [pathFor(1), pathFor(2)],
      presentationId: null,
    });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const proposalId = outcome.proposalId;

    assert.deepEqual(propertiesOf({ fake: harness.fake, name: "Sasha Slides Inbox" }), {
      sashaSlides: "inbox",
    });
    assert.deepEqual(propertiesOf({ fake: harness.fake, name: proposalId }), {
      sashaSlides: "proposal",
      proposalId,
    });
    assert.deepEqual(propertiesOf({ fake: harness.fake, name: "01.html" }), {
      sashaSlides: "slide",
      proposalId,
      index: "1",
    });
    assert.deepEqual(propertiesOf({ fake: harness.fake, name: "02.html" }), {
      sashaSlides: "slide",
      proposalId,
      index: "2",
    });
    assert.deepEqual(propertiesOf({ fake: harness.fake, name: "manifest.json" }), {
      sashaSlides: "manifest",
      proposalId,
    });
    assert.deepEqual(propertiesOf({ fake: harness.fake, name: "READY" }), {
      sashaSlides: "ready",
      proposalId,
    });
  });

  test("never reads the slide HTML: paths are streamed, ids come back", async () => {
    const harness = createHarness();
    const outcome = await createProposal({
      env: harness.env,
      slides: [{ path: "/slides/first.html", label: "option A" }, { path: "/slides/second.html", label: null }],
      presentationId: null,
    });
    assert.equal(outcome.kind, "ok");

    const html = harness.fake.files().filter((file) => file.name.endsWith(".html"));
    assert.deepEqual(
      html.map((file) => file.sourcePath),
      ["/slides/first.html", "/slides/second.html"],
      "HTML reached Drive as a path, streamed by the channel",
    );
    for (const file of html) assert.equal(file.text, null, "no HTML body ever entered the process");
    assert.equal(
      harness.fake.calls().some((call) => call.op === "readTextFile"),
      false,
      "staging reads nothing back",
    );
  });

  test("writes a manifest and a READY sentinel in the documented shape", async () => {
    const harness = createHarness();
    const outcome = await createProposal({
      env: harness.env,
      slides: [{ path: "/slides/first.html", label: "Timeline, 3 phases" }],
      presentationId: "1AbC",
    });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;

    assert.deepEqual(jsonBodyOf({ fake: harness.fake, name: "manifest.json" }), {
      protocolVersion: 1,
      proposalId: outcome.proposalId,
      createdAt: "2025-10-03T12:00:00.000Z",
      presentationId: "1AbC",
      count: 1,
      // The poll signal. A first staging is revision 1, and it only ever moves forward.
      revision: 1,
      slides: [{ index: 1, fileId: "fake-3", name: "01.html", label: "Timeline, 3 phases" }],
    });
    assert.deepEqual(jsonBodyOf({ fake: harness.fake, name: "READY" }), {
      protocolVersion: 1,
      proposalId: outcome.proposalId,
      count: 1,
      manifestFileId: outcome.manifestFileId,
    });
  });

  test("reuses an existing inbox folder instead of creating a second one", async () => {
    const harness = createHarness();
    harness.fake.putForeignFile({
      name: "Sasha Slides Inbox",
      parentId: "root",
      mimeType: "application/vnd.google-apps.folder",
      text: "",
      appProperties: { sashaSlides: "inbox" },
    });
    await createProposal({ env: harness.env, slides: [pathFor(1)], presentationId: null });
    assert.equal(
      harness.fake.files().filter((file) => file.name === "Sasha Slides Inbox").length,
      1,
    );
  });

  test("rejects an empty list or a path that is not a readable file", async () => {
    const harness = createHarness();
    assert.deepEqual(await createProposal({ env: harness.env, slides: [], presentationId: null }), {
      kind: "invalid-input",
      reason: "slides is empty",
    });

    const strict: ProposalEnvironment = { ...harness.env, statFile: (path) => (path === "/ok.html" ? { bytes: 10 } : null) };
    const outcome = await createProposal({
      env: strict,
      slides: [{ path: "/ok.html", label: null }, { path: "/gone.html", label: null }],
      presentationId: null,
    });
    assert.deepEqual(outcome, { kind: "invalid-input", reason: "not a readable file: /gone.html" });
    assert.deepEqual(harness.fake.calls(), [], "nothing is staged when input is rejected");
    assert.deepEqual(proposeSlidesPayload(outcome), {
      kind: "error",
      message: "propose_slides: not a readable file: /gone.html",
    });
  });
});

describe("awaitPick", () => {
  test("parses a well-formed PICK, anomalies and inserted ids included", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 3 });
    writePick({
      harness,
      staged,
      body: {
        protocolVersion: 1,
        proposalId: staged.proposalId,
        picked: 2,
        decidedAt: "2026-10-03T12:00:21.000Z",
        insertedObjectIds: ["g123abc"],
        anomalies: [{ index: 2, note: "chart gridlines lost", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }],
      },
    });

    const outcome = await awaitPick({ env: harness.env, proposalId: staged.proposalId, timeoutSeconds: 300 });
    assert.equal(outcome.kind, "decided");
    if (outcome.kind !== "decided") return;
    assert.equal(outcome.polls, 1, "an already-written PICK is seen on the first poll");
    assert.deepEqual(outcome.pick, {
      protocolVersion: 1,
      proposalId: staged.proposalId,
      picked: 2,
      decidedAt: "2026-10-03T12:00:21.000Z",
      insertedObjectIds: ["g123abc"],
      anomalies: [{ index: 2, note: "chart gridlines lost", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }],
    });

    assert.deepEqual(awaitPickPayload(outcome), {
      kind: "payload",
      payload: {
        status: "picked",
        picked: 2,
        anomalies: [{ index: 2, note: "chart gridlines lost", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }],
        insertedObjectIds: ["g123abc"],
        decidedAt: "2026-10-03T12:00:21.000Z",
        note: null,
      },
    });
  });

  test("a dismissed picker is picked: null, not a timeout", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    writePick({
      harness,
      staged,
      body: { protocolVersion: 1, proposalId: staged.proposalId, picked: null, decidedAt: "2026-10-03T12:00:30.000Z" },
    });
    const payload = awaitPickPayload(
      await awaitPick({ env: harness.env, proposalId: staged.proposalId, timeoutSeconds: 60 }),
    );
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.status, "dismissed");
    assert.equal(payload.payload.picked, null);
    assert.deepEqual(payload.payload.anomalies, []);
    assert.deepEqual(payload.payload.insertedObjectIds, []);
  });

  test("times out as a value with picked: null, backing off instead of hammering Drive", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    const before = harness.elapsedMs();
    const outcome = await awaitPick({ env: harness.env, proposalId: staged.proposalId, timeoutSeconds: 60 });

    assert.equal(outcome.kind, "timeout");
    if (outcome.kind !== "timeout") return;
    // 60s of waiting: a 1s-interval poller would issue 60 queries.
    assert.ok(outcome.polls <= 20, `expected backoff to keep polls low, got ${String(outcome.polls)}`);
    assert.equal(outcome.waitedSeconds, 60, "the whole budget is spent polling, not overshot");
    assert.ok(outcome.polls >= 2, "polls at least twice before giving up");
    assert.ok(harness.elapsedMs() - before <= 60_000, "never waits past the deadline");

    const payload = awaitPickPayload(outcome);
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.status, "timeout");
    assert.equal(payload.payload.picked, null);
    assert.equal(payload.payload.decidedAt, null);
    assert.equal(toCallToolResult(payload).isError, undefined, "a timeout is a result, not a tool error");
  });

  test("ignores an unknown protocolVersion with a warning instead of guessing", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    writePick({
      harness,
      staged,
      body: {
        protocolVersion: 99,
        proposalId: staged.proposalId,
        picked: 2,
        decidedAt: "2026-10-03T12:00:21.000Z",
      },
    });

    const outcome = await awaitPick({ env: harness.env, proposalId: staged.proposalId, timeoutSeconds: 60 });
    assert.deepEqual(outcome, { kind: "unsupported-version", version: 99 });
    assert.deepEqual(harness.warnings(), [
      "ignoring PICK with unsupported protocolVersion 99 (this server speaks 1)",
    ]);

    const payload = awaitPickPayload(outcome);
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.status, "unsupported-protocol-version");
    assert.equal(payload.payload.picked, null, "the picked value is NOT read from an unknown version");
  });

  test("reports an unparseable PICK and an unknown proposal distinctly", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    writePick({ harness, staged, rawText: "{not json" });
    const unreadable = await awaitPick({ env: harness.env, proposalId: staged.proposalId, timeoutSeconds: 10 });
    assert.equal(unreadable.kind, "unreadable");
    assert.equal(awaitPickPayload(unreadable).kind, "error");

    const unknown = await awaitPick({ env: harness.env, proposalId: "p_nope_000000", timeoutSeconds: 10 });
    assert.deepEqual(unknown, { kind: "unknown-proposal" });
    assert.equal(awaitPickPayload(unknown).kind, "error");
  });
});

describe("readProposalState", () => {
  test("reports READY, PICK, the count and a content-free manifest summary", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 3 });

    const beforePick = proposalStatePayload(
      await readProposalState({ env: harness.env, proposalId: staged.proposalId }),
    );
    assert.equal(beforePick.kind, "payload");
    if (beforePick.kind !== "payload") return;
    assert.equal(beforePick.payload.exists, true);
    assert.equal(beforePick.payload.ready, true);
    assert.equal(beforePick.payload.pick, false);
    assert.equal(beforePick.payload.count, 3);
    assert.equal(beforePick.payload.slideFileCount, 3);
    assert.equal(beforePick.payload.manifestStatus, "ok");
    assert.deepEqual(
      beforePick.payload.manifest?.slides.map((slide) => slide.name),
      ["01.html", "02.html", "03.html"],
    );

    writePick({
      harness,
      staged,
      body: { protocolVersion: 1, proposalId: staged.proposalId, picked: 1, decidedAt: "2026-10-03T12:01:00.000Z" },
    });
    const afterPick = proposalStatePayload(
      await readProposalState({ env: harness.env, proposalId: staged.proposalId }),
    );
    assert.equal(afterPick.kind === "payload" && afterPick.payload.pick, true);
  });

  test("an unknown proposal is reported, not thrown", async () => {
    const harness = createHarness();
    const payload = proposalStatePayload(
      await readProposalState({ env: harness.env, proposalId: "p_nope_000000" }),
    );
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.exists, false);
    assert.equal(payload.payload.ready, false);
    assert.equal(payload.payload.count, null);
    assert.equal(payload.payload.manifestStatus, "absent");
  });

  test("a manifest with an unknown protocolVersion is ignored with a warning", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 1 });
    harness.fake.putForeignFile({
      name: "manifest.json",
      parentId: staged.folderId,
      mimeType: "application/json",
      text: JSON.stringify({ protocolVersion: 7, proposalId: staged.proposalId, count: 99 }),
      appProperties: { sashaSlides: "manifest", proposalId: `${staged.proposalId}-v7` },
    });
    const state = await readProposalState({ env: harness.env, proposalId: `${staged.proposalId}-v7` });
    assert.deepEqual(state.manifest, { kind: "unsupported-version", version: 7 });
    assert.deepEqual(harness.warnings(), [
      "ignoring manifest.json with unsupported protocolVersion 7 (this server speaks 1)",
    ]);
    const payload = proposalStatePayload(state);
    assert.equal(payload.kind === "payload" && payload.payload.manifestStatus, "unsupported-protocol-version");
    assert.equal(payload.kind === "payload" && payload.payload.count, null, "99 is not believed");
  });
});

describe("downloadSlideImages", () => {
  test("says previews are unavailable rather than faking them", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    const outcome = await downloadSlideImages({
      env: harness.env,
      proposalId: staged.proposalId,
      indices: null,
      outDir: "/out",
    });
    assert.equal(outcome.kind, "unavailable");
    const payload = slideImagesPayload(outcome);
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.status, "unavailable");
    assert.deepEqual(payload.payload.files, []);
    assert.match(payload.payload.note ?? "", /client-side in the Google Slides extension/);
    assert.deepEqual(harness.fake.downloads(), [], "nothing was downloaded");
  });

  test("streams published previews to outDir and returns paths, never image data", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    for (const index of [1, 2]) {
      harness.fake.putForeignFile({
        name: `0${String(index)}.png`,
        parentId: staged.folderId,
        mimeType: "image/png",
        text: "",
        appProperties: { sashaSlides: "slide", proposalId: staged.proposalId, index: String(index) },
      });
    }

    const all = await downloadSlideImages({
      env: harness.env,
      proposalId: staged.proposalId,
      indices: null,
      outDir: "/out/",
    });
    assert.deepEqual(all, {
      kind: "ok",
      files: [
        { index: 1, path: "/out/01.png" },
        { index: 2, path: "/out/02.png" },
      ],
    });
    assert.deepEqual(
      harness.fake.downloads().map((download) => download.destinationPath),
      ["/out/01.png", "/out/02.png"],
    );

    const second = await downloadSlideImages({
      env: harness.env,
      proposalId: staged.proposalId,
      indices: [2],
      outDir: "/out",
    });
    assert.deepEqual(second, { kind: "ok", files: [{ index: 2, path: "/out/02.png" }] });
  });
});

describe("createProposal's Drive failures", () => {
  test("a Drive that cannot be reached is a VALUE, distinct from bad input", async () => {
    const harness = createHarness();
    const outcome = await createProposal({
      env: {
        ...harness.env,
        drive: { ...harness.fake.channel, createFolder: () => Promise.reject(new Error("503 from Drive")) },
      },
      slides: [pathFor(1)],
      presentationId: null,
    });
    assert.equal(outcome.kind, "drive-failed");
    assert.equal(proposeSlidesPayload(outcome).kind, "error");
  });

  test("a log that cannot be written stops staging before READY, so nothing can pick it", async () => {
    const harness = createHarness();
    let created = 0;
    const outcome = await createProposal({
      env: {
        ...harness.env,
        drive: {
          ...harness.fake.channel,
          createFile: async (options) => {
            created += 1;
            // Fail on the event file: the slides are up, the manifest and READY are not.
            if (options.name.endsWith("-slides-staged.json")) throw new Error("503 from Drive");
            return await harness.fake.channel.createFile(options);
          },
        },
      },
      slides: [pathFor(1)],
      presentationId: null,
    });
    assert.equal(outcome.kind, "drive-failed");
    assert.ok(created > 0);
    assert.equal(harness.fake.find({ name: "READY" }), null, "READY was never written");
    assert.equal(harness.fake.find({ name: "manifest.json" }), null);
  });
});

describe("reviseSlide", () => {
  test("replaces the HTML in place, keeping the file id the comment threads hang off", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    const before = harness.fake.find({ name: "02.html" });

    const outcome = await reviseSlide({
      env: harness.env,
      proposalId: staged.proposalId,
      slideIndex: 2,
      htmlPath: "/slides/candidate-2-v2.html",
      label: "option 2, bigger labels",
      answeredCommentIds: ["c1", "c2"],
    });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.fileId, before?.id, "the Drive file id is unchanged");
    assert.equal(outcome.revision, 2);

    const after = harness.fake.find({ name: "02.html" });
    assert.equal(after?.id, before?.id);
    // The new body is the new PATH, streamed: nothing read the HTML.
    assert.equal(after?.sourcePath, "/slides/candidate-2-v2.html");
    assert.equal(after?.text, null);
  });

  test("writes the HTML, then the event, then the manifest - revision LAST", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 1 });
    const beforeCount = harness.fake.calls().length;

    await reviseSlide({
      env: harness.env,
      proposalId: staged.proposalId,
      slideIndex: 1,
      htmlPath: "/slides/candidate-1-v2.html",
      label: null,
      answeredCommentIds: [],
    });

    // Ordering IS the invariant: `revision` is the poll signal, so a reader woken by it must
    // find a proposal that is already complete.
    const writes = harness.fake
      .calls()
      .slice(beforeCount)
      .filter((call) => call.op === "createFile" || call.op === "updateFileContent")
      .map((call) => `${call.op}:${call.name}`);
    assert.deepEqual(writes, [
      "updateFileContent:01.html",
      `createFile:${String(STARTED_AT_MS)}-aaa111-slide-revised.json`,
      "updateFileContent:manifest.json",
    ]);
  });

  test("the slide-revised event names the comment ids it answers", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 1 });
    await reviseSlide({
      env: harness.env,
      proposalId: staged.proposalId,
      slideIndex: 1,
      htmlPath: "/slides/candidate-1-v2.html",
      label: "tighter",
      answeredCommentIds: ["c-aaa", "c-bbb"],
    });
    const log = await readProposalLog({ env: harness.env, proposalId: staged.proposalId });
    assert.equal(log.kind, "ok");
    if (log.kind !== "ok" || log.log.kind !== "ok") return;
    const revised = log.log.records.map((entry) => entry.event).find((event) => event.kind === "slide-revised");
    assert.equal(revised?.kind, "slide-revised");
    if (revised?.kind !== "slide-revised") return;
    assert.deepEqual(revised.answeredCommentIds, ["c-aaa", "c-bbb"]);
    assert.equal(revised.revision, 2);
    assert.equal(log.revision, 2, "the manifest the reader polls carries the same number");
  });

  test("the manifest keeps the revised slide's new label and the same file id", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    await reviseSlide({
      env: harness.env,
      proposalId: staged.proposalId,
      slideIndex: 2,
      htmlPath: "/slides/candidate-2-v2.html",
      label: "option 2, bigger labels",
      answeredCommentIds: [],
    });
    const manifest = jsonBodyOf({ fake: harness.fake, name: "manifest.json" });
    assert.deepEqual(asRecord(manifest)?.["revision"], 2);
    const slides = asRecord(manifest)?.["slides"];
    assert.deepEqual(Array.isArray(slides) ? asRecord(slides[1])?.["label"] : null, "option 2, bigger labels");
    assert.deepEqual(
      Array.isArray(slides) ? asRecord(slides[1])?.["fileId"] : null,
      harness.fake.find({ name: "02.html" })?.id,
    );
  });

  test("a path that is not a readable file, and an unknown slide, are values", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    const missing = await reviseSlide({
      env: { ...harness.env, statFile: () => null },
      proposalId: staged.proposalId,
      slideIndex: 1,
      htmlPath: "/slides/nope.html",
      label: null,
      answeredCommentIds: [],
    });
    assert.equal(missing.kind, "invalid-input");
    const wrongSlide = await reviseSlide({
      env: harness.env,
      proposalId: staged.proposalId,
      slideIndex: 9,
      htmlPath: "/slides/candidate-1.html",
      label: null,
      answeredCommentIds: [],
    });
    assert.deepEqual(wrongSlide, { kind: "unknown-slide", available: [1, 2] });
    const unknown = await reviseSlide({
      env: harness.env,
      proposalId: "p_nope_aaaaaa",
      slideIndex: 1,
      htmlPath: "/slides/candidate-1.html",
      label: null,
      answeredCommentIds: [],
    });
    assert.deepEqual(unknown, { kind: "unknown-proposal" });
  });

  test("a Drive that cannot be reached is a value naming the stage, never a hang", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 1 });
    const outcome = await reviseSlide({
      env: {
        ...harness.env,
        drive: {
          ...harness.fake.channel,
          updateFileContent: () => Promise.reject(new Error("503 from Drive")),
        },
      },
      proposalId: staged.proposalId,
      slideIndex: 1,
      htmlPath: "/slides/candidate-1-v2.html",
      label: null,
      answeredCommentIds: [],
    });
    assert.deepEqual(outcome, { kind: "drive-failed", stage: "upload", reason: "503 from Drive" });
    // Nothing moved, so a retry is safe and no reader was told to re-read.
    assert.deepEqual(asRecord(jsonBodyOf({ fake: harness.fake, name: "manifest.json" }))?.["revision"], 1);
  });

  test("an unreadable manifest declines the revision rather than inventing a revision number", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 1 });
    const manifest = harness.fake.find({ name: "manifest.json" });
    assert.ok(manifest !== null);
    await harness.fake.channel.updateFileContent({
      fileId: manifest.id,
      mimeType: "application/json",
      media: { kind: "text", text: "{ not json" },
    });
    const outcome = await reviseSlide({
      env: harness.env,
      proposalId: staged.proposalId,
      slideIndex: 1,
      htmlPath: "/slides/candidate-1-v2.html",
      label: null,
      answeredCommentIds: [],
    });
    assert.equal(outcome.kind, "manifest-unusable");
    assert.equal(harness.fake.find({ name: "01.html" })?.sourcePath, "/slides/candidate-1.html");
  });
});

describe("clearSlides", () => {
  test("deletes the uninserted candidates, logs it, and bumps the revision last", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 3 });
    const beforeCount = harness.fake.calls().length;

    const outcome = await clearSlides({
      env: harness.env,
      proposalId: staged.proposalId,
      reason: "starting over on the layout",
    });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(outcome.cleared.map((candidate) => candidate.index), [1, 2, 3]);
    assert.deepEqual(outcome.kept, []);
    assert.equal(outcome.countBefore, 3);
    assert.equal(outcome.countAfter, 0);
    assert.equal(outcome.revision, 2);

    const writes = harness.fake
      .calls()
      .slice(beforeCount)
      .filter((call) => call.op === "deleteFile" || call.op === "createFile" || call.op === "updateFileContent")
      .map((call) => `${call.op}:${call.name}`);
    assert.deepEqual(writes, [
      "deleteFile:01.html",
      "deleteFile:02.html",
      "deleteFile:03.html",
      `createFile:${String(STARTED_AT_MS)}-aaa111-slides-cleared.json`,
      "updateFileContent:manifest.json",
    ]);
    assert.equal(harness.fake.find({ name: "01.html" }), null);
    // The log itself is never deleted: the history has to outlive the candidates.
    assert.ok(harness.fake.files().some((file) => file.name.endsWith("-slides-staged.json")));
  });

  test("never silent: slides-cleared is in the log even when nothing was uninserted", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 1 });
    insertSlide({ harness, staged, slideIndex: 1 });

    const outcome = await clearSlides({ env: harness.env, proposalId: staged.proposalId, reason: null });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(outcome.cleared, []);
    assert.deepEqual(outcome.kept.map((candidate) => candidate.index), [1]);
    const log = await readProposalLog({ env: harness.env, proposalId: staged.proposalId });
    assert.equal(log.kind === "ok" && log.log.kind === "ok", true);
    if (log.kind !== "ok" || log.log.kind !== "ok") return;
    const cleared = log.log.records.map((entry) => entry.event).find((event) => event.kind === "slides-cleared");
    assert.equal(cleared?.kind, "slides-cleared");
    if (cleared?.kind !== "slides-cleared") return;
    assert.deepEqual(cleared.clearedSlideIndices, []);
    assert.deepEqual(cleared.keptSlideIndices, [1]);
  });

  test("a candidate the log says was inserted is KEPT, and the manifest drops only the rest", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 3 });
    insertSlide({ harness, staged, slideIndex: 2 });

    const outcome = await clearSlides({ env: harness.env, proposalId: staged.proposalId, reason: null });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(outcome.cleared.map((candidate) => candidate.index), [1, 3]);
    assert.deepEqual(outcome.kept.map((candidate) => candidate.index), [2]);
    assert.equal(harness.fake.find({ name: "02.html" })?.name, "02.html");

    const manifest = asRecord(jsonBodyOf({ fake: harness.fake, name: "manifest.json" }));
    assert.equal(manifest?.["count"], 1);
    const slides = manifest?.["slides"];
    assert.deepEqual(Array.isArray(slides) ? slides.map((slide) => asRecord(slide)?.["index"]) : null, [2]);
  });

  test("a PICK naming inserted object ids also keeps its candidate", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    writePick({
      harness,
      staged,
      body: {
        protocolVersion: 1,
        proposalId: staged.proposalId,
        picked: 1,
        decidedAt: "2025-10-03T12:00:21.000Z",
        insertedObjectIds: ["g123abc"],
        anomalies: [],
      },
    });
    const outcome = await clearSlides({ env: harness.env, proposalId: staged.proposalId, reason: null });
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(outcome.kept.map((candidate) => candidate.index), [1]);
    assert.deepEqual(outcome.cleared.map((candidate) => candidate.index), [2]);
  });

  test("a failed delete stops at the first one and reports it, rather than carrying on", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    const outcome = await clearSlides({
      env: {
        ...harness.env,
        drive: { ...harness.fake.channel, deleteFile: () => Promise.reject(new Error("403 from Drive")) },
      },
      proposalId: staged.proposalId,
      reason: null,
    });
    assert.equal(outcome.kind, "drive-failed");
    assert.equal(outcome.kind === "drive-failed" ? outcome.stage : null, "delete");
    assert.equal(harness.fake.find({ name: "01.html" })?.name, "01.html", "nothing was deleted");
    assert.deepEqual(asRecord(jsonBodyOf({ fake: harness.fake, name: "manifest.json" }))?.["revision"], 1);
  });
});

describe("readProposalLog and findCandidate", () => {
  test("replays the server's and the add-on's events together, in one order", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 2 });
    // The add-on's half: it appends its own file, which the server never reads to write.
    const eventsFolder = harness.fake.find({ name: "events" });
    assert.ok(eventsFolder !== null);
    harness.fake.putForeignFile({
      name: `${String(STARTED_AT_MS + 5)}-bbb222-comment-opened.json`,
      parentId: eventsFolder.id,
      mimeType: "application/json",
      text: JSON.stringify({
        protocolVersion: 1,
        at: "2025-10-03T12:00:05.000Z",
        kind: "comment-opened",
        slideIndex: 2,
        commentId: "c-from-the-addon",
        text: "the chart lost its gridlines",
        region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
        noteId: "user_k2h9",
      }),
      appProperties: {},
    });

    const log = await readProposalLog({ env: harness.env, proposalId: staged.proposalId });
    assert.equal(log.kind, "ok");
    if (log.kind !== "ok" || log.log.kind !== "ok") return;
    assert.deepEqual(
      log.log.records.map((record) => record.event.kind),
      ["slides-staged", "comment-opened"],
    );
    const opened = log.log.records[1]?.event;
    assert.deepEqual(
      opened?.kind === "comment-opened" ? opened.region : null,
      { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
    );
  });

  test("an unknown proposal is a value for the log and for an address lookup", async () => {
    const harness = createHarness();
    assert.deepEqual(await readProposalLog({ env: harness.env, proposalId: "p_nope_aaaaaa" }), {
      kind: "unknown-proposal",
    });
    assert.deepEqual(
      await findCandidate({ env: harness.env, proposalId: "p_nope_aaaaaa", slideIndex: 1 }),
      { kind: "unknown-proposal" },
    );
  });

  test("findCandidate turns (proposalId, slideIndex) into the NN.html file id", async () => {
    const harness = createHarness();
    const staged = await stage({ harness, count: 3 });
    const found = await findCandidate({ env: harness.env, proposalId: staged.proposalId, slideIndex: 2 });
    assert.equal(found.kind, "ok");
    if (found.kind !== "ok") return;
    assert.equal(found.candidate.name, "02.html");
    assert.equal(found.candidate.fileId, harness.fake.find({ name: "02.html" })?.id);
    assert.equal(found.folderId, staged.folderId);
  });
});

/** The frozen clock every harness runs on; event file names are stamped with it. */
const STARTED_AT_MS = Date.parse("2025-10-03T12:00:00.000Z");

type Harness = Readonly<{
  fake: FakeDrive;
  env: ProposalEnvironment;
  warnings: () => readonly string[];
  elapsedMs: () => number;
}>;

/** A fake Drive, a clock only `sleep` advances, and a captured warning sink. */
function createHarness(): Harness {
  const fake = createFakeDrive();
  const warnings: string[] = [];
  let nowMs = STARTED_AT_MS;
  return {
    fake,
    env: {
      drive: fake.channel,
      now: () => new Date(nowMs),
      randomSuffix: () => "aaa111",
      sleep: ({ milliseconds }) => {
        nowMs += milliseconds;
        return Promise.resolve();
      },
      statFile: () => ({ bytes: 2048 }),
      warn: (message) => void warnings.push(message),
    },
    warnings: () => [...warnings],
    elapsedMs: () => nowMs - STARTED_AT_MS,
  };
}

type Staged = Readonly<{ proposalId: string; folderId: string }>;

async function stage(options: Readonly<{ harness: Harness; count: number }>): Promise<Staged> {
  const slides = Array.from({ length: options.count }, (_, position) => pathFor(position + 1));
  const outcome = await createProposal({ env: options.harness.env, slides, presentationId: null });
  if (outcome.kind !== "ok") throw new Error(`staging failed: ${outcome.reason}`);
  return { proposalId: outcome.proposalId, folderId: outcome.folderId };
}

/** The extension's half of the protocol: it writes PICK, and only PICK. */
function writePick(
  options: Readonly<{
    harness: Harness;
    staged: Staged;
    body?: Readonly<Record<string, unknown>>;
    rawText?: string;
  }>,
): void {
  options.harness.fake.putForeignFile({
    name: "PICK",
    parentId: options.staged.folderId,
    mimeType: "application/json",
    text: options.rawText ?? JSON.stringify(options.body ?? {}),
    appProperties: { sashaSlides: "pick", proposalId: options.staged.proposalId },
  });
}

/** The add-on's half of the new protocol: it appends `slide-inserted` after inserting. */
function insertSlide(
  options: Readonly<{ harness: Harness; staged: Staged; slideIndex: number }>,
): void {
  const eventsFolder = options.harness.fake.find({ name: "events" });
  if (eventsFolder === null) throw new Error("the proposal has no events folder");
  options.harness.fake.putForeignFile({
    name: `${String(STARTED_AT_MS + 2)}-ccc333-slide-inserted.json`,
    parentId: eventsFolder.id,
    mimeType: "application/json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2025-10-03T12:00:02.000Z",
      kind: "slide-inserted",
      slideIndex: options.slideIndex,
      insertedObjectIds: ["g123abc"],
    }),
    appProperties: {},
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function pathFor(index: number): Readonly<{ path: string; label: string | null }> {
  return { path: `/slides/candidate-${String(index)}.html`, label: `option ${String(index)}` };
}

function propertiesOf(
  options: Readonly<{ fake: FakeDrive; name: string }>,
): Readonly<Record<string, string>> {
  const file = options.fake.find({ name: options.name });
  if (file === null) throw new Error(`no fake file named ${options.name}`);
  return file.appProperties;
}

function jsonBodyOf(options: Readonly<{ fake: FakeDrive; name: string }>): unknown {
  const file = options.fake.find({ name: options.name });
  if (file === null) throw new Error(`no fake file named ${options.name}`);
  if (file.text === null) throw new Error(`fake file ${options.name} has no text body`);
  return JSON.parse(file.text);
}

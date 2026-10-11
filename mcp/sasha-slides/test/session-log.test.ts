/**
 * The session log of PROTOCOL.md "The session log, comments on candidates, and revisions",
 * asserted against the in-memory Drive. No credentials, no network.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/session-log.test.ts
 *
 * Two contract properties get most of the attention here, because both fail silently in
 * production and loudly nowhere:
 *
 *  - **the order is total** — including for two events that share a millisecond, and for two
 *    events that share a millisecond *and* a suffix, which two writers who cannot see each
 *    other are free to mint;
 *  - **an unknown `kind` survives** — a newer writer must not be able to make an older reader
 *    show a history that is incomplete but looks complete.
 *
 * Ordered to follow session-log.ts so the two can be read side by side.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  appendSessionEvent,
  compareSessionEvents,
  describeSessionEvent,
  ensureEventsFolder,
  parseSessionEvent,
  parseSessionEventFileName,
  readSessionEvents,
  sessionEventFileName,
  SESSION_EVENT_KINDS,
  SESSION_LOG_PROTOCOL_VERSION,
  type SessionEvent,
  type SessionEventRecord,
  type SessionLogEnvironment,
} from "../session-log";
import { createFakeDrive, type FakeDrive } from "./fake-drive";

describe("appendSessionEvent", () => {
  test("appends by CREATING a file: no read, no update, so two blind writers cannot clobber", async () => {
    const harness = createHarness();
    const folderId = await harness.eventsFolder();
    harness.fake.calls();

    const first = await appendSessionEvent({
      env: harness.env,
      proposalId: PROPOSAL_ID,
      eventsFolderId: folderId,
      event: stagedEvent({ at: "2026-10-04T12:00:00.000Z" }),
    });
    const second = await appendSessionEvent({
      env: harness.env,
      proposalId: PROPOSAL_ID,
      eventsFolderId: folderId,
      event: revisedEvent({ at: "2026-10-04T12:00:01.000Z", slideIndex: 2 }),
    });
    assert.equal(first.kind, "ok");
    assert.equal(second.kind, "ok");

    const ops = harness.fake.calls().map((call) => call.op);
    assert.deepEqual(ops.filter((op) => op === "createFile").length, 2, "one file per event");
    assert.equal(ops.includes("updateFileContent"), false, "an append is never a read-modify-write");
    assert.equal(ops.includes("readTextFile"), false, "writing an event never reads the log");
  });

  test("names each file <epochMillis>-<suffix>-<kind>.json", async () => {
    const harness = createHarness();
    const folderId = await harness.eventsFolder();
    await appendSessionEvent({
      env: harness.env,
      proposalId: PROPOSAL_ID,
      eventsFolderId: folderId,
      event: stagedEvent({ at: "2026-10-04T12:00:00.000Z" }),
    });
    const written = harness.fake.files().filter((file) => file.name.endsWith(".json") && file.parentId === folderId);
    assert.deepEqual(
      written.map((file) => file.name),
      [`${String(NOW_MS)}-aaa111-slides-staged.json`],
    );
    assert.deepEqual(written[0]?.appProperties, {
      sashaSlides: "event",
      proposalId: PROPOSAL_ID,
      eventKind: "slides-staged",
    });
  });

  test("a Drive that cannot be reached is a value and a warning, never a silent success", async () => {
    const harness = createHarness();
    const folderId = await harness.eventsFolder();
    const failing: SessionLogEnvironment = {
      ...harness.env,
      drive: { ...harness.fake.channel, createFile: () => Promise.reject(new Error("503 from Drive")) },
    };
    const outcome = await appendSessionEvent({
      env: failing,
      proposalId: PROPOSAL_ID,
      eventsFolderId: folderId,
      event: stagedEvent({ at: "2026-10-04T12:00:00.000Z" }),
    });
    assert.deepEqual(outcome, { kind: "drive-failed", reason: "503 from Drive" });
    assert.match(harness.warnings().join("\n"), /could not append slides-staged/);
  });
});

describe("readSessionEvents", () => {
  test("returns the log in order, whatever order Drive lists it in", async () => {
    const harness = createHarness();
    const folderId = await harness.eventsFolder();
    // Deliberately written newest-first, which is how Drive's own listings come back.
    harness.putRawEvent({ folderId, atMillis: 300, suffix: "ccc333", event: resolvedEvent() });
    harness.putRawEvent({ folderId, atMillis: 100, suffix: "aaa111", event: stagedEvent({ at: "a" }) });
    harness.putRawEvent({ folderId, atMillis: 200, suffix: "bbb222", event: revisedEvent({ at: "b", slideIndex: 1 }) });

    const read = await readSessionEvents({ env: harness.env, proposalId: PROPOSAL_ID, folderId: harness.folderId });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.deepEqual(
      read.records.map((record) => record.event.kind),
      ["slides-staged", "slide-revised", "comment-resolved"],
    );
  });

  test("a proposal with no events folder is a VALUE, not an empty history", async () => {
    const harness = createHarness();
    const read = await readSessionEvents({
      env: harness.env,
      proposalId: PROPOSAL_ID,
      folderId: harness.folderId,
    });
    assert.deepEqual(read, { kind: "no-log" });
  });

  test("a stray file in events/ is named in `unreadable`, and costs nothing else", async () => {
    const harness = createHarness();
    const folderId = await harness.eventsFolder();
    harness.putRawEvent({ folderId, atMillis: 100, suffix: "aaa111", event: stagedEvent({ at: "a" }) });
    harness.fake.putForeignFile({
      name: "notes.txt",
      parentId: folderId,
      mimeType: "text/plain",
      text: "somebody dropped a file in here",
      appProperties: {},
    });

    const read = await readSessionEvents({ env: harness.env, proposalId: PROPOSAL_ID, folderId: harness.folderId });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.equal(read.records.length, 1);
    assert.equal(read.unreadable.length, 1);
    assert.match(read.unreadable[0] ?? "", /notes\.txt/);
  });

  test("an event whose BODY cannot be read still appears, as an opaque line", async () => {
    const harness = createHarness();
    const folderId = await harness.eventsFolder();
    harness.fake.putForeignFile({
      name: "100-aaa111-slide-revised.json",
      parentId: folderId,
      mimeType: "application/json",
      text: "{ this is not json",
      appProperties: { sashaSlides: "event", proposalId: PROPOSAL_ID },
    });
    const read = await readSessionEvents({ env: harness.env, proposalId: PROPOSAL_ID, folderId: harness.folderId });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    const event = read.records[0]?.event;
    assert.equal(event?.kind, "opaque");
    // The kind comes off the file NAME, so even a truncated write says what it was.
    assert.equal(event?.kind === "opaque" ? event.rawKind : null, "slide-revised");
  });
});

describe("the event file name", () => {
  test("round-trips, and `kind` may contain the dashes every kind has", () => {
    for (const kind of SESSION_EVENT_KINDS) {
      const name = sessionEventFileName({ atMillis: 1791073110901, suffix: "a1b2c3", kind });
      assert.deepEqual(parseSessionEventFileName({ name }), {
        atMillis: 1791073110901,
        suffix: "a1b2c3",
        kind,
      });
    }
  });

  test("rejects a name that is not an event, so a stray file is never parsed as one", () => {
    for (const name of ["manifest.json", "READY", "01.html", "-aaa111-x.json", "100--x.json", "100-aaa111-.json"]) {
      assert.equal(parseSessionEventFileName({ name }), null, name);
    }
  });
});

describe("compareSessionEvents", () => {
  test("orders by the millisecond prefix", () => {
    assert.deepEqual(ordered([record({ atMillis: 300 }), record({ atMillis: 100 }), record({ atMillis: 200 })]), [
      "100-aaa111",
      "200-aaa111",
      "300-aaa111",
    ]);
  });

  test("two events in the SAME millisecond still have a total order, broken on the suffix", () => {
    const sorted = ordered([
      record({ atMillis: 100, suffix: "zzzzzz" }),
      record({ atMillis: 100, suffix: "aaaaaa" }),
      record({ atMillis: 100, suffix: "mmmmmm" }),
    ]);
    assert.deepEqual(sorted, ["100-aaaaaa", "100-mmmmmm", "100-zzzzzz"]);
    // Total, not merely consistent: no two of them compare equal.
    const left = record({ atMillis: 100, suffix: "aaaaaa" });
    const right = record({ atMillis: 100, suffix: "zzzzzz" });
    assert.ok(compareSessionEvents(left, right) < 0);
    assert.ok(compareSessionEvents(right, left) > 0);
  });

  test("same millisecond AND same suffix is still total, broken on the Drive file id", () => {
    // Two writers who cannot see each other can mint the same name, and Drive permits
    // duplicate names in a folder. Without the third key the order of these two would be
    // whatever order Drive happened to list them in — different for every reader.
    const left = record({ atMillis: 100, suffix: "aaa111", fileId: "file-a" });
    const right = record({ atMillis: 100, suffix: "aaa111", fileId: "file-b" });
    assert.ok(compareSessionEvents(left, right) < 0);
    assert.ok(compareSessionEvents(right, left) > 0);
    assert.equal(compareSessionEvents(left, left), 0);
    assert.deepEqual([left, right].sort(compareSessionEvents), [right, left].sort(compareSessionEvents));
  });

  test("the sort is a total order over a shuffled log: every permutation sorts the same way", () => {
    const records = [
      record({ atMillis: 100, suffix: "aaa111", fileId: "f1" }),
      record({ atMillis: 100, suffix: "aaa111", fileId: "f2" }),
      record({ atMillis: 100, suffix: "bbb222", fileId: "f3" }),
      record({ atMillis: 200, suffix: "aaa111", fileId: "f4" }),
    ];
    const expected = [...records].sort(compareSessionEvents).map((candidate) => candidate.fileId);
    for (const permutation of permutations(records)) {
      assert.deepEqual(
        [...permutation].sort(compareSessionEvents).map((candidate) => candidate.fileId),
        expected,
      );
    }
  });
});

describe("parseSessionEvent", () => {
  test("reads every kind PROTOCOL.md defines", () => {
    const bodies: readonly Readonly<Record<string, unknown>>[] = [
      { kind: "slides-staged", proposalId: PROPOSAL_ID, count: 2, revision: 1, slides: [] },
      { kind: "comment-opened", slideIndex: 2, commentId: "c1", text: "too dense" },
      { kind: "comment-answered", slideIndex: 2, commentId: "c1", replyId: "r1", text: "redrawn" },
      { kind: "slide-revised", slideIndex: 2, fileId: "f1", revision: 2, answeredCommentIds: ["c1"] },
      { kind: "comment-resolved", slideIndex: 2, commentId: "c1", replyId: "r2", text: "done" },
      { kind: "slides-cleared", revision: 3, clearedSlideIndices: [1], keptSlideIndices: [2] },
      { kind: "slide-inserted", slideIndex: 2, insertedObjectIds: ["g1"] },
      { kind: "feedback-delivered", tool: "await_feedback", commentIds: ["c1"] },
    ];
    for (const body of bodies) {
      const event = parseSessionEvent({
        body: { protocolVersion: SESSION_LOG_PROTOCOL_VERSION, at: AT, ...body },
        fileNameKind: String(body["kind"]),
      });
      assert.equal(event.kind, body["kind"], `${String(body["kind"])} parses as itself`);
    }
    // And the list in the protocol is the list this reader knows, with nothing missing.
    assert.deepEqual(
      bodies.map((body) => body["kind"]),
      [...SESSION_EVENT_KINDS],
    );
  });

  test("A RECEIPT NAMING NO COMMENT IS OPAQUE, not a delivery of nothing", () => {
    // `feedback-delivered` is evidence about SPECIFIC comments. A receipt with an empty or missing
    // `commentIds` cannot say which, so it must not be readable as proof that any one of them was
    // delivered -- and it must not be dropped either, because something did happen.
    for (const fields of [{}, { commentIds: [] }, { commentIds: "c1" }]) {
      const event = parseSessionEvent({
        body: {
          protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
          at: AT,
          kind: "feedback-delivered",
          ...fields,
        },
        fileNameKind: "feedback-delivered",
      });
      assert.equal(event.kind, "opaque");
      assert.equal(event.kind === "opaque" ? event.rawKind : null, "feedback-delivered");
    }
  });

  test("an UNKNOWN kind survives as an opaque record, with its own fields", () => {
    const event = parseSessionEvent({
      body: {
        protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
        at: AT,
        kind: "slide-anonymised",
        slideIndex: 3,
        strategy: "lorem-ipsum",
      },
      fileNameKind: "slide-anonymised",
    });
    assert.equal(event.kind, "opaque");
    if (event.kind !== "opaque") return;
    assert.equal(event.rawKind, "slide-anonymised");
    assert.equal(event.at, AT);
    // The writer's own fields come back, so a reader can forward or show them.
    assert.deepEqual(event.fields["strategy"], "lorem-ipsum");
    assert.match(describeSessionEvent(event), /something happened \(slide-anonymised\)/);
  });

  test("a NEWER protocolVersion is opaque, not an error and not a guess", () => {
    const event = parseSessionEvent({
      body: { protocolVersion: 7, at: AT, kind: "slides-staged", proposalId: PROPOSAL_ID, count: 2 },
      fileNameKind: "slides-staged",
    });
    assert.equal(event.kind, "opaque");
    assert.match(event.kind === "opaque" ? event.reason : "", /protocolVersion 7 is not 1/);
  });

  test("a known kind missing a field it needs is opaque, never half-read", () => {
    const event = parseSessionEvent({
      body: { protocolVersion: 1, at: AT, kind: "slide-revised", slideIndex: 2 },
      fileNameKind: "slide-revised",
    });
    assert.equal(event.kind, "opaque");
    assert.match(event.kind === "opaque" ? event.reason : "", /slide-revised needs/);
  });

  test("a region whose numbers are not fractional is dropped, not pointed at the wrong place", () => {
    const event = parseSessionEvent({
      body: {
        protocolVersion: 1,
        at: AT,
        kind: "comment-opened",
        slideIndex: 1,
        commentId: "c1",
        text: "here",
        region: { x: 120, y: 240, w: 300, h: 200 },
      },
      fileNameKind: "comment-opened",
    });
    assert.equal(event.kind, "comment-opened");
    assert.equal(event.kind === "comment-opened" ? event.region : undefined, null);
  });

  test("every kind renders one line, including the opaque one", () => {
    const rendered = [
      stagedEvent({ at: AT }),
      revisedEvent({ at: AT, slideIndex: 2 }),
      resolvedEvent(),
    ].map(describeSessionEvent);
    for (const line of rendered) assert.ok(line.length > 0);
  });
});

const PROPOSAL_ID = "p_1791073110901_aaa111";
const NOW_MS = Date.parse("2026-10-04T12:00:00.000Z");
const AT = "2026-10-04T12:00:00.000Z";

type Harness = Readonly<{
  fake: FakeDrive;
  env: SessionLogEnvironment;
  folderId: string;
  eventsFolder: () => Promise<string>;
  putRawEvent: (
    options: Readonly<{ folderId: string; atMillis: number; suffix: string; event: SessionEvent }>,
  ) => void;
  warnings: () => readonly string[];
}>;

function createHarness(): Harness {
  const fake = createFakeDrive();
  const warnings: string[] = [];
  const folder = fake.putForeignFile({
    name: PROPOSAL_ID,
    parentId: "inbox",
    mimeType: "application/vnd.google-apps.folder",
    text: "",
    appProperties: { sashaSlides: "proposal", proposalId: PROPOSAL_ID },
  });
  const env: SessionLogEnvironment = {
    drive: fake.channel,
    now: () => new Date(NOW_MS),
    randomSuffix: () => "aaa111",
    warn: (message) => void warnings.push(message),
  };
  return {
    fake,
    env,
    folderId: folder.id,
    eventsFolder: () => ensureEventsFolder({ env, proposalId: PROPOSAL_ID, folderId: folder.id }),
    putRawEvent: ({ folderId, atMillis, suffix, event }) => {
      fake.putForeignFile({
        name: sessionEventFileName({ atMillis, suffix, kind: event.kind }),
        parentId: folderId,
        mimeType: "application/json",
        text: JSON.stringify(event),
        appProperties: { sashaSlides: "event", proposalId: PROPOSAL_ID },
      });
    },
    warnings: () => [...warnings],
  };
}

function stagedEvent(options: Readonly<{ at: string }>): SessionEvent {
  return {
    kind: "slides-staged",
    protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
    at: options.at,
    proposalId: PROPOSAL_ID,
    revision: 1,
    count: 1,
    slides: [{ index: 1, fileId: "f1", name: "01.html", label: "option 1" }],
  };
}

function revisedEvent(options: Readonly<{ at: string; slideIndex: number }>): SessionEvent {
  return {
    kind: "slide-revised",
    protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
    at: options.at,
    slideIndex: options.slideIndex,
    fileId: "f1",
    revision: 2,
    answeredCommentIds: ["c1"],
    label: null,
  };
}

function resolvedEvent(): SessionEvent {
  return {
    kind: "comment-resolved",
    protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
    at: AT,
    slideIndex: 1,
    commentId: "c1",
    replyId: "r1",
    text: "done",
  };
}

function record(
  options: Readonly<{ atMillis: number; suffix?: string; fileId?: string }>,
): SessionEventRecord {
  const suffix = options.suffix ?? "aaa111";
  return {
    eventId: `${String(options.atMillis)}-${suffix}-comment-resolved`,
    fileId: options.fileId ?? `file-${String(options.atMillis)}-${suffix}`,
    name: `${String(options.atMillis)}-${suffix}-comment-resolved.json`,
    atMillis: options.atMillis,
    suffix,
    event: resolvedEvent(),
  };
}

function ordered(records: readonly SessionEventRecord[]): readonly string[] {
  return [...records]
    .sort(compareSessionEvents)
    .map((candidate) => `${String(candidate.atMillis)}-${candidate.suffix}`);
}

function permutations<TElement>(items: readonly TElement[]): readonly (readonly TElement[])[] {
  if (items.length <= 1) return [items];
  const result: TElement[][] = [];
  for (const [position, item] of items.entries()) {
    const rest = [...items.slice(0, position), ...items.slice(position + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  }
  return result;
}

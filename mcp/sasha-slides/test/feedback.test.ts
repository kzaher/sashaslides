/**
 * The comment feedback channel, asserted against the in-memory `FeedbackChannel`.
 * No credentials, no network: every effect is injected.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/feedback.test.ts
 *
 * The anchor strings in here are **verbatim copies of what Google actually stored** on the
 * live deck (`e2e/feedback-live.ts` re-reads them from Drive, and PROTOCOL.md records them).
 * A fixture invented from the documentation would have been wrong: the docs describe a
 * `{"r":…,"a":[…]}` scheme that Slides does not use.
 *
 * Ordered to follow comment-anchor.ts, then feedback.ts, then server.ts, so the files can be
 * read side by side.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  describeCommentAnchor,
  formatSlideMarker,
  parseFeedbackSentinel,
  parseCommentAnchor,
  resolveSlideLocation,
} from "../feedback/comment-anchor";
import type { CommentThread } from "../feedback/feedback-channel";
import {
  agentReplyBody,
  authoredByAgent,
  awaitFeedback,
  AGENT_REPLY_MARKER,
  DEFAULT_RESOLVE_NOTE,
  feedbackCursorFrom,
  initialFeedbackCursor,
  newPostsSince,
  readFeedback,
  replyFeedback,
  resolveFeedback,
  type FeedbackEnvironment,
  type FeedbackTarget,
  type ReadFeedbackOutcome,
  type ReplyFeedbackOutcome,
} from "../feedback/feedback";
import { awaitFeedbackPayload, readFeedbackPayload, replyFeedbackPayload } from "../server";
import type {
  CandidateReplyOutcome,
  ReadCandidateFeedbackOutcome,
} from "../feedback/candidate-feedback";
import { createFakeComments, type FakeComments } from "./fake-comments";

/** Exactly what Google Slides wrote, read back off the Drive comment. */
const SLIDES_PAGE_ANCHOR = '{"uid":650326478,"pages":["sasha_s0fao02zbr2o"],"type":"page"}';
const SLIDES_SHAPE_ANCHOR = '{"uid":211246977,"page":"p","type":"shape","targets":["i0"]}';
const SLIDES_TEXT_ANCHOR =
  '{"uid":1888281314,"subtype":"text","page":"sasha_s0fao02zbr2o","type":"shape","targets":["sasha_s0fao02zbr2o_text2"]}';
/** What the Google DOCS editor writes into the same field: a bare opaque token. */
const DOCS_ANCHOR = "kix.uyz42h4rp0wc";

const DECK_PAGES = ["p", "sasha_s0fao02zbr2o", "sasha_vlf8kma1pgrq"] as const;
const PRESENTATION_ID = "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";

/**
 * These tests address the DECK on purpose: it is the only target Google itself anchors, so it
 * is where the measured anchor strings above have to keep being resolved. The candidate
 * target — which is what the tools address — is asserted in `test/protocol.test.ts`, where
 * the proposal side can supply a real `NN.html` file id.
 */
const DECK_TARGET: FeedbackTarget = { kind: "presentation", presentationId: PRESENTATION_ID };

describe("parseCommentAnchor", () => {
  test("reads the slide out of the page anchor Slides writes (`pages`, plural)", () => {
    const anchor = parseCommentAnchor(SLIDES_PAGE_ANCHOR);
    assert.deepEqual(anchor, {
      kind: "slides-page",
      pageObjectId: "sasha_s0fao02zbr2o",
      uid: 650326478,
    });
  });

  test("reads the slide out of a shape anchor (`page`, singular, plus targets)", () => {
    const anchor = parseCommentAnchor(SLIDES_SHAPE_ANCHOR);
    assert.deepEqual(anchor, {
      kind: "slides-element",
      pageObjectId: "p",
      elementObjectIds: ["i0"],
      textRange: false,
      uid: 211246977,
    });
  });

  test("marks a text-range anchor as such, keeping the element it is inside", () => {
    const anchor = parseCommentAnchor(SLIDES_TEXT_ANCHOR);
    assert.deepEqual(anchor, {
      kind: "slides-element",
      pageObjectId: "sasha_s0fao02zbr2o",
      elementObjectIds: ["sasha_s0fao02zbr2o_text2"],
      textRange: true,
      uid: 1888281314,
    });
  });

  test("absent and empty anchors are the same thing: unanchored", () => {
    assert.deepEqual(parseCommentAnchor(null), { kind: "absent" });
    assert.deepEqual(parseCommentAnchor(""), { kind: "absent" });
    assert.deepEqual(parseCommentAnchor("   "), { kind: "absent" });
  });

  test("a Docs-style opaque token is reported with the raw string, not discarded", () => {
    const anchor = parseCommentAnchor(DOCS_ANCHOR);
    assert.equal(anchor.kind, "opaque");
    assert.equal(anchor.kind === "opaque" ? anchor.raw : null, DOCS_ANCHOR);
  });

  test("Drive stores whatever it is given, so non-JSON must not throw", () => {
    // Measured: `comments.create` accepted this exact string and handed it back verbatim.
    const anchor = parseCommentAnchor("this-is-not-json-at-all");
    assert.equal(anchor.kind, "opaque");
    assert.equal(anchor.kind === "opaque" ? anchor.reason : null, "not a JSON object");
  });

  test("the legacy documented {r,a} scheme is opaque, not mistaken for a location", () => {
    const anchor = parseCommentAnchor('{"r":"HZzJ1c3YN7xt2Q","a":[{"txt":{"o":0,"l":5}}]}');
    assert.equal(anchor.kind, "opaque");
  });

  test("a malformed Slides anchor degrades to opaque rather than inventing a page", () => {
    assert.equal(parseCommentAnchor('{"type":"page","pages":[]}').kind, "opaque");
    assert.equal(parseCommentAnchor('{"type":"page"}').kind, "opaque");
    assert.equal(parseCommentAnchor('{"type":"shape","targets":["i0"]}').kind, "opaque");
    assert.equal(parseCommentAnchor('{"type":"shape","page":""}').kind, "opaque");
  });

  test("a JSON array is not an anchor object", () => {
    assert.equal(parseCommentAnchor('["p"]').kind, "opaque");
  });

  test("every variant has a human description", () => {
    for (const raw of [null, SLIDES_PAGE_ANCHOR, SLIDES_SHAPE_ANCHOR, SLIDES_TEXT_ANCHOR, DOCS_ANCHOR]) {
      assert.ok(describeCommentAnchor(parseCommentAnchor(raw)).length > 0);
    }
  });
});

describe("resolveSlideLocation", () => {
  test("the Slides anchor wins and yields a 1-based slide number", () => {
    const location = resolveSlideLocation({
      anchor: parseCommentAnchor(SLIDES_PAGE_ANCHOR),
      text: "this chart is unreadable",
      pageObjectIds: DECK_PAGES,
    });
    assert.deepEqual(location, {
      kind: "slide",
      pageObjectId: "sasha_s0fao02zbr2o",
      slideNumber: 2,
      elementObjectIds: [],
      via: "slides-anchor",
    });
  });

  test("an element anchor carries the elements through", () => {
    const location = resolveSlideLocation({
      anchor: parseCommentAnchor(SLIDES_TEXT_ANCHOR),
      text: "typo",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind === "slide" ? location.slideNumber : null, 2);
    assert.deepEqual(location.kind === "slide" ? location.elementObjectIds : null, [
      "sasha_s0fao02zbr2o_text2",
    ]);
  });

  test("an anchored page the deck does not contain keeps the page id but drops the number", () => {
    const location = resolveSlideLocation({
      anchor: parseCommentAnchor(SLIDES_PAGE_ANCHOR),
      text: "stale",
      pageObjectIds: ["p", "something_else"],
    });
    assert.equal(location.kind === "slide" ? location.pageObjectId : null, "sasha_s0fao02zbr2o");
    assert.equal(location.kind === "slide" ? location.slideNumber : "unset", null);
  });

  test("an unreadable deck still yields the page id, just no number", () => {
    const location = resolveSlideLocation({
      anchor: parseCommentAnchor(SLIDES_PAGE_ANCHOR),
      text: "x",
      pageObjectIds: null,
    });
    assert.equal(location.kind === "slide" ? location.slideNumber : "unset", null);
    assert.equal(location.kind === "slide" ? location.pageObjectId : null, "sasha_s0fao02zbr2o");
  });

  test("the [slide:<pageObjectId>] marker is the fallback for unanchored comments", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: `${formatSlideMarker({ pageObjectId: "sasha_vlf8kma1pgrq" })} fix the title`,
      pageObjectIds: DECK_PAGES,
    });
    assert.deepEqual(location, {
      kind: "slide",
      pageObjectId: "sasha_vlf8kma1pgrq",
      slideNumber: 3,
      elementObjectIds: [],
      via: "text-marker",
    });
  });

  test("the marker also accepts a 1-based position", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: "[slide:1] too dense",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind === "slide" ? location.pageObjectId : null, "p");
    assert.equal(location.kind === "slide" ? location.slideNumber : null, 1);
  });

  test("a marker past the end of the deck is rejected, not clamped", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: "[slide:99] ?",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind, "unknown");
  });

  test("a marker naming no page in the deck is rejected", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: "[slide:not_a_page] ?",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind, "unknown");
  });

  test("the marker is only read at the FRONT, so prose cannot be mistaken for it", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: "please check [slide:p] later",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind, "unknown");
  });

  test("an anchored comment ignores a contradicting marker: Google's anchor is authoritative", () => {
    const location = resolveSlideLocation({
      anchor: parseCommentAnchor(SLIDES_PAGE_ANCHOR),
      text: "[slide:1] lying marker",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind === "slide" ? location.slideNumber : null, 2);
    assert.equal(location.kind === "slide" ? location.via : null, "slides-anchor");
  });

  test("no anchor and no marker is an explicit unknown that says why", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: "something is off",
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind, "unknown");
    assert.match(location.kind === "unknown" ? location.reason : "", /unanchored/);
  });
});

describe("the add-on sidebar's sentinel", () => {
  /** The exact body `addon/src/feedback.ts`'s `feedbackCommentContent` produces. */
  const sidebarComment =
    "the chart lost its gridlines\n\n" +
    'sasha-slides-feedback={"protocolVersion":1,"noteId":"user_k2h9",' +
    '"pageObjectId":"sasha_vlf8kma1pgrq","region":{"x":0.1,"y":0.2,"w":0.3,"h":0.2},' +
    '"createdAt":"2026-10-04T12:00:00.000Z"}';

  test("parses the page, the note id and the dragged region", () => {
    assert.deepEqual(parseFeedbackSentinel({ text: sidebarComment }), {
      protocolVersion: 1,
      noteId: "user_k2h9",
      pageObjectId: "sasha_vlf8kma1pgrq",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
    });
  });

  test("places the comment on its slide, the sidebar's way", () => {
    const location = resolveSlideLocation({
      anchor: { kind: "absent" },
      text: sidebarComment,
      pageObjectIds: DECK_PAGES,
    });
    assert.deepEqual(location, {
      kind: "slide",
      pageObjectId: "sasha_vlf8kma1pgrq",
      slideNumber: 3,
      elementObjectIds: [],
      via: "sidebar-sentinel",
    });
  });

  test("a comment with no sentinel is somebody's own, not an error", () => {
    assert.equal(parseFeedbackSentinel({ text: "just a normal comment" }), null);
  });

  test("a region about the whole slide is null, and still locates the slide", () => {
    const text =
      "this slide reads badly\n\n" +
      'sasha-slides-feedback={"protocolVersion":1,"noteId":"n1","pageObjectId":"p","region":null}';
    const sentinel = parseFeedbackSentinel({ text });
    assert.equal(sentinel?.region, null);
    assert.equal(sentinel?.pageObjectId, "p");
  });

  test("a region in the wrong convention is dropped rather than pointed at the wrong place", () => {
    const text =
      'x\n\nsasha-slides-feedback={"noteId":"n1","pageObjectId":"p","region":{"x":128,"y":72,"w":300,"h":200}}';
    assert.equal(parseFeedbackSentinel({ text })?.region, null);
  });

  test("a malformed sentinel does not throw and does not fake a location", () => {
    assert.equal(parseFeedbackSentinel({ text: "x\n\nsasha-slides-feedback={not json" }), null);
    assert.equal(
      resolveSlideLocation({
        anchor: { kind: "absent" },
        text: "x\n\nsasha-slides-feedback={not json",
        pageObjectIds: DECK_PAGES,
      }).kind,
      "unknown",
    );
  });

  test("the last sentinel wins, so quoting an earlier one cannot shadow it", () => {
    const text =
      'quoting sasha-slides-feedback={"pageObjectId":"p"} from before\n\n' +
      'sasha-slides-feedback={"noteId":"n2","pageObjectId":"sasha_vlf8kma1pgrq"}';
    assert.equal(parseFeedbackSentinel({ text })?.pageObjectId, "sasha_vlf8kma1pgrq");
  });

  test("Google's own anchor still outranks the sentinel", () => {
    const location = resolveSlideLocation({
      anchor: parseCommentAnchor(SLIDES_PAGE_ANCHOR),
      text: sidebarComment,
      pageObjectIds: DECK_PAGES,
    });
    assert.equal(location.kind === "slide" ? location.via : null, "slides-anchor");
    assert.equal(location.kind === "slide" ? location.slideNumber : null, 2);
  });

  test("read_feedback surfaces the dragged region to the agent", async () => {
    const harness = createHarness();
    harness.fake.putUserComment({ text: sidebarComment, anchor: null });
    const payload = readFeedbackPayload(
      asCandidateRead(await readFeedback({
        env: harness.env,
        target: DECK_TARGET,
        since: null,
        includeResolved: false,
      })),
    );
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.deepEqual(payload.payload.threads[0]?.region, { x: 0.1, y: 0.2, w: 0.3, h: 0.2 });
    assert.equal(payload.payload.threads[0]?.noteId, "user_k2h9");
    assert.equal(payload.payload.threads[0]?.slideNumber, 3);
  });
});

describe("the agent marker", () => {
  test("a reply body carries the marker, because identity cannot", () => {
    const body = agentReplyBody({ text: "done" });
    assert.ok(body.startsWith("done"));
    assert.ok(body.includes(AGENT_REPLY_MARKER));
    assert.ok(authoredByAgent({ text: body }));
  });

  test("the marker is not doubled when a body already carries it", () => {
    const once = agentReplyBody({ text: "done" });
    assert.equal(agentReplyBody({ text: once }), once);
  });

  test("the user's own text is not mistaken for the agent's", () => {
    assert.equal(authoredByAgent({ text: "this is wrong" }), false);
  });
});

describe("the cursor", () => {
  test("an empty deck anchors the cursor to the clock, not to nothing", () => {
    const cursor = feedbackCursorFrom({ comments: [], now: new Date("2026-10-04T11:00:00.000Z") });
    assert.deepEqual(cursor, { modifiedTime: "2026-10-04T11:00:00.000Z", seenPostIds: [] });
  });

  test("the watermark is the newest post, and names the ids sitting on it", () => {
    const cursor = feedbackCursorFrom({
      comments: [
        thread({ id: "c1", createdTime: "2026-10-04T11:00:00.000Z" }),
        thread({
          id: "c2",
          createdTime: "2026-10-04T11:00:05.000Z",
          replies: [{ id: "r1", createdTime: "2026-10-04T11:00:09.000Z" }],
        }),
      ],
      now: new Date("2026-10-04T12:00:00.000Z"),
    });
    assert.equal(cursor.modifiedTime, "2026-10-04T11:00:09.000Z");
    assert.deepEqual(cursor.seenPostIds, ["r1"]);
  });

  test("two posts in the same millisecond are BOTH recorded as seen", () => {
    const cursor = feedbackCursorFrom({
      comments: [
        thread({
          id: "c1",
          createdTime: "2026-10-04T11:00:09.000Z",
          replies: [{ id: "r1", createdTime: "2026-10-04T11:00:09.000Z" }],
        }),
      ],
      now: new Date("2026-10-04T12:00:00.000Z"),
    });
    assert.deepEqual([...cursor.seenPostIds].sort(), ["c1", "r1"]);
  });

  /** This is the whole reason `seenPostIds` exists. */
  test("the posts at the watermark are NOT re-reported, because Drive's filter is inclusive", () => {
    const comments = [
      thread({
        id: "c1",
        createdTime: "2026-10-04T11:00:00.000Z",
        replies: [{ id: "r1", createdTime: "2026-10-04T11:00:09.000Z" }],
      }),
    ];
    const cursor = feedbackCursorFrom({ comments, now: new Date("2026-10-04T12:00:00.000Z") });
    assert.deepEqual(newPostsSince({ comments, cursor }), []);
  });

  test("a reply added after the cursor is new; the thread's older head post is not", () => {
    const before = [thread({ id: "c1", createdTime: "2026-10-04T11:00:00.000Z" })];
    const cursor = feedbackCursorFrom({ comments: before, now: new Date("2026-10-04T11:00:00.000Z") });
    // The reply bumps the thread's modifiedTime, which is exactly what real Drive does.
    const after = [
      thread({
        id: "c1",
        createdTime: "2026-10-04T11:00:00.000Z",
        modifiedTime: "2026-10-04T11:05:00.000Z",
        replies: [{ id: "r1", createdTime: "2026-10-04T11:05:00.000Z" }],
      }),
    ];
    const fresh = newPostsSince({ comments: after, cursor });
    assert.deepEqual(
      fresh.map((post) => post.postId),
      ["r1"],
    );
  });

  test("a brand new comment is new", () => {
    const cursor = feedbackCursorFrom({ comments: [], now: new Date("2026-10-04T11:00:00.000Z") });
    const fresh = newPostsSince({
      comments: [thread({ id: "c9", createdTime: "2026-10-04T11:00:01.000Z" })],
      cursor,
    });
    assert.deepEqual(
      fresh.map((post) => post.postId),
      ["c9"],
    );
  });

  test("history strictly before the cursor is dropped", () => {
    const cursor = { modifiedTime: "2026-10-04T11:00:00.000Z", seenPostIds: [] } as const;
    assert.deepEqual(
      newPostsSince({ comments: [thread({ id: "old", createdTime: "2026-10-01T09:00:00.000Z" })], cursor }),
      [],
    );
  });

  test("an unparseable timestamp counts as new: losing the user's feedback is the worse bug", () => {
    const cursor = { modifiedTime: "2026-10-04T11:00:00.000Z", seenPostIds: [] } as const;
    const fresh = newPostsSince({ comments: [thread({ id: "weird", createdTime: "not a date" })], cursor });
    assert.deepEqual(
      fresh.map((post) => post.postId),
      ["weird"],
    );
  });

  test("the initial cursor suppresses EVERY existing post, not just the newest", () => {
    const comments = [
      thread({ id: "c1", createdTime: "2026-10-04T11:00:00.000Z" }),
      thread({
        id: "c2",
        createdTime: "2026-10-04T11:00:00.000Z",
        replies: [{ id: "r1", createdTime: "2026-10-04T11:00:00.000Z" }],
      }),
    ];
    // Everything shares one millisecond, so a watermark-only cursor would re-fire all of it.
    const cursor = initialFeedbackCursor({ comments, now: new Date("2026-10-04T11:00:00.000Z") });
    assert.deepEqual([...cursor.seenPostIds].sort(), ["c1", "c2", "r1"]);
    assert.deepEqual(newPostsSince({ comments, cursor }), []);
  });

  test("the resolve reply is reported as an action, not as feedback text to act on", () => {
    const comments = [
      thread({
        id: "c1",
        createdTime: "2026-10-04T11:00:00.000Z",
        replies: [{ id: "r1", createdTime: "2026-10-04T11:05:00.000Z", action: "resolve" }],
      }),
    ];
    const cursor = { modifiedTime: "2026-10-04T11:01:00.000Z", seenPostIds: [] } as const;
    const fresh = newPostsSince({ comments, cursor });
    assert.equal(fresh[0]?.action, "resolve");
  });
});

describe("readFeedback", () => {
  test("places each thread on its slide and reports the raw anchor alongside", async () => {
    const harness = createHarness();
    harness.fake.putUserComment({ text: "chart unreadable", anchor: SLIDES_PAGE_ANCHOR });
    harness.fake.putUserComment({ text: "typo here", anchor: SLIDES_TEXT_ANCHOR, quotedText: "Propo" });

    const outcome = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    assert.equal(outcome.threads.length, 2);
    for (const thread of outcome.threads) {
      assert.equal(thread.slide.kind === "slide" ? thread.slide.slideNumber : null, 2);
      assert.ok(thread.anchorRaw !== null);
    }
    assert.equal(outcome.slideNumbering.kind === "ok" ? outcome.slideNumbering.slideCount : null, 3);
  });

  test("open threads only, unless includeResolved says otherwise", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "fix this", anchor: SLIDES_PAGE_ANCHOR });
    await resolveFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: null,
    });

    const open = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    assert.equal(open.threads.length, 0);

    const all = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: true,
    });
    assert.equal(all.threads.length, 1);
    assert.equal(all.threads[0]?.resolved, true);
  });

  /** A cursor built only from unresolved threads would replay the resolved ones for ever. */
  test("the cursor covers resolved threads too, even when they are filtered out", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "fix this", anchor: SLIDES_PAGE_ANCHOR });
    harness.advance({ milliseconds: 1_000 });
    await resolveFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: null,
    });

    const outcome = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    assert.equal(outcome.threads.length, 0);
    const comments = harness.fake.threads();
    assert.deepEqual(newPostsSince({ comments, cursor: outcome.cursor }), []);
  });

  test("the user's text is reported verbatim, marker and all", async () => {
    const harness = createHarness();
    harness.fake.putUserComment({ text: "[slide:3] shrink the logo", anchor: null });
    const outcome = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    assert.equal(outcome.threads[0]?.text, "[slide:3] shrink the logo");
    assert.equal(outcome.threads[0]?.slide.kind === "slide" ? outcome.threads[0].slide.slideNumber : null, 3);
  });

  test("an unreadable deck is a note, not a failure", async () => {
    const harness = createHarness();
    harness.fake.setDeckPages({ pages: { kind: "unavailable", reason: "403 from Slides" } });
    harness.fake.putUserComment({ text: "x", anchor: SLIDES_PAGE_ANCHOR });

    const payload = readFeedbackPayload(
      asCandidateRead(await readFeedback({
        env: harness.env,
        target: DECK_TARGET,
        since: null,
        includeResolved: false,
      })),
    );
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.slideCount, null);
    assert.equal(payload.payload.threads[0]?.pageObjectId, "sasha_s0fao02zbr2o");
    assert.equal(payload.payload.threads[0]?.slideNumber, null);
    assert.match(payload.payload.note ?? "", /slide order could not be read/);
    assert.deepEqual(harness.warnings(), ["slide numbering unavailable for " + PRESENTATION_ID + ": 403 from Slides"]);
  });

  test("a thread that cannot be placed is reported with an actionable note", async () => {
    const harness = createHarness();
    harness.fake.putUserComment({ text: "no idea which slide", anchor: null });
    const payload = readFeedbackPayload(
      asCandidateRead(await readFeedback({
        env: harness.env,
        target: DECK_TARGET,
        since: null,
        includeResolved: false,
      })),
    );
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.match(payload.payload.note ?? "", /could not be placed on a slide/);
  });
});

describe("replyFeedback and resolveFeedback", () => {
  test("a reply lands inside the user's own thread and is tagged as the agent's", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "too dense", anchor: SLIDES_PAGE_ANCHOR });
    const outcome = await replyFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: "split across two slides",
    });
    assert.equal(outcome.kind, "ok");

    const read = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.threads[0]?.replies.length, 1);
    assert.equal(read.threads[0]?.replies[0]?.authoredByAgent, true);
    assert.match(read.threads[0]?.replies[0]?.text ?? "", /split across two slides/);
  });

  test("an unknown comment id is a value, never a thrown Google 404", async () => {
    const harness = createHarness();
    const outcome = await replyFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: "nope",
      text: "hello",
    });
    assert.equal(outcome.kind, "unknown-comment");
    const payload = replyFeedbackPayload({ outcome: asCandidateReply(outcome), tool: "reply_feedback" });
    assert.equal(payload.kind, "error");
  });

  test("empty text is rejected before Drive sees it", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "x", anchor: null });
    const outcome = await replyFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: "   ",
    });
    assert.equal(outcome.kind, "invalid-input");
    // Nothing was posted: the guard runs before the channel is touched.
    assert.equal(harness.fake.calls().filter((call) => call.op === "createReply").length, 0);
  });

  test("resolving is a reply carrying the resolve action, and defaults its note", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "fix", anchor: null });
    const outcome = await resolveFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: null,
    });
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.kind === "ok" ? outcome.resolved : null, true);

    const all = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: true,
    });
    const reply = all.threads[0]?.replies[0];
    assert.equal(reply?.action, "resolve");
    assert.match(reply?.text ?? "", new RegExp(DEFAULT_RESOLVE_NOTE));
  });

  /** `resolved` is output-only on Drive, so the only honest report is one we read back. */
  test("the resolved flag is observed, not assumed", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "fix", anchor: null });
    await resolveFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: "done",
    });
    const reads = harness.fake.calls().filter((call) => call.op === "getComment");
    // One before the write to prove the thread exists, one after to confirm the state.
    assert.equal(reads.length, 2);
  });
});

describe("awaitFeedback", () => {
  test("times out as a value when the user says nothing", async () => {
    const harness = createHarness();
    const outcome = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      timeoutMs: 5_000,
    });
    assert.equal(outcome.kind, "timeout");
    assert.ok(outcome.kind === "timeout" && outcome.polls > 1);
    const payload = awaitFeedbackPayload({
      kind: "ok",
      slideIndex: 2,
      outcome,
      delivery: { kind: "nothing-delivered" },
    });
    assert.equal(payload.kind === "payload" ? payload.payload.status : null, "timeout");
    assert.equal(payload.kind === "payload" ? payload.payload.posts.length : -1, 0);
  });

  test("never overshoots the deadline, however long the backoff grew", async () => {
    const harness = createHarness();
    const startedAt = harness.now().getTime();
    const outcome = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      timeoutMs: 7_500,
    });
    assert.equal(outcome.kind, "timeout");
    assert.equal(harness.now().getTime() - startedAt, 7_500);
  });

  test("does not fire on comments that already existed", async () => {
    const harness = createHarness();
    harness.fake.putUserComment({ text: "old news", anchor: SLIDES_PAGE_ANCHOR });
    const outcome = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      timeoutMs: 3_000,
    });
    assert.equal(outcome.kind, "timeout");
  });

  test("wakes on a new comment and places it on its slide", async () => {
    const harness = createHarness();
    const waiting = awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      timeoutMs: 60_000,
    });
    // The fake clock only moves inside `sleep`, so the comment is in place before the
    // first backoff elapses — no race, and no wall-clock time spent.
    harness.fake.putUserComment({ text: "the legend overlaps", anchor: SLIDES_TEXT_ANCHOR });
    const outcome = await waiting;
    assert.equal(outcome.kind, "arrived");
    if (outcome.kind !== "arrived") return;
    assert.equal(outcome.posts.length, 1);
    assert.equal(outcome.posts[0]?.text, "the legend overlaps");
    assert.equal(outcome.posts[0]?.kind, "comment");
    assert.equal(outcome.posts[0]?.slide.kind === "slide" ? outcome.posts[0].slide.slideNumber : null, 2);
  });

  test("wakes on a new reply, which inherits its thread's slide", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "chart", anchor: SLIDES_PAGE_ANCHOR });
    const first = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    harness.fake.putUserReply({ commentId: comment.id, text: "still wrong" });

    const outcome = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: first.cursor,
      timeoutMs: 10_000,
    });
    assert.equal(outcome.kind, "arrived");
    if (outcome.kind !== "arrived") return;
    assert.deepEqual(
      outcome.posts.map((post) => post.text),
      ["still wrong"],
    );
    assert.equal(outcome.posts[0]?.kind, "reply");
    assert.equal(outcome.posts[0]?.commentId, comment.id);
    assert.equal(outcome.posts[0]?.slide.kind === "slide" ? outcome.posts[0].slide.slideNumber : null, 2);
  });

  /**
   * The channel would be unusable without this: the server acts AS the user, so Drive
   * reports `author.me` for the agent's reply and the user's comment alike.
   */
  test("the agent's own reply never ends the wait", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "fix the title", anchor: SLIDES_PAGE_ANCHOR });
    const first = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    await replyFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: "retitled",
    });

    const outcome = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: first.cursor,
      timeoutMs: 5_000,
    });
    assert.equal(outcome.kind, "timeout");
  });

  test("after ignoring its own reply, it still wakes on the user's answer", async () => {
    const harness = createHarness();
    const comment = harness.fake.putUserComment({ text: "fix the title", anchor: SLIDES_PAGE_ANCHOR });
    const first = await readFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: null,
      includeResolved: false,
    });
    await replyFeedback({
      env: harness.env,
      target: DECK_TARGET,
      commentId: comment.id,
      text: "retitled",
    });
    const ignored = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: first.cursor,
      timeoutMs: 5_000,
    });
    assert.equal(ignored.kind, "timeout");

    harness.fake.putUserReply({ commentId: comment.id, text: "perfect" });
    const outcome = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: ignored.kind === "timeout" ? ignored.cursor : null,
      timeoutMs: 10_000,
    });
    assert.equal(outcome.kind, "arrived");
    assert.deepEqual(
      outcome.kind === "arrived" ? outcome.posts.map((post) => post.text) : [],
      ["perfect"],
    );
  });

  test("the returned cursor does not re-report what it just reported", async () => {
    const harness = createHarness();
    harness.fake.putUserComment({ text: "one", anchor: SLIDES_PAGE_ANCHOR });
    const first = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      // Start from an empty cursor so the pre-existing comment counts as new.
      since: { modifiedTime: "2026-10-04T00:00:00.000Z", seenPostIds: [] },
      timeoutMs: 10_000,
    });
    assert.equal(first.kind, "arrived");
    if (first.kind !== "arrived") return;

    const second = await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: first.cursor,
      timeoutMs: 3_000,
    });
    assert.equal(second.kind, "timeout");
  });

  test("a poll that finds nothing does not read the deck", async () => {
    const harness = createHarness();
    await awaitFeedback({
      env: harness.env,
      target: DECK_TARGET,
      since: { modifiedTime: "2026-10-04T11:00:00.000Z", seenPostIds: [] },
      timeoutMs: 5_000,
    });
    assert.equal(harness.fake.calls().filter((call) => call.op === "listSlidePages").length, 0);
  });
});

type Harness = Readonly<{
  env: FeedbackEnvironment;
  fake: FakeComments;
  now: () => Date;
  advance: (options: Readonly<{ milliseconds: number }>) => void;
  warnings: () => readonly string[];
}>;

/**
 * One virtual clock shared by the environment and the fake. When they were separate, a
 * comment written "now" could land before a cursor taken "now" — so the clock is injected
 * into both and `sleep` is the only thing that moves it.
 */
function createHarness(): Harness {
  let nowMs = Date.parse("2026-10-04T11:00:00.000Z");
  const warnings: string[] = [];
  const now = (): Date => new Date(nowMs);
  const fake = createFakeComments({ now, pageObjectIds: DECK_PAGES, defaultFileId: PRESENTATION_ID });
  return {
    env: {
      channel: fake.channel,
      now,
      sleep: ({ milliseconds }) => {
        nowMs += milliseconds;
        return Promise.resolve();
      },
      warn: (message) => void warnings.push(message),
    },
    fake,
    now,
    advance: ({ milliseconds }) => {
      nowMs += milliseconds;
    },
    warnings: () => [...warnings],
  };
}

/** A `CommentThread` for the pure cursor tests, where no channel is involved at all. */
function thread(
  options: Readonly<{
    id: string;
    createdTime: string;
    modifiedTime?: string;
    text?: string;
    anchor?: string | null;
    resolved?: boolean;
    replies?: readonly Readonly<{
      id: string;
      createdTime: string;
      action?: "none" | "resolve" | "reopen";
      text?: string;
    }>[];
  }>,
): CommentThread {
  const author = { displayName: "Ante M", emailAddress: null, isMe: true } as const;
  return {
    id: options.id,
    author,
    text: options.text ?? `comment ${options.id}`,
    htmlText: null,
    createdTime: options.createdTime,
    modifiedTime: options.modifiedTime ?? options.createdTime,
    anchor: options.anchor ?? null,
    quotedText: null,
    resolved: options.resolved ?? false,
    deleted: false,
    replies: (options.replies ?? []).map((reply) => ({
      id: reply.id,
      author,
      text: reply.text ?? `reply ${reply.id}`,
      htmlText: null,
      createdTime: reply.createdTime,
      modifiedTime: reply.createdTime,
      deleted: false,
      action: reply.action ?? "none",
    })),
  };
}

/**
 * The payload functions take the CANDIDATE outcomes, because that is what the tools produce.
 * These two adapters let the deck-targeted assertions above keep exercising them without
 * pretending the deck path has a proposal: the address resolution they skip is asserted
 * separately, in `test/protocol.test.ts`.
 */
function asCandidateRead(outcome: ReadFeedbackOutcome): ReadCandidateFeedbackOutcome {
  return {
    kind: "ok",
    proposalId: "p_deck_target",
    slideIndex: null,
    outcome,
    unresolved: [],
    delivery: { kind: "nothing-delivered" },
  };
}

function asCandidateReply(outcome: ReplyFeedbackOutcome): CandidateReplyOutcome {
  return { kind: "ok", slideIndex: 2, outcome, logged: true, logFailure: null };
}

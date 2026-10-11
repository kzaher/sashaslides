// SLIDE PREVIEWS: which candidate HTML the sidebar fetches for its thumbnails, what each thumbnail
// shows, and what a comment card says about the slide it is on. Order follows slide-previews.ts.

import assert from "node:assert/strict";
import test from "node:test";
import type { ProposalMark } from "./bridge.ts";
import {
  INITIAL_CONVERSATION,
  reduceConversation,
  type Conversation,
  type ConversationEvent,
} from "./conversation-state.ts";
import type { Manifest } from "./protocol.ts";
import { sessionEventsOf, type SessionEventFile } from "./session-log.ts";
import {
  NO_PREVIEWS,
  describeThreadSlide,
  nextPreviewToLoad,
  previewOf,
  reducePreviews,
  threadSlideContextOf,
  type SlidePreviews,
} from "./slide-previews.ts";

const AT = "2026-10-04T12:00:00.000Z";
const PROPOSAL = "p_1733219000000_a1b2c3";

const manifest: Manifest = {
  protocolVersion: 1,
  proposalId: PROPOSAL,
  createdAt: AT,
  presentationId: "deck_0123456789",
  count: 2,
  slides: [
    { index: 1, fileId: "html_1", name: "01.html", label: "option 1" },
    { index: 2, fileId: "html_2", name: "02.html", label: "" },
  ],
  revision: 1,
};

const stagedMark: ProposalMark = {
  proposalId: PROPOSAL,
  folderId: "folder_1",
  readyFileId: "ready",
  pickFileId: null,
  createdTime: "2026-10-04T11:59:00.000Z",
};

// --- nextPreviewToLoad ------------------------------------------------------

test("nothing is fetched before the manifest says which files the candidates are", () => {
  assert.equal(nextPreviewToLoad({ conversation: replay([]), previews: NO_PREVIEWS }), null);
});

test("each candidate's HTML is fetched once, in order, ONE AT A TIME so polls are never starved", () => {
  const conversation = following();
  const first = nextPreviewToLoad({ conversation, previews: NO_PREVIEWS });
  assert.deepEqual(first && { slideIndex: first.slideIndex, fileId: first.fileId }, { slideIndex: 1, fileId: "html_1" });
  if (first === null) return;
  const inFlight = reducePreviews(NO_PREVIEWS, { kind: "preview-requested", key: first.key });
  assert.equal(nextPreviewToLoad({ conversation, previews: inFlight }), null, "one request in flight at a time");
  const done = reducePreviews(inFlight, { kind: "preview-arrived", key: first.key, html: "<p>one</p>" });
  assert.equal(nextPreviewToLoad({ conversation, previews: done })?.slideIndex, 2);
});

test("a failed fetch is not retried in a loop -- the thumbnail says why instead", () => {
  const conversation = following();
  const failed = loadAll({ conversation, outcome: () => ({ kind: "failed", message: "Drive HTTP 500" }) });
  assert.equal(nextPreviewToLoad({ conversation, previews: failed }), null);
  assert.deepEqual(previewOf({ conversation, previews: failed, slideIndex: 1 }), {
    kind: "unavailable",
    message: "Drive HTTP 500",
  });
});

test("a REVISED slide is left to the revised-slide loader, so nothing is downloaded twice", () => {
  const conversation = following({ events: [revised({ slideIndex: 2, revision: 2 })] });
  const loaded = loadAll({ conversation, outcome: () => ({ kind: "arrived", html: "<p>x</p>" }) });
  assert.equal(loaded.size, 1, "only slide 1 went through the preview loader");
  assert.equal(previewOf({ conversation, previews: loaded, slideIndex: 2 }).kind, "loading");
  const arrived = reduceConversation(
    reduceConversation(conversation, { kind: "slide-requested", slideIndex: 2 }),
    { kind: "slide-arrived", slideIndex: 2, html: "<p>revised</p>" },
  );
  assert.deepEqual(previewOf({ conversation: arrived, previews: loaded, slideIndex: 2 }), {
    kind: "ready",
    html: "<p>revised</p>",
  });
});

test("a NEW revision of an unrevised slide invalidates the preview: the file is overwritten in place", () => {
  const before = following();
  const loaded = loadAll({ conversation: before, outcome: () => ({ kind: "arrived", html: "<p>staged</p>" }) });
  assert.equal(previewOf({ conversation: before, previews: loaded, slideIndex: 1 }).kind, "ready");
  const after = reduceConversation(before, {
    kind: "log-arrived",
    events: eventsOf([revised({ slideIndex: 1, revision: 2 })]),
    readAt: AT,
  });
  assert.equal(
    previewOf({ conversation: after, previews: loaded, slideIndex: 1 }).kind,
    "loading",
    "the staged bytes are not the slide any more",
  );
});

// --- previewOf ----------------------------------------------------------------

test("a slide that is not in the manifest is unavailable, not loading for ever", () => {
  const preview = previewOf({ conversation: following(), previews: NO_PREVIEWS, slideIndex: 9 });
  assert.equal(preview.kind, "unavailable");
});

// --- threadSlideContextOf / describeThreadSlide ------------------------------------

test("a deck message has no candidate context", () => {
  const context = threadSlideContextOf({
    conversation: following(),
    thread: { slideIndex: null, root: { at: AT } },
  });
  assert.deepEqual(context, { kind: "deck" });
});

test("a comment on an unrevised candidate names it, with its label", () => {
  const context = threadSlideContextOf({
    conversation: following(),
    thread: { slideIndex: 1, root: { at: AT } },
  });
  assert.deepEqual(context, {
    kind: "candidate",
    slideIndex: 1,
    label: "option 1",
    revision: null,
    revised: false,
    revisedSinceComment: false,
  });
  assert.equal(describeThreadSlide(context), "Candidate 1 · option 1");
});

test("a comment on a revised candidate carries the revision, and says when the slide moved on since", () => {
  const conversation = following({ events: [revised({ slideIndex: 2, revision: 3 })] });
  const before = threadSlideContextOf({
    conversation,
    thread: { slideIndex: 2, root: { at: "2026-10-04T12:06:00.000Z" } },
  });
  assert.deepEqual(before, {
    kind: "candidate",
    slideIndex: 2,
    label: "02.html",
    revision: 3,
    revised: true,
    revisedSinceComment: true,
  });
  assert.equal(describeThreadSlide(before), "Candidate 2 · revision 3 · changed since this comment");
  const after = threadSlideContextOf({
    conversation,
    thread: { slideIndex: 2, root: { at: "2026-10-04T12:30:00.000Z" } },
  });
  assert.equal(describeThreadSlide(after), "Candidate 2 · revision 3");
});

test("a revision with no number is still said to be a revision", () => {
  const conversation = following({ events: [revised({ slideIndex: 2, revision: null })] });
  const context = threadSlideContextOf({
    conversation,
    thread: { slideIndex: 2, root: { at: "2026-10-04T12:30:00.000Z" } },
  });
  assert.equal(describeThreadSlide(context), "Candidate 2 · revised");
});

// --- helpers --------------------------------------------------------------------

function replay(events: readonly ConversationEvent[]): Conversation {
  let conversation = INITIAL_CONVERSATION;
  for (const event of events) conversation = reduceConversation(conversation, event);
  return conversation;
}

function following(options: Readonly<{ events?: readonly SessionEventFileLike[] }> = {}): Conversation {
  return replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf(options.events ?? []), readAt: AT },
  ]);
}

type Outcome = Readonly<{ kind: "arrived"; html: string }> | Readonly<{ kind: "failed"; message: string }>;

/** Drive the preview loop to completion the way sidebar.tsx's pump does. */
function loadAll({
  conversation,
  outcome,
}: {
  conversation: Conversation;
  outcome: (slideIndex: number) => Outcome;
}): SlidePreviews {
  let previews = NO_PREVIEWS;
  for (let guard = 0; guard < 20; guard += 1) {
    const next = nextPreviewToLoad({ conversation, previews });
    if (next === null) return previews;
    previews = reducePreviews(previews, { kind: "preview-requested", key: next.key });
    const result = outcome(next.slideIndex);
    previews = reducePreviews(
      previews,
      result.kind === "arrived"
        ? { kind: "preview-arrived", key: next.key, html: result.html }
        : { kind: "preview-failed", key: next.key, message: result.message },
    );
  }
  throw new Error("the preview loop never settled");
}

type SessionEventFileLike = Readonly<{ name: string; text: string }>;

function eventsOf(files: readonly SessionEventFileLike[]) {
  return sessionEventsOf({
    files: files.map(
      (file): SessionEventFile => ({ proposalId: PROPOSAL, fileId: `drive_${file.name}`, name: file.name, text: file.text }),
    ),
  });
}

function revised({ slideIndex, revision }: { slideIndex: number; revision: number | null }): SessionEventFileLike {
  return {
    name: "1791115680000-dddddd-slide-revised.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:08:00.000Z",
      kind: "slide-revised",
      slideIndex,
      answers: ["cc_open"],
      revision,
    }),
  };
}

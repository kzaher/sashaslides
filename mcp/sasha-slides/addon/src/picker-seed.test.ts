// THE SLIDES WINDOW'S SEED: what the sidebar hands over, how the window parses it, and that the
// offer it creates needs no further HTML round trips. Order follows picker-seed.ts.

import assert from "node:assert/strict";
import test from "node:test";
import type { ProposalMark } from "./bridge.ts";
import { INITIAL_CONVERSATION, reduceConversation, type Conversation, type ConversationEvent } from "./conversation-state.ts";
import { SEED_HTML_BUDGET, parseBootSeed, pickerSeedOf, type BootSeed, type PickerSeed } from "./picker-seed.ts";
import { htmlToLoad, offerOf, reducePicker, type PickerState } from "./picker-state.ts";
import type { Manifest, MergeSpec } from "./protocol.ts";
import { NO_PREVIEWS, nextPreviewToLoad, reducePreviews, type SlidePreviews } from "./slide-previews.ts";

const AT = "2026-10-11T12:00:00.000Z";
const PROPOSAL = "p_1760184000000_seed01";

const manifest: Manifest = {
  protocolVersion: 1,
  proposalId: PROPOSAL,
  createdAt: AT,
  presentationId: "deck_0123456789",
  count: 3,
  slides: [
    { index: 1, fileId: "html_1", name: "01.html", label: "option 1" },
    { index: 2, fileId: "html_2", name: "02.html", label: "option 2" },
    { index: 3, fileId: "html_3", name: "03.html", label: "" },
  ],
  revision: 1,
  merge: null,
};

const stagedMark: ProposalMark = {
  proposalId: PROPOSAL,
  folderId: "folder_1",
  readyFileId: "ready",
  pickFileId: null,
  createdTime: "2026-10-11T11:59:00.000Z",
};

const HELLO = { protocolVersion: 1, presentationUrl: "https://docs.google.com/open?id=deck_0123456789" };

// --- pickerSeedOf -----------------------------------------------------------

test("no seed before the sidebar has read the manifest: the window boots the old way", () => {
  const conversation = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(pickerSeedOf({ conversation, previews: NO_PREVIEWS, slideIndex: null }), null);
});

test("the seed carries the proposal exactly as the window's observer would have loaded it", () => {
  const seed = pickerSeedOf({ conversation: following(), previews: NO_PREVIEWS, slideIndex: 2 });
  assert.deepEqual(seed, {
    proposal: {
      proposalId: PROPOSAL,
      folderId: "folder_1",
      presentationId: "deck_0123456789",
      count: 3,
      slides: manifest.slides,
      revision: manifest.revision,
      merge: manifest.merge,
    },
    slideIndex: 2,
    html: [],
  });
});

test("every thumbnail the sidebar already fetched is seeded, the opened candidate first", () => {
  const conversation = following();
  const previews = loadAll({ conversation, html: (index) => `<p>slide ${index}</p>` });
  const seed = pickerSeedOf({ conversation, previews, slideIndex: 3 });
  assert.deepEqual(
    seed?.html.map((entry) => entry.index),
    [3, 1, 2],
  );
  assert.equal(seed?.html[0]?.html, "<p>slide 3</p>");
});

test("past the budget a candidate is left for the window to fetch, never the opened one", () => {
  const conversation = following();
  const big = "x".repeat(Math.floor(SEED_HTML_BUDGET * 0.6));
  const previews = loadAll({ conversation, html: () => big });
  const seed = pickerSeedOf({ conversation, previews, slideIndex: 2 });
  assert.deepEqual(
    seed?.html.map((entry) => entry.index),
    [2],
  );
});

// --- parseBootSeed ------------------------------------------------------------

test("a seed survives Code.gs's escaping and parses back unchanged", () => {
  const conversation = following();
  const previews = loadAll({ conversation, html: (index) => `<style>p{}</style><script>var a = "</script>";</script>${index}` });
  const seed = pickerSeedOf({ conversation, previews, slideIndex: 1 });
  assert.ok(seed !== null);
  const boot: BootSeed = { hello: HELLO, seed };
  // Exactly what build-addon.ts's showPicker does before appending the element.
  const appended = JSON.stringify(boot).replace(/</g, "\\u003c");
  assert.ok(!appended.includes("<"), "no '<' is left to end the inert element early");
  assert.deepEqual(parseBootSeed(appended), { kind: "ok", value: boot });
});

test("a malformed seed is rejected, so the window falls back instead of breaking", () => {
  const valid: PickerSeed = {
    proposal: { proposalId: PROPOSAL, folderId: "folder_1", presentationId: null, count: 1, slides: [manifest.slides[0]!], revision: null, merge: null },
    slideIndex: null,
    html: [],
  };
  const cases: readonly Readonly<{ why: string; text: string }>[] = [
    { why: "not JSON", text: "{" },
    { why: "no hello", text: JSON.stringify({ seed: valid }) },
    { why: "slides not 1..count", text: JSON.stringify({ hello: HELLO, seed: { ...valid, proposal: { ...valid.proposal, count: 2 } } }) },
    { why: "html for a slide that is not there", text: JSON.stringify({ hello: HELLO, seed: { ...valid, html: [{ index: 2, html: "" }] } }) },
  ];
  for (const { why, text } of cases) assert.equal(parseBootSeed(text).kind, "invalid", why);
});

test("A MERGE PROPOSAL SURVIVES THE SEED: the window must not offer it as an insert", () => {
  const merge: MergeSpec = {
    presentationId: "deck_1",
    slideObjectId: "g_slide_7",
    removals: [{ index: 1, remove: ["g_title", "g_chart"] }],
  };
  const seed: PickerSeed = {
    proposal: { proposalId: PROPOSAL, folderId: "folder_1", presentationId: "deck_1", count: 1, slides: [manifest.slides[0]!], revision: 1, merge },
    slideIndex: null,
    html: [],
  };
  const parsed = parseBootSeed(JSON.stringify({ hello: HELLO, seed }));
  assert.deepEqual(parsed.kind === "ok" ? parsed.value.seed.proposal.merge : parsed, merge);
});

test("a seed whose merge is malformed is rejected whole, never seeded as an insert", () => {
  const seed = {
    proposal: { proposalId: PROPOSAL, folderId: "folder_1", presentationId: "deck_1", count: 1, slides: [manifest.slides[0]!], revision: 1, merge: { presentationId: "deck_1" } },
    slideIndex: null,
    html: [],
  };
  assert.equal(parseBootSeed(JSON.stringify({ hello: HELLO, seed })).kind, "invalid");
});

test("a target outside the proposal opens the grid rather than failing", () => {
  const seed: PickerSeed = {
    proposal: { proposalId: PROPOSAL, folderId: "folder_1", presentationId: null, count: 1, slides: [manifest.slides[0]!], revision: null, merge: null },
    slideIndex: 7,
    html: [],
  };
  const parsed = parseBootSeed(JSON.stringify({ hello: HELLO, seed }));
  assert.equal(parsed.kind === "ok" ? parsed.value.seed.slideIndex : "rejected", null);
});

// --- reducePicker: proposal-seeded -----------------------------------------

test("a seeded offer is born with its HTML and open on the asked-for candidate", () => {
  const conversation = following();
  const previews = loadAll({ conversation, html: (index) => (index === 3 ? null : `<p>${index}</p>`) });
  const seed = pickerSeedOf({ conversation, previews, slideIndex: 2 });
  assert.ok(seed !== null);
  const state = seeded(seed);
  const offer = offerOf(state);
  assert.equal(offer?.editing, 2);
  assert.equal(offer?.selectedIndex, 2);
  // Only the candidate the sidebar had not fetched is left for the window to ask for.
  assert.deepEqual(offer && htmlToLoad(offer).map((frame) => frame.index), [3]);
});

test("the observer re-announcing the seeded proposal changes nothing", () => {
  const seed = pickerSeedOf({ conversation: following(), previews: NO_PREVIEWS, slideIndex: 1 });
  assert.ok(seed !== null);
  const state = seeded(seed);
  assert.equal(reducePicker(state, { kind: "proposal-offered", proposal: seed.proposal, presentationId: "deck_0123456789" }), state);
});

function seeded(seed: PickerSeed): PickerState {
  return reducePicker(
    { status: "dormant" },
    { kind: "proposal-seeded", proposal: seed.proposal, presentationId: "deck_0123456789", html: seed.html, slideIndex: seed.slideIndex },
  );
}

function replay(events: readonly ConversationEvent[]): Conversation {
  let conversation = INITIAL_CONVERSATION;
  for (const event of events) conversation = reduceConversation(conversation, event);
  return conversation;
}

function following(): Conversation {
  return replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: [], readAt: AT },
  ]);
}

/** Drive the sidebar's preview loop; `html` returning null leaves that candidate unfetched. */
function loadAll({ conversation, html }: { conversation: Conversation; html: (index: number) => string | null }): SlidePreviews {
  let previews = NO_PREVIEWS;
  for (let guard = 0; guard < 20; guard += 1) {
    const next = nextPreviewToLoad({ conversation, previews });
    if (next === null) return previews;
    previews = reducePreviews(previews, { kind: "preview-requested", key: next.key });
    const body = html(next.slideIndex);
    previews = reducePreviews(
      previews,
      body === null
        ? { kind: "preview-failed", key: next.key, message: "not fetched" }
        : { kind: "preview-arrived", key: next.key, html: body },
    );
  }
  return previews;
}

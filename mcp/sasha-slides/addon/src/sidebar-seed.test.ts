// ASK SASHA'S BOOT SEED: what Code.gs appends, how the panel parses it, and the rule that a seed is
// a head start and never the truth -- the fresh reads replace it, including when they contradict it.
// Order follows sidebar-seed.ts, then conversation-state.ts's seed handling, then Code.gs.

import assert from "node:assert/strict";
import test from "node:test";
import { codeGs, DEFAULT_EDITOR_ORIGIN, SIDEBAR_MEMORY_MAXIMUM_CHARACTERS, SIDEBAR_MEMORY_SECONDS } from "./apps-script-project.ts";
import type { ProposalMark, RawEventFile } from "./bridge.ts";
import {
  INITIAL_CONVERSATION,
  NOTHING_SEEDED,
  assistantConnectionOf,
  conversationIsOpening,
  needsLog,
  needsManifest,
  needsStaged,
  proposalToAutoOpen,
  reduceConversation,
  seedIsRefreshing,
  slidesOf,
  slidesReachability,
  type Conversation,
  type ConversationEvent,
  type SidebarSeed,
} from "./conversation-state.ts";
import { newestSetChangeIn, sessionEventsOf } from "./session-log.ts";
import { SIDEBAR_SEED_ELEMENT_ID, parseSidebarBoot, sidebarSeedOf } from "./sidebar-seed.ts";
import { conversationMarkupOf as markupOf } from "./test-support.ts";

const DECK = "deck_0123456789";
const OTHER_DECK = "deck_9876543210";
const HELLO = { protocolVersion: 1, presentationUrl: `https://docs.google.com/open?id=${DECK}` };
const PROPOSAL = "p_1791115140000_seed01";
const NEWER_PROPOSAL = "p_1791118000000_seed02";
const READ_AT = "2026-10-04T12:00:00.000Z";
/** One minute after the logged `slides-staged`: the seeded evidence is fresh. */
const SOON_AFTER_STAGING = Date.parse("2026-10-04T12:00:00.000Z");

const stagedMark: ProposalMark = {
  proposalId: PROPOSAL,
  folderId: "folder_1",
  readyFileId: "ready_1",
  pickFileId: null,
  createdTime: "2026-10-04T11:59:00.000Z",
  manifestFileId: "manifest_1",
};

const newerMark: ProposalMark = {
  proposalId: NEWER_PROPOSAL,
  folderId: "folder_2",
  readyFileId: "ready_2",
  pickFileId: null,
  createdTime: "2026-10-04T12:30:00.000Z",
};

const manifestText = JSON.stringify({
  protocolVersion: 1,
  proposalId: PROPOSAL,
  createdAt: READ_AT,
  presentationId: DECK,
  count: 2,
  slides: [
    { index: 1, fileId: "html_1", name: "01.html", label: "option 1" },
    { index: 2, fileId: "html_2", name: "02.html", label: "option 2" },
  ],
  revision: 1,
});

const readyText = JSON.stringify({ protocolVersion: 1, proposalId: PROPOSAL, count: 2, manifestFileId: "manifest_1" });

const stagedEvent: RawEventFile = {
  fileId: "event_staged",
  name: "1791115140000-aaaaaa-slides-staged.json",
  text: JSON.stringify({ protocolVersion: 1, at: "2026-10-04T11:59:00.000Z", kind: "slides-staged", count: 2 }),
};

const revisedEvent: RawEventFile = {
  fileId: "event_revised",
  name: "1791115170000-bbbbbb-slide-revised.json",
  text: JSON.stringify({ protocolVersion: 1, at: "2026-10-04T11:59:30.000Z", kind: "slide-revised", slideIndex: 2, answers: [], revision: 2 }),
};

/** One remembered read exactly as Code.gs's `sashaRememberForSidebar_` stores it. */
function remembered(value: unknown, presentationId: string = DECK): unknown {
  return { presentationId, readAt: READ_AT, value };
}

/** The element's text exactly as Code.gs's `showSidebar` appends it. */
function bootText(rememberedReads: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ hello: HELLO, remembered: rememberedReads }).replace(/</g, "\\u003c");
}

/**
 * The newest set-changing event the sidebar had seen when it read the manifest -- the staging --
 * which is what the client sends with the read and Code.gs keeps beside it.
 */
const STAGED_EVENT_ID = newestSetChangeIn(
  sessionEventsOf({ files: [{ proposalId: PROPOSAL, ...stagedEvent }] }),
);

const FULL_BOOT = bootText({
  scan: remembered({ marks: [stagedMark] }),
  manifest: remembered({ forEventId: STAGED_EVENT_ID, texts: [{ fileId: "ready_1", text: readyText }, { fileId: "manifest_1", text: manifestText }] }),
  log: remembered({ folderId: "folder_1", events: [stagedEvent] }),
});

function seedOf(text: string): SidebarSeed {
  const parsed = parseSidebarBoot(text);
  assert.equal(parsed.kind, "ok");
  const seed = parsed.kind === "ok" ? sidebarSeedOf(parsed.value) : null;
  assert.ok(seed !== null, "the boot carries a seed");
  return seed;
}

function seeded(text: string = FULL_BOOT): Conversation {
  return reduceConversation(
    reduceConversation(INITIAL_CONVERSATION, { kind: "seeded", seed: seedOf(text) }),
    { kind: "clock-ticked", nowMs: SOON_AFTER_STAGING },
  );
}

function replay(events: readonly ConversationEvent[], from: Conversation): Conversation {
  return events.reduce(reduceConversation, from);
}

function freshLog(files: readonly RawEventFile[], proposalId: string = PROPOSAL): ConversationEvent {
  return {
    kind: "log-arrived",
    events: sessionEventsOf({ files: files.map((file) => ({ proposalId, ...file })) }),
    readAt: READ_AT,
    proposalId,
  };
}


// --- parseSidebarBoot / sidebarSeedOf ----------------------------------------------------------

test("a boot survives Code.gs's escaping and carries the scan, the manifest and the log", () => {
  assert.ok(!FULL_BOOT.includes("<"), "no '<' is left to end the inert element early");
  const seed = seedOf(FULL_BOOT);
  assert.deepEqual(seed.marks, [stagedMark]);
  assert.equal(seed.scanReadAt, READ_AT);
  assert.equal(seed.manifest?.manifest.proposalId, PROPOSAL, "the READY text is skipped, the manifest found");
  assert.ok(STAGED_EVENT_ID !== null);
  assert.equal(seed.manifest?.forEventId, STAGED_EVENT_ID);
  assert.deepEqual(seed.log?.events.map((event) => [event.proposalId, event.body.kind]), [[PROPOSAL, "slides-staged"]]);
});

test("ANOTHER DECK'S remembered reads are dropped, every one of them", () => {
  const text = bootText({
    scan: remembered({ marks: [stagedMark] }, OTHER_DECK),
    manifest: remembered({ forEventId: null, texts: [{ fileId: "manifest_1", text: manifestText }] }, OTHER_DECK),
    log: remembered({ folderId: "folder_1", events: [stagedEvent] }, OTHER_DECK),
    commentAccess: remembered({ access: "ready" }, OTHER_DECK),
  });
  const parsed = parseSidebarBoot(text);
  assert.deepEqual(parsed.kind === "ok" ? parsed.value.remembered : parsed, { scan: null, manifest: null, log: null, commentAccess: null });
  assert.equal(parsed.kind === "ok" ? sidebarSeedOf(parsed.value) : "invalid", null, "no scan, so no seed: the panel opens the old way");
  assert.deepEqual(parsed.kind === "ok" ? parsed.value.hello : null, HELLO, "the hello still saves its round trip");
});

test("a malformed remembered read is dropped on its own; a missing hello refuses the whole boot", () => {
  const text = bootText({
    scan: remembered({ marks: [stagedMark] }),
    manifest: { presentationId: DECK, readAt: "not a date", value: {} },
    log: remembered({ folderId: "", events: [] }),
  });
  const parsed = parseSidebarBoot(text);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind === "ok") {
    assert.notEqual(parsed.value.remembered.scan, null);
    assert.equal(parsed.value.remembered.manifest, null);
    assert.equal(parsed.value.remembered.log, null);
  }
  assert.equal(parseSidebarBoot("{").kind, "invalid");
  assert.equal(parseSidebarBoot(JSON.stringify({ remembered: {} })).kind, "invalid");
});

test("the remembered comment-access answer is this deck's, parsed, and dropped when it is not one", () => {
  const allowUrl = `https://sashaslides.com/comments/allow?deck=${DECK}`;
  // Columns: what Code.gs remembered -> what the panel is seeded with.
  const rows: readonly Readonly<{ label: string; value: unknown; expected: unknown }>[] = [
    { label: "needsAllow", value: { access: "needsAllow", allowUrl }, expected: { access: "needsAllow", allowUrl } },
    { label: "ready", value: { access: "ready" }, expected: { access: "ready" } },
    { label: "an unknown answer", value: { access: "maybe" }, expected: null },
    { label: "an allow link that is not https", value: { access: "needsAllow", allowUrl: "javascript:alert(1)" }, expected: null },
  ];
  for (const row of rows) {
    const parsed = parseSidebarBoot(bootText({ commentAccess: remembered(row.value) }));
    const read = parsed.kind === "ok" ? parsed.value.remembered.commentAccess : null;
    assert.deepEqual(read === null ? null : read.value, row.expected, row.label);
  }
});

test("a log from a folder the scan does not name is not seeded", () => {
  const seed = seedOf(
    bootText({
      scan: remembered({ marks: [stagedMark] }),
      log: remembered({ folderId: "folder_elsewhere", events: [stagedEvent] }),
    }),
  );
  assert.equal(seed.log, null);
});

// --- the seed in the state ---------------------------------------------------------------------

test("A SEEDED PANEL DRAWS AT ONCE: candidates and a connection line, no spinner, marked Updating", () => {
  const conversation = seeded();
  assert.equal(conversationIsOpening(conversation), false);
  assert.deepEqual(slidesOf(conversation).map((slide) => slide.label), ["option 1", "option 2"]);
  assert.equal(assistantConnectionOf(conversation).kind, "connected", "from the seeded log, not 'checking'");
  assert.equal(seedIsRefreshing(conversation), true);
  const markup = markupOf(conversation);
  assert.match(markup, /2 candidates/);
  assert.match(markup, /Connected to your assistant/);
  assert.match(markup, /class="sasha-header-refreshing"[^>]*>Updating</);
  assert.doesNotMatch(markup, /class="sasha-opening"/, "no spinner phase");
});

test("every seeded read is due AT ONCE, however recently the last session made it", () => {
  const conversation = seeded();
  assert.equal(needsStaged(conversation), true, "the scan");
  assert.equal(needsLog(conversation), true, "the log");
  assert.equal(needsManifest(conversation), false, "the manifest waits for the fresh log to say whether it changed");
});

test("the seed never opens the slides window by itself: that waits for the fresh reads", () => {
  const conversation = seeded();
  assert.equal(proposalToAutoOpen(conversation), null);
  const verified = replay(
    [{ kind: "staged-arrived", marks: [stagedMark], readAt: READ_AT }, freshLog([stagedEvent])],
    conversation,
  );
  assert.deepEqual(verified.seeded, NOTHING_SEEDED);
  assert.equal(proposalToAutoOpen(verified), PROPOSAL, "confirmed, it opens exactly as an unseeded panel would");
});

test("a fresh scan with the SAME newest proposal keeps the seeded set and confirms it", () => {
  const confirmed = reduceConversation(seeded(), { kind: "staged-arrived", marks: [stagedMark], readAt: READ_AT });
  assert.equal(confirmed.seeded.scan, false);
  assert.deepEqual(slidesOf(confirmed).map((slide) => slide.slideIndex), [1, 2], "nothing blinks");
  assert.equal(confirmed.set.kind === "following" ? confirmed.set.manifest.kind : "none", "loaded");
});

test("A FRESH 'NOTHING STAGED' REPLACES THE SEEDED LIST, sticky set or not", () => {
  const answered: ProposalMark = { ...stagedMark, pickFileId: "pick_1" };
  for (const marks of [[], [answered]]) {
    const fresh = reduceConversation(seeded(), { kind: "staged-arrived", marks, readAt: READ_AT });
    assert.equal(fresh.set.kind, "none", `marks: ${JSON.stringify(marks)}`);
    assert.deepEqual(slidesOf(fresh), []);
    assert.deepEqual(slidesReachability(fresh), { kind: "nothing-staged" });
    assert.deepEqual(fresh.seeded, NOTHING_SEEDED);
    assert.equal(fresh.log.kind, "unrequested", "the seeded set's log is gone with it");
    assert.match(markupOf(fresh), /No candidate slides yet/);
  }
});

test("a fresh scan with a DIFFERENT newest proposal follows it, and nothing of the seeded set survives", () => {
  const fresh = reduceConversation(seeded(), { kind: "staged-arrived", marks: [stagedMark, newerMark], readAt: READ_AT });
  assert.equal(fresh.set.kind === "following" ? fresh.set.proposalId : null, NEWER_PROPOSAL);
  assert.equal(fresh.set.kind === "following" ? fresh.set.manifest.kind : null, "unrequested");
  assert.equal(needsManifest(fresh), true);
  assert.equal(needsLog(fresh), true);
  assert.deepEqual(slidesOf(fresh), []);
  // The seeded set's reads that were in flight land on a set they are not about, and are dropped.
  const lateLog = reduceConversation(fresh, freshLog([stagedEvent]));
  assert.equal(lateLog, fresh, "the old set's log");
  const lateManifest = reduceConversation(fresh, {
    kind: "manifest-arrived",
    manifest: seedOf(FULL_BOOT).manifest?.manifest ?? assert.fail("seeded manifest"),
  });
  assert.equal(lateManifest, fresh, "the old set's manifest");
});

test("a seeded 'connected' that the fresh log contradicts flips to nothing-listening", () => {
  const conversation = seeded();
  assert.equal(assistantConnectionOf(conversation).kind, "connected");
  // The fresh read finds the log empty (the events were cleared since): no evidence at all.
  const contradicted = replay(
    [{ kind: "staged-arrived", marks: [stagedMark], readAt: READ_AT }, { kind: "log-requested" }, freshLog([])],
    conversation,
  );
  assert.equal(assistantConnectionOf(contradicted).kind, "nothing-listening");
  assert.equal(contradicted.seeded.log, false);
});

test("while the fresh log is in flight the seeded connection stays on screen, not 'checking'", () => {
  const inFlight = reduceConversation(seeded(), { kind: "log-requested" });
  assert.equal(assistantConnectionOf(inFlight).kind, "connected");
});

test("THE FRESH LOG VERIFIES THE SEEDED MANIFEST: same set-change, kept; a newer one, read again", () => {
  const scanned = reduceConversation(seeded(), { kind: "staged-arrived", marks: [stagedMark], readAt: READ_AT });
  const same = reduceConversation(scanned, freshLog([stagedEvent]));
  assert.equal(same.seeded.manifest, false, "current: no extra round trip");
  assert.equal(needsManifest(same), false);
  assert.equal(seedIsRefreshing(same), false, "and the Updating marker is gone");

  const changed = reduceConversation(scanned, freshLog([stagedEvent, revisedEvent]));
  assert.equal(changed.seeded.manifest, true, "still the seed's until it is read again");
  assert.equal(needsManifest(changed), true);
  const reread = replay(
    [
      { kind: "manifest-requested" },
      { kind: "manifest-arrived", manifest: seedOf(FULL_BOOT).manifest?.manifest ?? assert.fail("seeded manifest") },
    ],
    changed,
  );
  assert.equal(reread.seeded.manifest, false);
  assert.equal(seedIsRefreshing(reread), false);
});

test("a seed arriving after a fresh read changes nothing", () => {
  const fresh = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [], readAt: READ_AT });
  assert.equal(reduceConversation(fresh, { kind: "seeded", seed: seedOf(FULL_BOOT) }), fresh);
});

test("a seed with only a scan opens without a spinner and reads the manifest and log at once", () => {
  const conversation = seeded(bootText({ scan: remembered({ marks: [stagedMark] }) }));
  assert.equal(conversationIsOpening(conversation), false);
  assert.equal(needsManifest(conversation), true);
  assert.equal(needsLog(conversation), true, "an unread log of the seeded set is read at once");
  assert.equal(assistantConnectionOf(conversation).kind, "checking", "nothing claimed without a log");
});

// --- Code.gs -----------------------------------------------------------------------------------

const CODE = codeGs({ editorOrigin: DEFAULT_EDITOR_ORIGIN });

function functionBody(name: string): string {
  const start = CODE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in Code.gs`);
  const end = CODE.indexOf("\n}\n", start);
  return CODE.slice(start, end);
}

test("Code.gs: showSidebar appends the seed as an inert, escaped element before showing the page", () => {
  const body = functionBody("showSidebar");
  assert.match(body, /var boot = sashaSidebarBoot_\(\);/);
  assert.ok(body.includes(`if (boot) sashaAppendSeed_(page, "${SIDEBAR_SEED_ELEMENT_ID}", boot);`), body);
  assert.ok(body.indexOf("sashaAppendSeed_") < body.indexOf("showSidebar(page)"), "appended before it is shown");
  assert.ok(
    functionBody("sashaAppendSeed_").includes(
      `page.append('<script type="text/plain" id="' + id + '">' + JSON.stringify(value).replace(/</g, '\\\\u003c') + '</script>');`,
    ),
    "one inert element, every '<' escaped",
  );
  const boot = functionBody("sashaSidebarBoot_");
  assert.match(boot, /hello = sashaHello\(\);/);
  assert.match(boot, /CacheService\.getUserCache\(\)\.getAll\(keys\)/, "one cache read for every slot");
  assert.match(boot, /return \{ hello: hello, remembered: remembered \};/);
});

test("Code.gs: the sidebar's three reads remember themselves, only when asked, keyed by deck", () => {
  assert.match(functionBody("sashaScanInbox"), /if \(spec && spec\.rememberForSidebar\) sashaRememberForSidebar_\('scan', reply\);/);
  assert.match(functionBody("sashaReadTexts"), /sashaRememberForSidebar_\('manifest', \{\s*forEventId: spec\.rememberForSidebar\.forEventId \|\| null,/);
  assert.match(functionBody("sashaReadEvents"), /sashaRememberForSidebar_\('log', \{ folderId: spec\.folderId, events: events \}\)/);
  const remember = functionBody("sashaRememberForSidebar_");
  assert.match(remember, /presentationId: presentationId,/, "every copy names its deck");
  assert.match(remember, /cache\.put\(key, text, SASHA_SIDEBAR_MEMORY_SECONDS\)/);
  assert.match(remember, /catch \(rememberError\)/, "never fails the read it rides on");
  assert.doesNotMatch(remember, /getOAuthToken/, "nothing secret is kept");
  assert.match(functionBody("sashaSidebarMemoryKey_"), /spec\.presentationId/);
});

test("the remembered reads stay inside CacheService's limits (100 KB a value, 6 hours)", () => {
  assert.ok(SIDEBAR_MEMORY_MAXIMUM_CHARACTERS < 100 * 1024);
  assert.ok(SIDEBAR_MEMORY_SECONDS <= 21_600);
  assert.match(CODE, new RegExp(`var SASHA_SIDEBAR_MEMORY_MAXIMUM_CHARACTERS = ${SIDEBAR_MEMORY_MAXIMUM_CHARACTERS};`));
});

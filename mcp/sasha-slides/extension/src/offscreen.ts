// The offscreen document: the composition root for everything with a lifetime. It owns the Drive
// poll loop, the cached OAuth access token, every authorized HTTP call, and the set of connected
// Google Slides tabs. See wire.ts for why none of this may live in the service worker.
//
// !! MEASURED ON CHROME 154, AND IT BREAKS THIS FILE AS WRITTEN: an offscreen document does NOT
// !! get the extension API surface an extension page gets. `Object.keys(chrome)` in the service
// !! worker lists dom/extension/i18n/identity/management/offscreen/permissions/runtime/storage/
// !! tabs/windows; in the offscreen document `chrome.storage` and `chrome.identity` are both
// !! `undefined` and even `chrome.runtime.getManifest()` throws. Only `chrome.runtime` messaging is
// !! there. So `readChannelChoice()` (chrome.storage.local) and `chromeWebAuthFlow()`
// !! (chrome.identity) cannot run here -- the smoke test fails with
// !! "TypeError: Cannot read properties of undefined (reading 'local') at readChannelChoice".
// !! The fix is to proxy both through the service worker over the port it already brokers, which is
// !! deliberately NOT done yet: if storage and auth have to live in the service worker anyway, the
// !! offscreen document only buys the sub-30 s poll timer, and that is an argument for the Apps
// !! Script sidebar instead. nanobox's offscreen document never hit this because it uses only
// !! fetch/WebSocket/chrome.runtime.
//
// It is the only context with a DOMParser for the candidate-HTML check -- which is the offscreen
// reason the manifest declares.

import type { DriveApi, SlidesApi } from "./drive-api.ts";
import { openChannel, readChannelChoice } from "./drive-channel.ts";
import { systemClock } from "./google-identity.ts";
import { checkSlideHtml, domSlideDocumentParser } from "./html-check.ts";
import type { Proposal } from "./observer.ts";
import { createObserver, type Announcer, type Observer, type PollTimer, type SeenStore } from "./observer-runtime.ts";
import { writePick } from "./pick-writer.ts";
import { writeRenderArtifact } from "./render-artifact.ts";
import { PROTOCOL_VERSION, assertNever } from "./protocol.ts";
import { OFFSCREEN_PORT_PREFIX, asWireMessage, isUpstream, type Downstream, type Upstream } from "./wire.ts";

type Viewer = { readonly port: chrome.runtime.Port; visible: boolean };

const SEEN_STORAGE_KEY = "seenProposalIds";
const viewers = new Map<string, Viewer>();
/** Candidate HTML is immutable once READY, so one fetch per fileId serves every tab and every toggle. */
const htmlByFileId = new Map<string, string>();

const announcer: Announcer = {
  proposal(proposal) {
    broadcast({ type: "proposal", proposal });
  },
  trouble(message) {
    broadcast({ type: "trouble", message });
  },
};

const pollTimer = singlePollTimer();
const seenStore = storageSeenStore();
const parseSlideDocument = domSlideDocumentParser();

let services: Readonly<{ drive: DriveApi; slides: SlidesApi; observer: Observer }> | null = null;
let startingServices: Promise<void> | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(OFFSCREEN_PORT_PREFIX)) return;
  const sessionId = port.name.slice(OFFSCREEN_PORT_PREFIX.length);
  viewers.set(sessionId, { port, visible: false });
  port.onMessage.addListener((message: unknown) => {
    if (!isUpstream(message)) {
      console.warn("[sasha-slides] offscreen dropped an unrecognized message", asWireMessage(message)?.["type"]);
      return;
    }
    void onUpstream({ sessionId, message });
  });
  port.onDisconnect.addListener(() => {
    viewers.delete(sessionId);
    void announceViewers();
  });
  send(port, { type: "offscreen-ready" });
});

async function onUpstream({ sessionId, message }: { sessionId: string; message: Upstream }): Promise<void> {
  switch (message.type) {
    case "hello":
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        reply(sessionId, { type: "trouble", message: `this tab speaks protocolVersion ${message.protocolVersion}` });
        return;
      }
      setVisibility({ sessionId, visible: message.visible });
      await startServices();
      await announceViewers();
      return;
    case "visibility":
      setVisibility({ sessionId, visible: message.visible });
      await announceViewers();
      return;
    case "request-slide-html":
      await onSlideHtmlRequested({ sessionId, message });
      return;
    case "insert":
      await onInsertRequested({ sessionId, message });
      return;
    case "decide":
      await onDecided({ sessionId, message });
      return;
    default:
      return assertNever(message);
  }
}

async function onSlideHtmlRequested({
  sessionId,
  message,
}: {
  sessionId: string;
  message: Readonly<{ proposalId: string; index: number }>;
}): Promise<void> {
  const running = await startServices();
  if (running === null) return;
  const offered = offeredProposal(running.observer);
  const slide = offered?.proposalId === message.proposalId ? offered.slides[message.index - 1] : undefined;
  if (slide === undefined) {
    reply(sessionId, {
      type: "slide-html-failed",
      proposalId: message.proposalId,
      index: message.index,
      message: `slide ${message.index} is not part of the offered proposal`,
    });
    return;
  }
  const cached = htmlByFileId.get(slide.fileId);
  if (cached !== undefined) {
    reply(sessionId, { type: "slide-html", proposalId: message.proposalId, index: message.index, html: cached });
    return;
  }
  const downloaded = await running.drive.downloadText(slide.fileId);
  if (downloaded.kind !== "ok") {
    reply(sessionId, {
      type: "slide-html-failed",
      proposalId: message.proposalId,
      index: message.index,
      message: `${downloaded.kind}: ${downloaded.message}`,
    });
    return;
  }
  // The protocol invariant is checked once, here, rather than in every tab that renders it.
  const checked = checkSlideHtml({ html: downloaded.value, parse: parseSlideDocument });
  for (const warning of checked.warnings) {
    console.warn(`[sasha-slides] ${slide.name}: ${warning}`);
  }
  htmlByFileId.set(slide.fileId, downloaded.value);
  reply(sessionId, {
    type: "slide-html",
    proposalId: message.proposalId,
    index: message.index,
    html: downloaded.value,
  });
}

async function onInsertRequested({
  sessionId,
  message,
}: {
  sessionId: string;
  message: Extract<Upstream, { type: "insert" }>;
}): Promise<void> {
  const running = await startServices();
  if (running === null) return;
  const offered = offeredProposal(running.observer);
  const outcome = await running.slides.batchUpdate({
    presentationId: message.presentationId,
    requests: message.requests,
  });
  if (outcome.kind !== "ok") {
    reply(sessionId, {
      type: "insert-failed",
      proposalId: message.proposalId,
      message: `${outcome.kind}: ${outcome.message}`,
    });
    return;
  }
  // From here on the slide IS in the user's deck, so nothing below may be reported as a failure --
  // the user must not be invited to insert it twice. See render-artifact.ts.
  const renderArtifact =
    offered === null || offered.proposalId !== message.proposalId
      ? null
      : await renderArtifactName({ running, proposal: offered, message });
  reply(sessionId, {
    type: "inserted",
    proposalId: message.proposalId,
    objectIds: outcome.value,
    renderArtifact,
  });
}

async function renderArtifactName({
  running,
  proposal,
  message,
}: {
  running: Readonly<{ drive: DriveApi; slides: SlidesApi }>;
  proposal: Proposal;
  message: Extract<Upstream, { type: "insert" }>;
}): Promise<string | null> {
  const written = await writeRenderArtifact({
    drive: running.drive,
    slides: running.slides,
    proposalId: proposal.proposalId,
    folderId: proposal.folderId,
    index: message.index,
    presentationId: message.presentationId,
    pageObjectId: message.pageObjectId,
  });
  if (written.kind === "written") return written.name;
  console.warn(`[sasha-slides] no render artifact for option ${message.index}: ${written.reason}`);
  return null;
}

async function onDecided({
  sessionId,
  message,
}: {
  sessionId: string;
  message: Extract<Upstream, { type: "decide" }>;
}): Promise<void> {
  const running = await startServices();
  if (running === null) return;
  const offered = offeredProposal(running.observer);
  if (offered === null || offered.proposalId !== message.proposalId) {
    reply(sessionId, {
      type: "decide-failed",
      proposalId: message.proposalId,
      message: "that proposal is no longer the offered one",
    });
    return;
  }
  const outcome = await writePick({
    drive: running.drive,
    proposal: offered,
    decision: {
      picked: message.picked,
      insertedObjectIds: message.insertedObjectIds,
      anomalies: message.anomalies,
    },
    decidedAt: new Date(systemClock.nowMs()).toISOString(),
  });
  switch (outcome.kind) {
    case "written":
      running.observer.dispatch({ kind: "resolved", proposalId: message.proposalId, nowMs: systemClock.nowMs() });
      broadcast({ type: "decided", proposalId: message.proposalId });
      return;
    case "refused":
      reply(sessionId, { type: "decide-failed", proposalId: message.proposalId, message: outcome.reason });
      return;
    case "failed":
      reply(sessionId, { type: "decide-failed", proposalId: message.proposalId, message: outcome.message });
      return;
    default:
      return assertNever(outcome);
  }
}

/** Built once, on the first `hello`, so a browser with no Slides tab open never asks for a token. */
function startServices(): Promise<Readonly<{ drive: DriveApi; slides: SlidesApi; observer: Observer }> | null> {
  if (services !== null) return Promise.resolve(services);
  if (startingServices === null) {
    startingServices = buildServices().finally(() => {
      startingServices = null;
    });
  }
  return startingServices.then(() => services);
}

async function buildServices(): Promise<void> {
  const choice = await readChannelChoice();
  if (choice.kind !== "ok") {
    const reason = choice.kind === "invalid" ? choice.reason : "unsupported channel record";
    broadcast({ type: "trouble", message: reason });
    return;
  }
  // The ONE place the Drive transport is chosen. See drive-channel.ts for the two options and
  // which one this component recommends.
  const { drive, slides } = openChannel(choice.value);
  const observer = createObserver({
    drive,
    announcer,
    timer: pollTimer,
    seen: seenStore,
    log: { warn: (message) => console.warn(`[sasha-slides] ${message}`) },
    nowMs: systemClock.nowMs,
  });
  await observer.start();
  services = { drive, slides, observer };
}

function offeredProposal(observer: Observer): Proposal | null {
  const phase = observer.snapshot().phase;
  return phase.kind === "offering" ? phase.proposal : null;
}

async function announceViewers(): Promise<void> {
  const running = services;
  if (running === null) return;
  running.observer.dispatch({
    kind: "viewers-changed",
    viewers: { count: viewers.size, anyVisible: [...viewers.values()].some((viewer) => viewer.visible) },
    nowMs: systemClock.nowMs(),
  });
  await running.observer.settled();
}

function setVisibility({ sessionId, visible }: { sessionId: string; visible: boolean }): void {
  const viewer = viewers.get(sessionId);
  if (viewer === undefined) return;
  viewer.visible = visible;
}

function reply(sessionId: string, message: Downstream): void {
  const viewer = viewers.get(sessionId);
  if (viewer === undefined) return;
  send(viewer.port, message);
}

function broadcast(message: Downstream): void {
  for (const viewer of viewers.values()) send(viewer.port, message);
}

function send(port: chrome.runtime.Port, message: Downstream): void {
  try {
    port.postMessage(message);
  } catch {
    /* the tab went away between the lookup and the send */
  }
}

/** One pending poll at a time; scheduling again replaces it, which is what a cadence change needs. */
function singlePollTimer(): PollTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule({ delayMs, fire }) {
      if (handle !== null) clearTimeout(handle);
      handle = setTimeout(() => {
        handle = null;
        fire();
      }, delayMs);
    },
    cancel() {
      if (handle === null) return;
      clearTimeout(handle);
      handle = null;
    },
  };
}

function storageSeenStore(): SeenStore {
  return {
    async read() {
      const stored = await chrome.storage.local.get(SEEN_STORAGE_KEY);
      const value = stored[SEEN_STORAGE_KEY];
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    },
    async write(seenProposalIds) {
      await chrome.storage.local.set({ [SEEN_STORAGE_KEY]: [...seenProposalIds] });
    },
  };
}

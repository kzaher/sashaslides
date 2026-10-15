// ASK SASHA'S HEAD START: what the sidebar last read on this deck, handed back to it when it opens.
//
// MEASURED 2026-10-15 on the live deck, from the click on "Ask Sasha": the panel's page was up at
// 2.05 s and showed a spinner; the candidates appeared at 4.58 s (after `sashaScanInbox`, 1.1-2.9 s
// of server time plus ~0.7 s of fixed `google.script.run` overhead) and the connection line at
// ~6.4 s (after `sashaReadEvents`, which could only start once `sashaHello` and the scan had both
// answered). Every one of those answers had been read before, by the previous time the panel was
// open.
//
// So the server remembers them. The sidebar's own scan, manifest and log reads ask Code.gs to keep
// a copy in `CacheService.getUserCache()`, keyed by the deck (a cheap put beside a read that was
// happening anyway), and `showSidebar` appends the copies to the page as an inert JSON block --
// with `sashaHello`'s answer, which it computes without a round trip -- exactly as `showPicker`
// seeds the slides window (picker-seed.ts). The panel draws from it at once and re-reads all of it
// in parallel immediately.
//
// A SEED IS A HEAD START, NEVER THE TRUTH. Every remembered read carries the deck it was read on and
// is dropped when that is not this deck; anything malformed is dropped on its own rather than
// taking the rest with it; and what conversation-state.ts does with the rest is mark it `seeded`,
// so it is replaced by the fresh reads and acted on only once they confirm it.
//
// The connector's comment-access answer rides along the same way (`commentAccess`), so the "Let
// Sasha answer comments" card is right on the first paint (comment-access-state.ts).
//
// NOTHING SECRET IS IN IT: Drive ids, proposal names, manifest and event bytes the user's own
// sidebar read, and the comment-access answer (a public page address at most) -- never a token. The user cache is private to this user and this script.

import {
  parseHelloReply,
  parseReadEventsReply,
  parseScanReply,
  presentationIdOf,
  type HelloReply,
  type ProposalMark,
  type RawEventFile,
} from "./bridge.ts";
import type { SidebarSeed } from "./conversation-state.ts";
import { parseCommentAccessAnswer, type CommentAccessAnswer } from "../../comment-bot/comment-access-contract.ts";
import { parseManifest, type Manifest, type Parsed } from "./protocol.ts";
import { sessionEventsOf } from "./session-log.ts";

/** The id of the inert element `showSidebar` appends to the panel's page. */
export const SIDEBAR_SEED_ELEMENT_ID = "sasha-sidebar-seed";

/** One remembered read: when it was made, and its reply. */
export type RememberedRead<TValue> = Readonly<{ readAt: string; value: TValue }>;

export type RememberedManifest = Readonly<{ forEventId: string | null; texts: readonly string[] }>;
export type RememberedLog = Readonly<{ folderId: string; events: readonly RawEventFile[] }>;

/** What the panel finds in its page. Each remembered read is null when absent, stale or another deck's. */
export type SidebarBoot = Readonly<{
  hello: HelloReply;
  remembered: Readonly<{
    scan: RememberedRead<readonly ProposalMark[]> | null;
    manifest: RememberedRead<RememberedManifest> | null;
    log: RememberedRead<RememberedLog> | null;
    /** Whether Sasha could answer this deck's comments last time (comment-access-state.ts). */
    commentAccess: RememberedRead<CommentAccessAnswer> | null;
  }>;
}>;

/**
 * Parse the element Code.gs appended. Only the hello is required: without it the panel asks the
 * server as it always did. Each remembered read is checked on its own, and one written on another
 * deck is dropped.
 */
export function parseSidebarBoot(text: string): Parsed<SidebarBoot> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "the sidebar seed is not JSON" };
  }
  const record = asRecord(json);
  if (record === null) return { kind: "invalid", reason: "the sidebar seed is not an object" };
  const hello = parseHelloReply(record["hello"]);
  if (hello.kind !== "ok") return hello;
  const deck = presentationIdOf(hello.value.presentationUrl);
  const remembered = asRecord(record["remembered"]);
  const entry = (slot: string): RememberedRead<unknown> | null =>
    deck === null || remembered === null ? null : rememberedReadOf({ value: remembered[slot], deck });
  return {
    kind: "ok",
    value: {
      hello: hello.value,
      remembered: {
        scan: mapRead(entry("scan"), (value) => {
          const parsed = parseScanReply(value);
          return parsed.kind === "ok" ? parsed.value.marks : null;
        }),
        manifest: mapRead(entry("manifest"), rememberedManifestOf),
        log: mapRead(entry("log"), rememberedLogOf),
        commentAccess: mapRead(entry("commentAccess"), parseCommentAccessAnswer),
      },
    },
  };
}

/**
 * The seed as the reducer takes it, or null when there is no remembered SCAN -- without one there
 * is no set to draw, and the panel opens the way it always did. The log's events are parsed for
 * the proposal whose folder it was read from, which only the scan can name.
 */
export function sidebarSeedOf(boot: SidebarBoot): SidebarSeed | null {
  const scan = boot.remembered.scan;
  if (scan === null) return null;
  const log = boot.remembered.log;
  const logMark = log === null ? undefined : scan.value.find((mark) => mark.folderId === log.value.folderId);
  return {
    marks: scan.value,
    scanReadAt: scan.readAt,
    manifest: manifestOf(boot.remembered.manifest),
    log:
      log === null || logMark === undefined
        ? null
        : {
            folderId: log.value.folderId,
            readAt: log.readAt,
            events: sessionEventsOf({
              files: log.value.events.map((file) => ({ proposalId: logMark.proposalId, ...file })),
            }),
          },
  };
}

/** READY and the manifest were read together; the manifest is whichever text parses as one. */
function manifestOf(
  remembered: RememberedRead<RememberedManifest> | null,
): Readonly<{ manifest: Manifest; forEventId: string | null }> | null {
  if (remembered === null) return null;
  for (const text of remembered.value.texts) {
    const parsed = parseManifest(text);
    if (parsed.kind === "ok") return { manifest: parsed.value, forEventId: remembered.value.forEventId };
  }
  return null;
}

/** `{ presentationId, readAt, value }` as Code.gs's `sashaRememberForSidebar_` writes it, for THIS deck only. */
function rememberedReadOf({ value, deck }: { value: unknown; deck: string }): RememberedRead<unknown> | null {
  const record = asRecord(value);
  if (record === null || record["presentationId"] !== deck) return null;
  const readAt = record["readAt"];
  if (typeof readAt !== "string" || !Number.isFinite(Date.parse(readAt))) return null;
  return { readAt, value: record["value"] };
}

function mapRead<TValue>(
  read: RememberedRead<unknown> | null,
  parse: (value: unknown) => TValue | null,
): RememberedRead<TValue> | null {
  if (read === null) return null;
  const value = parse(read.value);
  return value === null ? null : { readAt: read.readAt, value };
}

function rememberedManifestOf(value: unknown): RememberedManifest | null {
  const record = asRecord(value);
  const texts = record?.["texts"];
  if (record === null || !Array.isArray(texts)) return null;
  const forEventId = record["forEventId"];
  if (forEventId !== null && typeof forEventId !== "string") return null;
  const strings: string[] = [];
  for (const entry of texts) {
    const text = asRecord(entry)?.["text"];
    if (typeof text === "string") strings.push(text);
  }
  return { forEventId, texts: strings };
}

function rememberedLogOf(value: unknown): RememberedLog | null {
  const record = asRecord(value);
  const folderId = record?.["folderId"];
  if (typeof folderId !== "string" || folderId === "") return null;
  const parsed = parseReadEventsReply(value);
  return parsed.kind === "ok" ? { folderId, events: parsed.value.events } : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

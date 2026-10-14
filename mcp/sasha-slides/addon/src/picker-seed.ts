// THE SLIDES WINDOW'S HEAD START: what the sidebar already knows, handed to the window it opens.
//
// MEASURED 2026-10-11 on the deployed add-on (e2e/open-latency.ts): "Open slide 2" took 9.8 s
// from press to every candidate drawn, and 7.7 s of it was six `google.script.run` calls in
// series -- sashaHello 0.84 s, sashaScanInbox 2.7 s, READY 1.37 s, manifest 1.40 s, then the
// NN.html reads 1.0-1.56 s -- each paying ~0.7 s of fixed round-trip overhead. The sidebar had
// already read every one of those answers to draw its own thumbnails.
//
// So the sidebar sends them WITH `sashaOpenPicker`, Code.gs appends them to the window's page as
// an inert JSON block (with `sashaHello`'s answer, which it can compute without a round trip),
// and the window draws the candidates from it at once. The window's own observer still starts
// and polls as before -- a seed is a head start, never the source of truth: re-offering the same
// proposal is a no-op in `reducePicker`, and a newer proposal replaces it exactly as it would have.
//
// THE HTML IS CAPPED. It travels as a `google.script.run` argument and then inside the window's
// page, which already carries a ~500 KB bundle; candidates past the cap are simply not seeded and
// the window fetches them the old way.

import { parseHelloReply, type HelloReply } from "./bridge.ts";
import type { Conversation } from "./conversation-state.ts";
import type { Proposal } from "./observer.ts";
import { parseMergeSpec, parseSlides, type Parsed } from "./protocol.ts";
import { previewOf, type SlidePreviews } from "./slide-previews.ts";

export type SeedHtml = Readonly<{ index: number; html: string }>;

/** What the sidebar sends. `slideIndex` is the candidate the window should open on, or null for the grid. */
export type PickerSeed = Readonly<{ proposal: Proposal; slideIndex: number | null; html: readonly SeedHtml[] }>;

/** What the window finds in its page: the seed plus Code.gs's `sashaHello` answer. */
export type BootSeed = Readonly<{ hello: HelloReply; seed: PickerSeed }>;

/** The id of the inert element Code.gs appends to the slides window's page. */
export const SEED_ELEMENT_ID = "sasha-seed";

/** Total seeded HTML, in characters. Generous for typical 2-20 KB candidates, small next to the bundle. */
export const SEED_HTML_BUDGET = 200 * 1024;

/**
 * The seed for the followed set, or null when the sidebar does not yet know enough (no set, or its
 * manifest not read) -- the window then boots the old way. The candidate being opened is seeded
 * first so the budget never drops the one the user asked for.
 */
export function pickerSeedOf({
  conversation,
  previews,
  slideIndex,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  slideIndex: number | null;
}): PickerSeed | null {
  const set = conversation.set;
  if (set.kind !== "following" || set.manifest.kind !== "loaded") return null;
  const manifest = set.manifest;
  const slides = set.slides;
  if (slides.length !== manifest.count) return null;
  const proposal: Proposal = {
    proposalId: set.proposalId,
    folderId: set.folderId,
    presentationId: manifest.presentationId,
    count: manifest.count,
    slides: slides.map((slide) => ({ index: slide.slideIndex, fileId: slide.fileId, name: slide.name, label: slide.label })),
    revision: manifest.revision,
    merge: manifest.merge,
  };
  const order = [...slides].sort((left, right) => rank(left.slideIndex) - rank(right.slideIndex));
  function rank(index: number): number {
    return index === slideIndex ? 0 : index;
  }
  const html: SeedHtml[] = [];
  let spent = 0;
  for (const slide of order) {
    const preview = previewOf({ conversation, previews, slideIndex: slide.slideIndex });
    if (preview.kind !== "ready") continue;
    if (spent + preview.html.length > SEED_HTML_BUDGET) continue;
    spent += preview.html.length;
    html.push({ index: slide.slideIndex, html: preview.html });
  }
  return { proposal, slideIndex, html };
}

/** Parse the element Code.gs appended. Anything wrong means "no seed", never a broken window. */
export function parseBootSeed(text: string): Parsed<BootSeed> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "the seed is not JSON" };
  }
  const record = asRecord(json);
  if (record === null) return { kind: "invalid", reason: "the seed is not an object" };
  const hello = parseHelloReply(record["hello"]);
  if (hello.kind !== "ok") return hello;
  const seed = asRecord(record["seed"]);
  if (seed === null) return { kind: "invalid", reason: "the seed has no seed object" };
  const proposal = parseProposal(seed["proposal"]);
  if (proposal.kind !== "ok") return proposal;
  const slideIndex = seed["slideIndex"];
  const html = parseSeedHtml({ field: seed["html"], count: proposal.value.count });
  if (html.kind !== "ok") return html;
  return {
    kind: "ok",
    value: {
      hello: hello.value,
      seed: {
        proposal: proposal.value,
        slideIndex: slideIndexOf({ value: slideIndex, count: proposal.value.count }),
        html: html.value,
      },
    },
  };
}

function parseProposal(field: unknown): Parsed<Proposal> {
  const record = asRecord(field);
  if (record === null) return { kind: "invalid", reason: "the seed has no proposal" };
  const proposalId = record["proposalId"];
  const folderId = record["folderId"];
  const presentationId = record["presentationId"];
  const count = record["count"];
  if (typeof proposalId !== "string" || proposalId === "") return { kind: "invalid", reason: "the seed proposal has no id" };
  if (typeof folderId !== "string" || folderId === "") return { kind: "invalid", reason: "the seed proposal has no folder" };
  if (presentationId !== null && typeof presentationId !== "string") {
    return { kind: "invalid", reason: "the seed proposal's presentationId is not a string" };
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { kind: "invalid", reason: "the seed proposal has no count" };
  }
  const slides = parseSlides(record["slides"]);
  if (slides.kind !== "ok") return slides;
  // The same rule the manifest parser enforces: candidates are 1..count, in order, no holes.
  if (slides.value.length !== count || slides.value.some((slide, position) => slide.index !== position + 1)) {
    return { kind: "invalid", reason: `the seed proposal's slides are not 1..${count} in order` };
  }
  // A MALFORMED merge refuses the whole seed rather than seeding the proposal as an insert: the
  // window then boots the old way and reads the manifest itself.
  const merge = parseMergeSpec(record["merge"]);
  if (merge.kind !== "ok") return merge;
  // Absent from a seed written before the field existed; null then means "compare nothing".
  const revision = record["revision"];
  return {
    kind: "ok",
    value: {
      proposalId,
      folderId,
      presentationId,
      count,
      slides: slides.value,
      revision: typeof revision === "number" && Number.isInteger(revision) ? revision : null,
      merge: merge.value,
    },
  };
}

function parseSeedHtml({ field, count }: { field: unknown; count: number }): Parsed<readonly SeedHtml[]> {
  if (!Array.isArray(field)) return { kind: "invalid", reason: "the seed html is not an array" };
  const entries: SeedHtml[] = [];
  for (const candidate of field) {
    const record = asRecord(candidate);
    const index = slideIndexOf({ value: record?.["index"], count });
    const html = record?.["html"];
    if (index === null || typeof html !== "string") {
      return { kind: "invalid", reason: "a seeded candidate has no index or html" };
    }
    entries.push({ index, html });
  }
  return { kind: "ok", value: entries };
}

function slideIndexOf({ value, count }: { value: unknown; count: number }): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= count ? value : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

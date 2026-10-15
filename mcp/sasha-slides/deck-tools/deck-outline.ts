/**
 * WHAT `deck_read` ANSWERS: the deck as a model needs it to address things -- ids, kinds, frames
 * and plain text -- not the Yjs structure (assistant-deck-tools.ts "read returns ids and plain
 * text"). `detail: "full"` adds the complete slide values of the slides asked for, for the rare
 * edit that needs an exact style.
 *
 * Builds are addressed like elements: each slide lists its steps in play order with their ids
 * (`animations`, the snapshot's own values), and each element its `morphKey`, the key the morph
 * transition pairs elements by, so a model can see which elements already glide into each other.
 */
import type { DeckOutline, ElementOutline, SlideOutline } from "../engine/src/contracts/assistant-deck-tools.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { DeckRole } from "../engine/src/contracts/deck-access.ts";
import type { DeckSummary } from "../engine/src/contracts/deck-api.ts";
import type { DiscussionSnapshot } from "../engine/src/contracts/discussion.ts";
import { plainText, scriptFingerprint, type DocumentSnapshot, type ElementSnapshot, type SlideSnapshot, type SlideTransition, type TransitionAuthor } from "../engine/src/contracts/document.ts";
import type { SlideId } from "../engine/src/contracts/ids.ts";

export function deckOutline(
  options: Readonly<{
    snapshot: DocumentSnapshot;
    summary: DeckSummary;
    role: DeckRole;
    address: string;
    discussion: DiscussionSnapshot;
    /** Slides whose complete values to add; empty for an outline. */
    fullSlideIds: readonly SlideId[];
  }>,
): DeckOutline {
  const { snapshot } = options;
  const full = new Set<SlideId>(options.fullSlideIds);
  return {
    deckId: options.summary.deckId,
    title: snapshot.title,
    role: options.role,
    address: options.address,
    pageWidth: snapshot.pageSize.width,
    pageHeight: snapshot.pageSize.height,
    layouts: snapshot.layouts.map((layout) => ({
      layoutId: layout.id,
      name: layout.name,
      placeholders: layout.elements.flatMap((element) => (element.placeholder === null ? [] : [element.placeholder.role])),
    })),
    slides: snapshot.slides.map((slide, index) => slideOutline({ slide, number: index + 1 })),
    transitionScripts: snapshot.transitionScripts.map((script) => ({
      scriptId: script.id,
      name: script.name,
      approved: isApproved({ approval: script.approval, fingerprint: scriptFingerprint(script) }),
      authorName: authorName({ author: script.author, summary: options.summary }),
    })),
    openThreadCount: options.discussion.threads.filter((thread) => isOpen(thread.status)).length,
    fullSlides: snapshot.slides.filter((slide) => full.has(slide.id)),
  };
}

/** The deck's address in the web application: `<public origin>/deck/<deckId>`. */
export function deckAddress(options: Readonly<{ publicUrl: string; deckId: string }>): string {
  return `${options.publicUrl.replace(/\/+$/u, "")}/deck/${encodeURIComponent(options.deckId)}`;
}

function slideOutline(options: Readonly<{ slide: SlideSnapshot; number: number }>): SlideOutline {
  const { slide } = options;
  return {
    slideId: slide.id,
    number: options.number,
    layoutId: slide.layoutId,
    skipped: slide.skipped,
    transition: describeTransition(slide.transition),
    speakerNotes: plainText({ body: slide.speakerNotes, slideNumber: options.number }),
    elements: slide.elements.map((element) => elementOutline({ element, slideNumber: options.number })),
    animations: slide.animations,
  };
}

function elementOutline(options: Readonly<{ element: ElementSnapshot; slideNumber: number }>): ElementOutline {
  const { element } = options;
  return {
    elementId: element.id,
    kind: element.kind,
    name: element.name,
    frame: element.frame,
    morphKey: element.morphKey,
    text: elementText(options),
    placeholder: element.placeholder?.role ?? null,
    children: childrenOf(element).map((child) => elementOutline({ element: child, slideNumber: options.slideNumber })),
  };
}

/** A shape's text, or each table cell's text row by row, joined by tabs and newlines. */
function elementText(options: Readonly<{ element: ElementSnapshot; slideNumber: number }>): string {
  const { element, slideNumber } = options;
  switch (element.kind) {
    case "shape":
      return plainText({ body: element.text, slideNumber });
    case "table":
      return element.rows
        .map((row) =>
          element.columns
            .map((column) => {
              const cell = element.cells.find((candidate) => candidate.rowId === row.id && candidate.columnId === column.id);
              return cell === undefined ? "" : plainText({ body: cell.text, slideNumber }).replace(/\n/gu, " ");
            })
            .join("\t"),
        )
        .join("\n");
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return "";
    default:
      return assertNever(element);
  }
}

function childrenOf(element: ElementSnapshot): readonly ElementSnapshot[] {
  switch (element.kind) {
    case "group":
      return element.children;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function describeTransition(transition: SlideTransition | null): string {
  if (transition === null) return "none";
  switch (transition.kind) {
    case "builtin":
      return `${transition.effect.effect} ${String(transition.durationMilliseconds)} ms`;
    case "scripted":
      return `scripted ${transition.scriptId} ${String(transition.durationMilliseconds)} ms`;
    default:
      return assertNever(transition);
  }
}

function isApproved(options: Readonly<{ approval: DocumentSnapshot["transitionScripts"][number]["approval"]; fingerprint: string }>): boolean {
  switch (options.approval.kind) {
    case "approved":
      return options.approval.fingerprint === options.fingerprint;
    case "unapproved":
      return false;
    default:
      return assertNever(options.approval);
  }
}

function authorName(options: Readonly<{ author: TransitionAuthor; summary: DeckSummary }>): string {
  switch (options.author.kind) {
    case "agent":
      return options.author.name;
    case "person":
      return options.author.personId === options.summary.owner.id ? options.summary.owner.displayName : "a collaborator";
    default:
      return assertNever(options.author);
  }
}

function isOpen(status: DiscussionSnapshot["threads"][number]["status"]): boolean {
  switch (status.kind) {
    case "open":
      return true;
    case "resolved":
      return false;
    default:
      return assertNever(status);
  }
}

// THE INSERT REQUEST the developer page sends to POST /deck-api/google-slides/insert-html
// (mcp/sasha-slides/google-slides/insert-html-contract.ts): the converted slides in queue order,
// where they go, and which presentation. Built and checked here so the person hears about a bad
// address, a bad slide number or an oversized body before anything leaves the page; the server
// re-validates all of it regardless, because the page is untrusted input.

import { STAGED_IMAGE_FIELD } from "../../../../mcp/sasha-slides/converter/index.ts";
import { presentationIdFrom } from "../../../../mcp/sasha-slides/google-slides/slides-client.ts";
import {
  INSERT_HTML_LIMITS,
  type InsertHtmlRequestBody,
  type InsertHtmlSlide,
  type InsertPosition,
} from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";
import { assertNever } from "../../../../mcp/sasha-slides/engine/src/contracts/assert-never.ts";
import type { ConvertedSlide } from "./queue-state.ts";

/** Where the person asked the slides to go, as the form holds it. */
export type PositionChoice = Readonly<{ kind: "end" }> | Readonly<{ kind: "atSlide"; slideNumberText: string }>;

export type Checked<TValue> = Readonly<{ kind: "valid"; value: TValue }> | Readonly<{ kind: "invalid"; message: string }>;

/** A request ready to send, and its size (the server caps the body). */
export type ReadyInsert = Readonly<{ body: InsertHtmlRequestBody; bodyText: string; bodyBytes: number }>;

/**
 * Every converted slide becomes requests on this page id. The server creates the real slide and
 * points every request at it (insert-html-contract.ts), so the value only has to be recognisable.
 */
export const PLACEHOLDER_PAGE_OBJECT_ID = "sasha_dev_page_slide";

export function buildInsertRequest(
  options: Readonly<{ presentationText: string; position: PositionChoice; slides: readonly ConvertedSlide[] }>,
): Checked<ReadyInsert> {
  const presentation = checkedPresentationId(options.presentationText);
  if (presentation.kind === "invalid") return presentation;
  const position = checkedPosition(options.position);
  if (position.kind === "invalid") return position;
  if (options.slides.length === 0) return invalid("Nothing is converted yet: paste or drop HTML first.");
  if (options.slides.length > INSERT_HTML_LIMITS.maximumSlides) {
    return invalid(`At most ${INSERT_HTML_LIMITS.maximumSlides} slides go in one insert; this queue has ${options.slides.length}. Remove some and insert the rest afterwards.`);
  }
  const slides = options.slides.map(insertSlideOf);
  const tooLarge = slides.findIndex((slide) => slide.requests.length > INSERT_HTML_LIMITS.maximumRequestsPerSlide);
  if (tooLarge >= 0) return invalid(`Slide ${tooLarge + 1} has more than ${INSERT_HTML_LIMITS.maximumRequestsPerSlide} requests.`);
  const tooManyImages = slides.findIndex((slide) => stagedImageCount(slide) > INSERT_HTML_LIMITS.maximumStagedImagesPerSlide);
  if (tooManyImages >= 0) return invalid(`Slide ${tooManyImages + 1} carries more than ${INSERT_HTML_LIMITS.maximumStagedImagesPerSlide} embedded images.`);
  const body: InsertHtmlRequestBody = { presentation: presentation.value, position: position.value, slides };
  const bodyText = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyText).byteLength;
  if (bodyBytes > INSERT_HTML_LIMITS.maximumBodyBytes) {
    return invalid(`The request is ${megabytes(bodyBytes)}, over the ${megabytes(INSERT_HTML_LIMITS.maximumBodyBytes)} limit. Insert fewer slides at a time.`);
  }
  return { kind: "valid", value: { body, bodyText, bodyBytes } };
}

/** The presentation id in what the person typed: an editor address, a Drive address or the id. */
export function checkedPresentationId(text: string): Checked<string> {
  if (text.trim() === "") return invalid("Enter the presentation's address or id.");
  const presentationId = presentationIdFrom(text);
  if (presentationId === null) return invalid("That is not a Google Slides address or presentation id.");
  return { kind: "valid", value: presentationId };
}

/** "At slide N" puts the first new slide at position N (1-based), so it is index N - 1. */
export function checkedPosition(choice: PositionChoice): Checked<InsertPosition> {
  switch (choice.kind) {
    case "end":
      return { kind: "valid", value: { kind: "end" } };
    case "atSlide": {
      const slideNumber = positiveIntegerOf(choice.slideNumberText);
      if (slideNumber === null) return invalid("The slide number must be a whole number from 1.");
      return { kind: "valid", value: { kind: "index", index: slideNumber - 1 } };
    }
    default:
      return assertNever(choice);
  }
}

/** One converted slide as the route takes it: the requests, sidecars included, and its diagrams. */
export function insertSlideOf(slide: ConvertedSlide): InsertHtmlSlide {
  return {
    requests: slide.requests,
    diagrams: slide.drawioDiagrams.map((diagram) => ({ objectId: diagram.objectId, diagramId: diagram.diagramId, xml: diagram.xml })),
  };
}

/** Requests that carry the converter's staged-image sidecar (bytes the server uploads first). */
export function stagedImageCount(slide: InsertHtmlSlide): number {
  return slide.requests.filter((request) => Object.hasOwn(request, STAGED_IMAGE_FIELD)).length;
}

/** A whole number of 1 or more written in plain digits, else null. */
export function positiveIntegerOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function invalid(message: string): Readonly<{ kind: "invalid"; message: string }> {
  return { kind: "invalid", message };
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

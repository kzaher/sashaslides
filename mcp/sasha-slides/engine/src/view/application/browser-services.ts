// THE PAGE-SIDE SERVICES the shell injects (editor-services.tsx): the real `BrowserCapabilities`,
// rich text from pasted markup, reading an image file, the platform's primary modifier, and loading
// the deck's fonts from Google Fonts on demand. Everything here touches page APIs, so it is kept out
// of the components, which receive these as services and are tested with fakes.
//
// Key decisions:
//
//  * PASTED MARKUP IS UNTRUSTED. It is parsed with `DOMParser` into an inert document (no scripts
//    run, nothing loads) and reduced to the engine's run and paragraph styles; nothing of it is ever
//    put into the page.
//  * FONTS LOAD ONCE PER FAMILY, by a `<link>` to Google Fonts' stylesheet, regular and bold, upright
//    and italic. System and generic families are never requested.

import type { AssetMediaType, DocumentSnapshot, Paragraph, TextRun } from "../../contracts/document.ts";
import type { ChosenImageFile } from "../../contracts/editor-events.ts";
import type { BrowserCapabilities } from "../../contracts/editor-system.ts";
import { slideUnitsFromPoints } from "../../contracts/geometry.ts";
import { literalColour, type RunStylePatch } from "../../contracts/style.ts";
import { assertNever } from "../../contracts/assert-never.ts";

/** The real browser operations (contracts/editor-system.ts `BrowserCapabilities`). */
export function pageBrowserCapabilities(page: Window): BrowserCapabilities {
  return {
    writeClipboard: async (content) => {
      const clipboard = page.navigator.clipboard;
      if (typeof ClipboardItem === "function") {
        await clipboard.write([new ClipboardItem({ "text/plain": new Blob([content.plainText], { type: "text/plain" }), "text/html": new Blob([content.markup], { type: "text/html" }) })]);
        return;
      }
      await clipboard.writeText(content.plainText);
    },
    requestFullScreen: (element) => element.requestFullscreen(),
    exitFullScreen: () => (page.document.fullscreenElement === null ? Promise.resolve() : page.document.exitFullscreen()),
    openSpeakerWindow: () => page.open("", "sasha-speaker-view", "popup,width=1180,height=760"),
    openTab: (address) => {
      page.open(address, "_blank", "noopener,noreferrer");
    },
  };
}

/** Cmd on Apple platforms, Ctrl elsewhere. */
export function primaryModifierOf(page: Window): "control" | "meta" {
  return /Mac|iPhone|iPad/.test(page.navigator.platform || page.navigator.userAgent) ? "meta" : "control";
}

/** Rich text from pasted markup, reduced to the engine's styles (see the header); null when it has no text. */
export function richTextFromMarkup(markup: string): readonly Paragraph[] | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  const flush = (): void => {
    paragraphs.push({ style: {}, runs });
    runs = [];
  };
  const walk = (node: Node, style: RunStylePatch): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (text.trim().length > 0 || (text.length > 0 && runs.length > 0)) runs.push({ kind: "text", text, style });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "head") return;
    if (tag === "br") {
      flush();
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block && runs.length > 0) flush();
    const nested = { ...style, ...inlineStyleOf(node) };
    for (const child of Array.from(node.childNodes)) walk(child, nested);
    if (block && runs.length > 0) flush();
  };
  walk(parsed.body, {});
  if (runs.length > 0) flush();
  const trimmed = paragraphs.filter((paragraph, index) => paragraph.runs.length > 0 || (index > 0 && index < paragraphs.length - 1));
  return trimmed.length === 0 ? null : trimmed;
}

/** An image file's bytes and pixel size; null for anything that is not a supported image. */
export async function readImageFile(file: File): Promise<ChosenImageFile | null> {
  const mediaType = assetMediaType(file.type);
  if (mediaType === null) return null;
  const bytes = await file.arrayBuffer();
  const size = await pixelSize({ bytes, mediaType });
  if (size === null) return null;
  return { name: file.name, mediaType, bytes, pixelWidth: size.width, pixelHeight: size.height };
}

/** Loads the deck's font families from Google Fonts, once each (see the header). */
export function loadDeckFonts(options: Readonly<{ page: Document; document: DocumentSnapshot; loaded: Set<string> }>): void {
  for (const family of deckFontFamilies(options.document)) {
    if (options.loaded.has(family) || SYSTEM_FAMILIES.has(family.toLowerCase())) continue;
    options.loaded.add(family);
    const link = options.page.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
    options.page.head.appendChild(link);
  }
}

/** Every family the deck's theme and text name. */
export function deckFontFamilies(document: DocumentSnapshot): ReadonlySet<string> {
  const families = new Set<string>([document.theme.headingFontFamily, document.theme.bodyFontFamily, document.theme.defaultRunStyle.fontFamily]);
  for (const style of Object.values(document.theme.placeholderStyles)) if (style.run.fontFamily !== undefined) families.add(style.run.fontFamily);
  for (const slide of document.slides) for (const family of slideFamilies(slide)) families.add(family);
  return families;
}

const BLOCK_TAGS: ReadonlySet<string> = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr"]);
const SYSTEM_FAMILIES: ReadonlySet<string> = new Set(["arial", "helvetica", "times new roman", "georgia", "courier new", "verdana", "sans-serif", "serif", "monospace", "system-ui"]);
const FAMILIES_OF_SLIDE = new WeakMap<DocumentSnapshot["slides"][number], ReadonlySet<string>>();

function slideFamilies(slide: DocumentSnapshot["slides"][number]): ReadonlySet<string> {
  const cached = FAMILIES_OF_SLIDE.get(slide);
  if (cached !== undefined) return cached;
  const families = new Set<string>();
  const addBody = (body: { readonly paragraphs: readonly Paragraph[] }): void => {
    for (const paragraph of body.paragraphs) for (const run of paragraph.runs) if (run.style.fontFamily !== undefined) families.add(run.style.fontFamily);
  };
  const visit = (element: DocumentSnapshot["slides"][number]["elements"][number]): void => {
    switch (element.kind) {
      case "shape":
        addBody(element.text);
        return;
      case "table":
        for (const cell of element.cells) addBody(cell.text);
        return;
      case "group":
        element.children.forEach(visit);
        return;
      case "image":
      case "line":
      case "unsupported":
        return;
      default:
        assertNever(element);
    }
  };
  slide.elements.forEach(visit);
  FAMILIES_OF_SLIDE.set(slide, families);
  return families;
}

function inlineStyleOf(element: HTMLElement): RunStylePatch {
  const tag = element.tagName.toLowerCase();
  const style: { -readonly [Key in keyof RunStylePatch]: RunStylePatch[Key] } = {};
  if (tag === "b" || tag === "strong" || /^h[1-6]$/.test(tag)) style.fontWeight = 700;
  if (tag === "i" || tag === "em") style.fontStyle = "italic";
  if (tag === "u") style.underline = true;
  if (tag === "s" || tag === "strike" || tag === "del") style.strikethrough = true;
  if (tag === "sup") style.baselineOffset = "superscript";
  if (tag === "sub") style.baselineOffset = "subscript";
  if (tag === "a") {
    const address = element.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(address)) style.link = { kind: "webAddress", address };
  }
  const declared = element.style;
  const weight = Number(declared.fontWeight);
  if (declared.fontWeight === "bold" || weight >= 600) style.fontWeight = 700;
  if (declared.fontStyle === "italic") style.fontStyle = "italic";
  if (declared.textDecoration.includes("underline")) style.underline = true;
  if (declared.textDecoration.includes("line-through")) style.strikethrough = true;
  const points = /^([\d.]+)pt$/.exec(declared.fontSize);
  if (points !== null) style.fontSize = Math.round(slideUnitsFromPoints(Number(points[1])) * 100) / 100;
  const colour = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(declared.color);
  if (colour !== null) style.colour = literalColour({ hexadecimal: `#${[colour[1], colour[2], colour[3]].map((channel) => Number(channel ?? "0").toString(16).padStart(2, "0")).join("")}`, alpha: 1 });
  return style;
}

function assetMediaType(type: string): AssetMediaType | null {
  switch (type) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
    case "image/svg+xml":
      return type;
    default:
      return null;
  }
}

async function pixelSize(options: Readonly<{ bytes: ArrayBuffer; mediaType: AssetMediaType }>): Promise<Readonly<{ width: number; height: number }> | null> {
  const blob = new Blob([options.bytes], { type: options.mediaType });
  const address = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = address;
    await image.decode();
    return { width: image.naturalWidth || 300, height: image.naturalHeight || 150 };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(address);
  }
}

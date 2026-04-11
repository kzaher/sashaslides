/**
 * Google Slides API wrapper — reads presentations and applies batch updates.
 */

import { google, type slides_v1 } from "googleapis";
import type { Slide, SlideElement } from "./slide.js";
import { createSlide } from "./slide.js";
import type { SlideRequest } from "./slide-adapter.js";

export type SlidesApiConfig = Readonly<{
  /** Path to service account key JSON, or 'adc' for Application Default Credentials. */
  authMode: "service-account" | "adc" | "api-key";
  /** Service account key path (when authMode = service-account). */
  keyFilePath: string | null;
  /** API key (when authMode = api-key). */
  apiKey: string | null;
}>;

const DEFAULT_CONFIG: SlidesApiConfig = {
  authMode: "adc",
  keyFilePath: null,
  apiKey: null,
};

export type PresentationInfo = Readonly<{
  presentationId: string;
  title: string;
  slideCount: number;
  slides: readonly Slide[];
}>;

/**
 * Create an authenticated Slides API client.
 */
async function getClient(config: SlidesApiConfig): Promise<slides_v1.Slides> {
  if (config.authMode === "api-key" && config.apiKey) {
    return google.slides({ version: "v1", auth: config.apiKey });
  }

  if (config.authMode === "service-account" && config.keyFilePath) {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.keyFilePath,
      scopes: ["https://www.googleapis.com/auth/presentations"],
    });
    return google.slides({ version: "v1", auth });
  }

  // ADC
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/presentations"],
  });
  return google.slides({ version: "v1", auth });
}

/**
 * Extract presentation ID from a Google Slides URL.
 */
export function extractPresentationId(url: string): string {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error(`Cannot extract presentation ID from URL: ${url}`);
  }
  return match[1];
}

/**
 * Read a presentation and return structured info.
 */
export async function readPresentation(
  presentationUrl: string,
  config?: Partial<SlidesApiConfig>
): Promise<PresentationInfo> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const client = await getClient(cfg);
  const presentationId = extractPresentationId(presentationUrl);

  const res = await client.presentations.get({ presentationId });
  const presentation = res.data;

  const slides: Slide[] = (presentation.slides ?? []).map((apiSlide, index) =>
    apiSlideToSlide(apiSlide, index)
  );

  return {
    presentationId,
    title: presentation.title ?? "Untitled",
    slideCount: slides.length,
    slides,
  };
}

/**
 * Apply batch update requests to a presentation.
 */
export async function applyRequests(
  presentationUrl: string,
  requests: readonly SlideRequest[],
  config?: Partial<SlidesApiConfig>
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const client = await getClient(cfg);
  const presentationId = extractPresentationId(presentationUrl);

  const apiRequests = requests.map(toApiRequest);

  await client.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: apiRequests },
  });
}

/**
 * Read a single slide from a presentation.
 */
export async function readSlide(
  presentationUrl: string,
  slideIndex: number,
  config?: Partial<SlidesApiConfig>
): Promise<Slide> {
  const info = await readPresentation(presentationUrl, config);
  if (slideIndex < 0 || slideIndex >= info.slides.length) {
    throw new Error(
      `Slide index ${slideIndex} out of range (0..${info.slides.length - 1})`
    );
  }
  return info.slides[slideIndex];
}

function apiSlideToSlide(apiSlide: slides_v1.Schema$Page, index: number): Slide {
  const elements: SlideElement[] = (apiSlide.pageElements ?? []).map((el) => ({
    objectId: el.objectId ?? "",
    kind: inferElementKind(el),
    text: extractText(el),
    transform: {
      translateX: el.transform?.translateX ?? 0,
      translateY: el.transform?.translateY ?? 0,
      scaleX: el.transform?.scaleX ?? 1,
      scaleY: el.transform?.scaleY ?? 1,
      width: el.size?.width?.magnitude ?? 0,
      height: el.size?.height?.magnitude ?? 0,
    },
    style: extractStyle(el),
  }));

  return createSlide({
    slideId: apiSlide.objectId ?? "",
    index,
    elements,
    layout: apiSlide.slideProperties?.layoutObjectId ?? "BLANK",
    notes: extractNotesText(apiSlide),
  });
}

function inferElementKind(el: slides_v1.Schema$PageElement): SlideElement["kind"] {
  if (el.shape) return "shape";
  if (el.image) return "image";
  if (el.table) return "table";
  if (el.line) return "line";
  return "shape";
}

function extractText(el: slides_v1.Schema$PageElement): string | null {
  const textElements = el.shape?.text?.textElements;
  if (!textElements) return null;

  return textElements
    .map((te) => te.textRun?.content ?? "")
    .join("")
    .trim() || null;
}

function extractStyle(el: slides_v1.Schema$PageElement): SlideElement["style"] {
  const textStyle = el.shape?.text?.textElements?.[0]?.textRun?.style;
  return {
    fontSize: textStyle?.fontSize?.magnitude ?? null,
    bold: textStyle?.bold ?? false,
    italic: textStyle?.italic ?? false,
    fontFamily: textStyle?.fontFamily ?? null,
    foregroundColor: textStyle?.foregroundColor?.opaqueColor?.rgbColor
      ? rgbToHex(textStyle.foregroundColor.opaqueColor.rgbColor)
      : null,
    backgroundColor: null,
  };
}

function extractNotesText(apiSlide: slides_v1.Schema$Page): string {
  const notes = apiSlide.slideProperties?.notesPage;
  if (!notes) return "";
  const textElements = notes.pageElements
    ?.find((el) => el.shape?.shapeType === "TEXT_BOX")
    ?.shape?.text?.textElements;
  if (!textElements) return "";
  return textElements
    .map((te) => te.textRun?.content ?? "")
    .join("")
    .trim();
}

function rgbToHex(rgb: { red?: number | null; green?: number | null; blue?: number | null }): string {
  const r = Math.round((rgb.red ?? 0) * 255);
  const g = Math.round((rgb.green ?? 0) * 255);
  const b = Math.round((rgb.blue ?? 0) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function toApiRequest(req: SlideRequest): slides_v1.Schema$Request {
  switch (req.kind) {
    case "deleteText":
      return {
        deleteText: {
          objectId: req.objectId,
          textRange: req.fields.textRange as slides_v1.Schema$Range,
        },
      };
    case "insertText":
      return {
        insertText: {
          objectId: req.objectId,
          text: req.fields.text as string,
          insertionIndex: req.fields.insertionIndex as number,
        },
      };
    case "replaceAllText":
      return {
        replaceAllText: {
          containsText: req.fields.containsText as slides_v1.Schema$SubstringMatchCriteria,
          replaceText: req.fields.replaceText as string,
        },
      };
    default:
      throw new Error(`Unsupported request kind: ${req.kind}`);
  }
}

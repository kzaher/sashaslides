/**
 * defect-report.ts — the payload, and the rules that keep it anonymous.
 *
 * ========================================================================================
 *  A DEFECT REPORT MUST NOT SAY WHOSE SLIDE IT WAS. DO NOT ADD A FIELD THAT COULD.
 * ========================================================================================
 *
 * Specifically, and permanently: no account identifier, no email address, no display name, no
 * Drive file id, no presentation id, no page object id, no Drive path, no folder name, no proposal
 * id, no session id, no device or browser fingerprint, no IP address, no timestamp precise enough
 * to single out a session, and no "just for debugging" correlation id. A report is a rendering bug
 * with a picture attached; it is not a support ticket and it is not telemetry. If you need to tie
 * one to a user, ask the user — do not put it in the payload.
 *
 * The rule is enforced three ways, because a doc comment is not a mechanism:
 *   1. `DefectReport` has no field that could hold one. A new field is a visible diff on this type.
 *   2. `redactIdentifiers` rewrites EVERY `*Id` key in the converter's own output to `anon-N`
 *      (consistently, so the requests still reference each other) and blanks any Google-hosted
 *      URL. The converter's requests carry the object ids its caller chose, and that caller is
 *      holding a presentation id.
 *   3. `findForbiddenStrings` lets the composition root declare the identifiers it knows about —
 *      the presentation id, the file id, the signed-in address — and `previewDefectReport` THROWS
 *      rather than return a payload containing one.
 *
 * WHAT THE USER SAW IS WHAT GETS SENT. `previewDefectReport` builds the whole payload, including
 * the converter's output, and `defectReportFrom` is a pure projection of it that adds nothing but
 * this module's own version string. There is no path that attaches anything to a report after the
 * preview was shown: the conversion cannot be smuggled in from the original slide either, because
 * `previewDefectReport` does not accept a conversion — it accepts a `convert` function and calls
 * it with `anonymised.html` itself.
 */
import type { SlidesApiRequest, UnsupportedFeature } from "../../../converter/index.ts";
import { ANONYMISER_VERSION, type AnonymisedSlide, type IdentifierPolicy } from "./anonymise-slide-html.ts";

/** What another agent POSTs. Read the banner above before adding anything to it. */
export type DefectReport = Readonly<{
  /** Bumped when the shape below changes incompatibly. */
  reportVersion: 1;
  /** The anonymised slide, byte for byte what the preview rendered. */
  slideHtml: string;
  /** The converter's own output FOR THAT HTML — never for the original. */
  conversion: ConversionSummary;
  /** The user's free text, exactly as they typed it. Never rewritten: it is theirs to send. */
  note: string;
  versions: ReportVersions;
  /** What the anonymiser did and what it knowingly did not do, as the preview showed it. */
  anonymisation: AnonymisationSummary;
}>;

export type ConversionSummary = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
}>;

export type ReportVersions = Readonly<{
  /** Stamped by this module; callers cannot set it. */
  anonymiser: string;
  converter: string;
  addon: string;
  protocol: string;
}>;

export type AnonymisationSummary = Readonly<{
  identifierPolicy: IdentifierPolicy;
  carriers: AnonymisedSlide["carriers"];
  retainedIdentifiers: AnonymisedSlide["retainedIdentifiers"];
  unrecognisedAttributes: readonly string[];
  residualRisks: readonly string[];
  /** How many `*Id` values in the converter's output were rewritten to `anon-N`. */
  redactedIdentifierCount: number;
  /** How many Google-hosted URLs were blanked. */
  redactedUrlCount: number;
}>;

/**
 * Everything the user is shown before they press send — which is to say, everything that gets
 * sent. Hold this in the review UI and render every field of it.
 */
export type DefectReportPreview = Readonly<{
  anonymised: AnonymisedSlide;
  identifierPolicy: IdentifierPolicy;
  conversion: ConversionSummary;
  redactedIdentifierCount: number;
  redactedUrlCount: number;
  note: string;
  versions: Readonly<{ converter: string; addon: string; protocol: string }>;
}>;

/** Converts ONE slide's HTML. Injected so this module never reaches for a converter of its own. */
export type ConvertForReport = (spec: Readonly<{ html: string }>) => Promise<ConversionSummary>;

export async function previewDefectReport({
  anonymised,
  identifierPolicy,
  convert,
  note,
  versions,
  mustNotContain,
}: {
  anonymised: AnonymisedSlide;
  identifierPolicy: IdentifierPolicy;
  convert: ConvertForReport;
  note: string;
  versions: Readonly<{ converter: string; addon: string; protocol: string }>;
  /**
   * Identifiers the caller knows about and that must not appear anywhere in the payload: the
   * presentation id, the staged file id, the signed-in address. Empty is allowed and means the
   * caller is asserting it has none to declare.
   */
  mustNotContain: readonly string[];
}): Promise<DefectReportPreview> {
  const converted = await convert({ html: anonymised.html });
  const redacted = redactIdentifiers(converted);
  const preview: DefectReportPreview = {
    anonymised,
    identifierPolicy,
    conversion: redacted.conversion,
    redactedIdentifierCount: redacted.identifierCount,
    redactedUrlCount: redacted.urlCount,
    note,
    versions,
  };
  const found = findForbiddenStrings({ payload: preview, forbidden: mustNotContain });
  if (found.length > 0) {
    throw new Error(
      `defect report would have carried ${found.length} forbidden string(s): ${found.join(", ")}. ` +
        "This is a leak, not a validation failure — fix the caller rather than relaxing the check.",
    );
  }
  return preview;
}

/**
 * The preview, as the payload. Pure, total, and the ONLY way to build a `DefectReport`: every
 * field is read off `preview`, so there is nowhere for an extra field to come from.
 */
export function defectReportFrom(preview: DefectReportPreview): DefectReport {
  return {
    reportVersion: 1,
    slideHtml: preview.anonymised.html,
    conversion: preview.conversion,
    note: preview.note,
    versions: {
      anonymiser: ANONYMISER_VERSION,
      converter: preview.versions.converter,
      addon: preview.versions.addon,
      protocol: preview.versions.protocol,
    },
    anonymisation: {
      identifierPolicy: preview.identifierPolicy,
      carriers: preview.anonymised.carriers,
      retainedIdentifiers: preview.anonymised.retainedIdentifiers,
      unrecognisedAttributes: preview.anonymised.unrecognisedAttributes,
      residualRisks: preview.anonymised.residualRisks,
      redactedIdentifierCount: preview.redactedIdentifierCount,
      redactedUrlCount: preview.redactedUrlCount,
    },
  };
}

/** The bytes to POST. One shape, so a recipient can verify a digest of it. */
export function serializeDefectReport(report: DefectReport): string {
  return JSON.stringify(report);
}

/**
 * Every `forbidden` string that appears anywhere in `payload`, however deeply nested. Case
 * insensitive, because a file id is case sensitive but an email address is not, and the cost of
 * being too eager here is a loud failure rather than a quiet disclosure.
 *
 * A caller can run this before showing the preview; `previewDefectReport` runs it unconditionally.
 */
export function findForbiddenStrings({
  payload,
  forbidden,
}: {
  payload: unknown;
  forbidden: readonly string[];
}): readonly string[] {
  const haystack = JSON.stringify(payload).toLowerCase();
  return forbidden.filter((needle) => needle !== "" && haystack.includes(needle.toLowerCase()));
}

/**
 * The converter's output with every identifier replaced.
 *
 * The converter is handed an `objectIdPrefix` and a `pageObjectId` by whoever called it, and that
 * caller is holding the presentation. So every key whose name ends in `id` is rewritten through one
 * consistent map — consistent because `insertText` has to keep pointing at the shape `createShape`
 * made — and any Google-hosted URL is blanked, since a Drive link is a file id in a trench coat.
 */
export function redactIdentifiers(
  conversion: ConversionSummary,
): Readonly<{ conversion: ConversionSummary; identifierCount: number; urlCount: number }> {
  const minted = new Map<string, string>();
  let urlCount = 0;

  const redactValue = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Readonly<Record<string, unknown>>).map(([childKey, childValue]) => [
          childKey,
          redactValue(childValue, childKey),
        ]),
      );
    }
    if (typeof value !== "string") return value;
    if (key !== null && IDENTIFIER_KEY.test(key)) {
      const existing = minted.get(value);
      if (existing !== undefined) return existing;
      const replacement = `anon-${minted.size + 1}`;
      minted.set(value, replacement);
      return replacement;
    }
    if (GOOGLE_HOSTED_URL.test(value)) {
      urlCount += 1;
      return "about:blank";
    }
    return value;
  };

  // SAFETY: `redactValue` rebuilds plain objects and arrays from the same JSON-shaped input, so the
  // result has the same structure as `conversion`. There is no type information to carry through a
  // generic tree walk, and the alternative — one hand-written redactor per request variant — would
  // silently miss the next variant the converter learns to emit, which is the failure that matters.
  const conversionAfter = redactValue(conversion, null) as ConversionSummary;
  return { conversion: conversionAfter, identifierCount: minted.size, urlCount };
}

/** `objectId`, `pageObjectId`, `layoutId`, `presentationId`, `masterObjectId`, `…Ids`. */
const IDENTIFIER_KEY = /ids?$/i;

const GOOGLE_HOSTED_URL = /\b(?:drive|docs|script|lh\d|slides)\.google(?:usercontent)?\.com|googleusercontent\.com/i;

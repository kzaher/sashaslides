/**
 * index.ts — the anonymiser's public surface.
 *
 * Two calls, in this order, and no third:
 *
 *   const preview = await previewDefectReport({
 *     anonymised: anonymiseSlideHtml({ html, seed: freshRandomSeed(), identifiers: "preserve" }),
 *     identifierPolicy: "preserve",
 *     convert: (spec) => convertSlideHtml({ ...spec, presentationId, pageObjectId, objectIdPrefix: "anon" }),
 *     note, versions, mustNotContain: [presentationId, fileId, signedInAddress],
 *   });
 *   // ... render EVERY field of `preview`, let the user read it, and only then:
 *   const body = serializeDefectReport(defectReportFrom(preview));
 *
 * `anonymiseSlideHtml` produces the preview; `defectReportFrom` is a pure projection of it. There
 * is deliberately no "anonymise and send" convenience that skips the middle step.
 *
 * THE VISIBLE TEXT IS LOREM IPSUM BY DEFAULT, matched to the original's RENDERED WIDTH. It reads
 * as prose, and NOTHING LEAVES THE BROWSER to produce it — no model, no network, offline and
 * on-premise, deterministic for a given seed. Digits are still substituted under it, so
 * `£1,284,300` comes out as a different seven-figure amount rather than as words.
 *
 * `textStrategy: { kind: "substitute" }` asks for the old character-by-character gibberish
 * instead (`Dqtfnmlgq fakzqqz 3299532`). Every carrier that is NOT a visible text run — every
 * attribute, the stylesheet, every URL, every `data:` image — is substituted under both, always.
 *
 * MODEL-ASSISTED TEXT is an optional extra step BEFORE that first call, and it changes nothing
 * about the guarantee:
 *
 *   const runs = extractTextRuns({ html });                 // the "before" column; stays local
 *   const { prompt } = textRunRewriteRequest({ runs });     // what to ask the model
 *   const reply = parseTextRunRewriteReply({ reply: raw, runs });   // untrusted input, parsed here
 *   const anonymised = anonymiseSlideHtml({
 *     html, seed: freshRandomSeed(), identifiers: "rename",
 *     replacements: reply.outcome === "parsed" ? reply.replacements : undefined,
 *   });
 *   // anonymised.textRuns is the "after" column, run by run, and says per run whether it was
 *   // "rewritten" or "substituted"; anonymised.rejectedReplacements says why, for the ones the
 *   // gate threw away; anonymised.shapeRisks says which accepted ones may not reproduce.
 *
 * Every step of that is optional and every step can fail: a missing, malformed, hostile or
 * half-empty reply means more runs come out as gibberish and NOTHING comes out as the original.
 *
 * Nothing here touches Apps Script, Drive, the network, the DOM or React: it is string in, string
 * out, which is what lets the leak test enumerate adversarial inputs in plain node.
 */
export { anonymiseSlideHtml, ANONYMISER_VERSION, residualRisksOf } from "./anonymise-slide-html.ts";
export type {
  AnonymisedSlide,
  AnonymisedTextRun,
  AnonymiseOptions,
  CarrierTally,
  CarrierTreatment,
  IdentifierNamespace,
  IdentifierPolicy,
  RetainedIdentifier,
  TextStrategy,
} from "./anonymise-slide-html.ts";

export {
  defectReportFrom,
  findForbiddenStrings,
  previewDefectReport,
  redactIdentifiers,
  serializeDefectReport,
} from "./defect-report.ts";
export type {
  AnonymisationSummary,
  ConversionSummary,
  ConvertForReport,
  DefectReport,
  DefectReportPreview,
  ReportVersions,
} from "./defect-report.ts";

export { intrinsicImageSize, placeholderImageDataUri, FALLBACK_IMAGE_SIZE } from "./placeholder-image.ts";
export type { PixelSize } from "./placeholder-image.ts";

export { hasSubstitutableCharacter, textSubstituter } from "./substitute-text.ts";
export type { TextSubstituter } from "./substitute-text.ts";

export { documentWordsOf, loremTexter, LOREM_VOCABULARY } from "./lorem-text.ts";
export type { LoremTexter } from "./lorem-text.ts";
export { MONOSPACE_ADVANCE_PER_MILLE, textAdvanceWidth } from "./glyph-advance-widths.ts";

export { collectTextRunSites, extractTextRuns, textRunIdOf } from "./text-runs.ts";
export type { TextRun, TextRunId, TextRunKind, TextRunSite } from "./text-runs.ts";

export { decideReplacements, echoFragmentsOf, forbiddenEchoFragmentsOf, judgeReplacement } from "./replacement-policy.ts";
export type {
  AcceptedReplacement,
  RejectedReplacement,
  ReplacementDecisions,
  ReplacementRejectionReason,
  ReplacementVerdict,
  ShapeRisk,
  ShapeRiskKind,
  TextRunReplacements,
} from "./replacement-policy.ts";

export { parseTextRunRewriteReply, textRunRewriteRequest } from "./rewrite-request.ts";
export type { TextRunRewriteReply, TextRunRewriteRequest } from "./rewrite-request.ts";

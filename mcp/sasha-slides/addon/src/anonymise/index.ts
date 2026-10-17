/**
 * index.ts — the anonymiser's public surface: what the report window and its state tree import.
 *
 *   const preview = await previewDefectReport({
 *     anonymised: anonymiseSlideHtml({ html, seed: freshRandomSeed(), identifiers: "preserve" }),
 *     identifierPolicy: "preserve",
 *     convert: (spec) => convertSlideHtml({ ...spec, presentationId, pageObjectId, objectIdPrefix: "anon" }),
 *     note, versions, mustNotContain: [presentationId, fileId, signedInAddress],
 *   });
 *   // ... render EVERY field of `preview`, let the user read it, and only then:
 *   const report = defectReportFrom(preview);
 *
 * `anonymiseSlideHtml` produces the preview; `defectReportFrom` is a pure projection of it. There
 * is deliberately no "anonymise and send" convenience that skips the middle step.
 *
 * THE VISIBLE TEXT IS LOREM IPSUM BY DEFAULT, matched to the original's RENDERED WIDTH. It reads
 * as prose, and NOTHING LEAVES THE BROWSER to produce it — no model, no network, offline and
 * on-premise, deterministic for a given seed. Digits are still substituted under it, so
 * `£1,284,300` comes out as a different seven-figure amount rather than as words. Every carrier
 * that is NOT a visible text run — every attribute, the stylesheet, every URL, every `data:` image
 * — is substituted, always.
 *
 * The user may type their own text for a run (`replacements`); replacement-policy.ts judges every
 * entry, and whatever it rejects is written by the engine as if nothing had been offered.
 *
 * Nothing here touches Apps Script, Drive, the network, the DOM or React: it is string in, string
 * out, which is what lets the leak test enumerate adversarial inputs in plain node.
 */
export { anonymiseSlideHtml } from "./anonymise-slide-html.ts";
export type { AnonymisedSlide, IdentifierPolicy } from "./anonymise-slide-html.ts";

export { defectReportFrom, previewDefectReport } from "./defect-report.ts";
export type { ConversionSummary, ConvertForReport, DefectReport, DefectReportPreview } from "./defect-report.ts";

export { extractTextRuns } from "./text-runs.ts";
export type { TextRun, TextRunId, TextRunKind } from "./text-runs.ts";

export type { TextRunReplacements } from "./replacement-policy.ts";

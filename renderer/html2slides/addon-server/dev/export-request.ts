// THE PNG EXPORT REQUEST the developer page sends to POST /deck-api/google-slides/export-png
// (insert-html-contract.ts): a presentation, an optional 1-based inclusive range, and whether to
// leave out slides marked "Skip slide". The server renders with the signed-in person's own Google
// grant and answers with the zip itself.

import { EXPORT_PNG_LIMITS, type ExportPngRequestBody } from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";
import { checkedPresentationId, positiveIntegerOf, type Checked } from "./insert-request.ts";

export type ExportForm = Readonly<{ presentationText: string; fromText: string; toText: string; skipHidden: boolean }>;

export function buildExportRequest(form: ExportForm): Checked<ExportPngRequestBody> {
  const presentation = checkedPresentationId(form.presentationText);
  if (presentation.kind === "invalid") return presentation;
  const from = boundOf({ text: form.fromText, label: "From" });
  if (from.kind === "invalid") return from;
  const to = boundOf({ text: form.toText, label: "To" });
  if (to.kind === "invalid") return to;
  if (from.value !== null && to.value !== null) {
    if (from.value > to.value) return { kind: "invalid", message: "“From” must not be after “To”." };
    const count = to.value - from.value + 1;
    if (count > EXPORT_PNG_LIMITS.maximumSlides) {
      return { kind: "invalid", message: `At most ${EXPORT_PNG_LIMITS.maximumSlides} slides per export; this range has ${count}.` };
    }
  }
  return { kind: "valid", value: { presentation: presentation.value, from: from.value, to: to.value, skipHidden: form.skipHidden } };
}

/** The zip's file name: the presentation id and the range, so two exports never collide. */
export function exportFileName(body: ExportPngRequestBody): string {
  const range = body.from === null && body.to === null ? "all" : `${body.from ?? 1}-${body.to ?? "end"}`;
  return `slides-${body.presentation.slice(0, 12)}-${range}.zip`;
}

/** A blank bound means "from the first" or "to the last". */
function boundOf(options: Readonly<{ text: string; label: string }>): Checked<number | null> {
  if (options.text.trim() === "") return { kind: "valid", value: null };
  const value = positiveIntegerOf(options.text);
  if (value === null) return { kind: "invalid", message: `“${options.label}” must be a slide number from 1, or blank.` };
  return { kind: "valid", value };
}

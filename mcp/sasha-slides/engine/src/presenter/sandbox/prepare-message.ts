// GATHERING A `prepare` MESSAGE: both slides as markup, fresh copies of every asset's bytes, the font
// bytes, and the script bundle -- with every size limit checked BEFORE anything is posted, so an
// oversized run never reaches the runner at all.
//
// Decisions:
//
//  * FRESH BYTES EVERY RUN. Transferring an `ArrayBuffer` detaches it in the sender. The asset store's
//    `copyBytesOf` returns a new copy on every call (document-store.ts), and this module never keeps
//    one between runs, so the second run of the same image still has its bytes.
//  * CHEAP CHECKS FIRST: script, stylesheet and overlay sizes are known without rendering; slide
//    markup is checked as soon as it is rendered; the transfer total only after the bytes are in
//    hand. The whole gathering counts against the prepare deadline (the reducer's clock), so a slow
//    `fontFiles` is a `prepareTimedOut`, not a hang.
//  * THE APPROVAL IS RE-CHECKED against the text being sent: the run was resolved from an approved
//    fingerprint, and a script edited between the key press and the gathering must not run under
//    the old approval.
//  * BOTH SLIDES ARE RENDERED AT THE RUN'S BUILD POSITIONS (builds/run-slides.ts):
//    a scripted transition out of a built slide starts from what the audience saw, and a scripted
//    build step animates from the slide before it to the slide after it.

import type { AssetStore } from "../../contracts/document-store.ts";
import { scriptFingerprint, type DocumentSnapshot } from "../../contracts/document.ts";
import type { AssetId } from "../../contracts/ids.ts";
import type { PresenterDependencies, TransitionRun } from "../../contracts/presenter.ts";
import type { FontFaceRequest, RenderSlideMarkup, SlideMarkup } from "../../contracts/render.ts";
import {
  TRANSITION_LIMITS,
  TRANSITION_PROTOCOL,
  type HostToRunnerMessage,
  type TransferredAsset,
  type TransitionFallbackReason,
} from "../../contracts/transition-protocol.ts";
import { slideOnSide } from "../builds/run-slides.ts";
import { scriptedTransitionOf } from "../presenter-queries.ts";
import { deckSlideNumber } from "../presenter-state.ts";

export type PrepareMessage = Extract<HostToRunnerMessage, Readonly<{ kind: "prepare" }>>;

export type PrepareOutcome =
  | Readonly<{ kind: "ready"; message: PrepareMessage; transfer: readonly Transferable[] }>
  | Readonly<{ kind: "fallBack"; reason: TransitionFallbackReason; message: string }>;

export async function gatherPrepare(
  options: Readonly<{
    run: TransitionRun;
    document: DocumentSnapshot;
    reducedMotion: boolean;
    renderSlideMarkup: RenderSlideMarkup;
    assetStore: AssetStore;
    fontFiles: PresenterDependencies["fontFiles"];
  }>,
): Promise<PrepareOutcome> {
  const transition = scriptedTransitionOf(options.run.transition);
  if (transition === null) return fallBack("protocolViolation", "Only scripted transitions are prepared in the runner.");
  const record = options.document.transitionScripts.find((script) => script.id === transition.scriptId);
  if (record === undefined) return fallBack("scriptFailed", "The transition script was removed before it could run.");
  if (scriptFingerprint(record) !== transition.fingerprint) return fallBack("scriptFailed", "The transition script changed after it was approved; it was not run.");
  const sourceProblem =
    tooLarge({ text: record.script, limit: TRANSITION_LIMITS.maximumScriptBytes, what: "script" }) ??
    tooLarge({ text: record.stylesheet, limit: TRANSITION_LIMITS.maximumStylesheetBytes, what: "stylesheet" }) ??
    tooLarge({ text: record.markup, limit: TRANSITION_LIMITS.maximumOverlayMarkupBytes, what: "overlay markup" });
  if (sourceProblem !== null) return fallBack("scriptTooLarge", sourceProblem);

  const incomingSlide = slideOnSide({ run: options.run, document: options.document, side: "incoming" });
  if (incomingSlide === null) return fallBack("scriptFailed", "The incoming slide was deleted before the transition could run.");
  const outgoingSlide = slideOnSide({ run: options.run, document: options.document, side: "outgoing" });
  const incoming = options.renderSlideMarkup({ slide: incomingSlide, document: options.document, slideNumber: deckSlideNumber(options.document, incomingSlide.id) });
  const outgoing =
    outgoingSlide === null ? null : options.renderSlideMarkup({ slide: outgoingSlide, document: options.document, slideNumber: deckSlideNumber(options.document, outgoingSlide.id) });
  for (const markup of [incoming, outgoing]) {
    if (markup === null) continue;
    const problem = tooLarge({ text: markup.markup, limit: TRANSITION_LIMITS.maximumSlideMarkupBytes, what: "slide markup" });
    if (problem !== null) return fallBack("slideTooLarge", problem);
  }

  const assets = await freshAssetCopies({ assetIds: uniqueAssetIds([incoming, outgoing]), document: options.document, assetStore: options.assetStore });
  const fonts = await options.fontFiles(uniqueFontFaces([incoming, outgoing]));
  const transferredBytes = [...assets, ...fonts].reduce((total, item) => total + item.bytes.byteLength, 0);
  if (transferredBytes > TRANSITION_LIMITS.maximumTransferredBytes) {
    return fallBack("transferTooLarge", `The transition needs ${transferredBytes} bytes of images and fonts; the limit is ${TRANSITION_LIMITS.maximumTransferredBytes}.`);
  }
  return {
    kind: "ready",
    message: {
      protocol: TRANSITION_PROTOCOL,
      kind: "prepare",
      runId: options.run.runId,
      bundle: { script: record.script, stylesheet: record.stylesheet, markup: record.markup },
      outgoing,
      incoming,
      assets,
      fonts,
      pageHeight: options.document.pageSize.height,
      durationMilliseconds: transition.durationMilliseconds,
      direction: options.run.direction,
      parameters: transition.parameters,
      reducedMotion: options.reducedMotion,
    },
    transfer: [...assets, ...fonts].map((item) => item.bytes),
  };
}

/** UTF-8 length, the size the limits are stated in. */
export function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function tooLarge(options: Readonly<{ text: string; limit: number; what: string }>): string | null {
  const bytes = byteLengthOf(options.text);
  return bytes > options.limit ? `The transition's ${options.what} is ${bytes} bytes; the limit is ${options.limit}.` : null;
}

function fallBack(reason: TransitionFallbackReason, message: string): PrepareOutcome {
  return { kind: "fallBack", reason, message };
}

function uniqueAssetIds(markups: readonly (SlideMarkup | null)[]): readonly AssetId[] {
  return [...new Set(markups.flatMap((markup) => markup?.assetIds ?? []))];
}

function uniqueFontFaces(markups: readonly (SlideMarkup | null)[]): readonly FontFaceRequest[] {
  const faces = new Map<string, FontFaceRequest>();
  for (const face of markups.flatMap((markup) => markup?.fontFaces ?? [])) faces.set(`${face.family}|${face.weight}|${face.style}`, face);
  return [...faces.values()];
}

async function freshAssetCopies(options: Readonly<{ assetIds: readonly AssetId[]; document: DocumentSnapshot; assetStore: AssetStore }>): Promise<readonly TransferredAsset[]> {
  const copies = await Promise.all(
    options.assetIds.map(async (assetId): Promise<TransferredAsset | null> => {
      const record = options.document.assets.find((asset) => asset.id === assetId);
      if (record === undefined) return null;
      const bytes = await options.assetStore.copyBytesOf(assetId);
      // An image whose bytes are not here yet renders as a broken image in the runner, as it would in the editor.
      return bytes === null ? null : { assetId, mediaType: record.mediaType, bytes };
    }),
  );
  return copies.filter((copy): copy is TransferredAsset => copy !== null);
}

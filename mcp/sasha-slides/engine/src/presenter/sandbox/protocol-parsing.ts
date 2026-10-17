// THE PARSE BOUNDARY of the transition protocol, in both directions. A runner is arbitrary code, so
// the host parses every port message into a fresh typed value -- copying only the fields the
// contract names, never passing the received object on -- and anything else is dropped and
// counted (`runnerMessageRejected`). The runner bootstrap parses the host's messages the same way
// before acting on them; it trusts its parent more, but a malformed `prepare` must fail as a
// message, not as a crash halfway through building the stage.
//
// These are parse-boundary guards over `unknown`, so the checks of a message `kind` are string
// comparisons by necessity (typescript skill, "Exhaustiveness": the one legitimate exception); every
// new message kind in transition-protocol.ts must be added here by hand.

import { parseAssetId, parseElementId, type AssetId, type ElementId } from "../../contracts/ids.ts";
import type { FontFaceRequest, SlideMarkup, StageElementRecord } from "../../contracts/render.ts";
import type { SerialisableObject, SerialisableValue } from "../../contracts/serialisable.ts";
import {
  TRANSITION_LIMITS,
  TRANSITION_PROTOCOL,
  hasTransitionProtocol,
  type HostToRunnerMessage,
  type RunnerToHostMessage,
  type TransferredAsset,
  type TransferredFont,
  type TransitionCancelReason,
  type TransitionDirection,
} from "../../contracts/transition-protocol.ts";
import { parseAssetMediaType } from "../../shared/media-types.ts";

export type Parsed<TMessage> = Readonly<{ kind: "valid"; message: TMessage }> | Readonly<{ kind: "invalid"; problem: string }>;

/** Host side: a message from the runner's port. */
export function parseRunnerToHostMessage(data: unknown): Parsed<RunnerToHostMessage> {
  if (!hasTransitionProtocol(data)) return invalid(`not a ${TRANSITION_PROTOCOL} message`);
  const runId = Reflect.get(data, "runId");
  if (!isRunId(runId)) return invalid("missing or malformed runId");
  const protocol = TRANSITION_PROTOCOL;
  switch (data.kind) {
    case "prepared":
      return valid({ protocol, kind: "prepared", runId });
    case "started":
      return valid({ protocol, kind: "started", runId });
    case "finished":
      return valid({ protocol, kind: "finished", runId });
    case "pong": {
      const sequence = Reflect.get(data, "sequence");
      const progress = Reflect.get(data, "progress");
      if (!isSequence(sequence) || typeof progress !== "number" || !Number.isFinite(progress)) return invalid("malformed pong");
      return valid({ protocol, kind: "pong", runId, sequence, progress });
    }
    case "failed": {
      const stage = Reflect.get(data, "stage");
      const message = Reflect.get(data, "message");
      if ((stage !== "define" && stage !== "prepare" && stage !== "run") || typeof message !== "string") return invalid("malformed failed");
      return valid({ protocol, kind: "failed", runId, stage, message: truncateLog(message) });
    }
    case "log": {
      const level = Reflect.get(data, "level");
      const message = Reflect.get(data, "message");
      if ((level !== "information" && level !== "warning" && level !== "error") || typeof message !== "string") return invalid("malformed log");
      return valid({ protocol, kind: "log", runId, level, message: truncateLog(message) });
    }
    default:
      return invalid(`unknown message kind ${JSON.stringify(data.kind).slice(0, 40)}`);
  }
}

/** Runner side: a message from the host's port. */
export function parseHostToRunnerMessage(data: unknown): Parsed<HostToRunnerMessage> {
  if (!hasTransitionProtocol(data)) return invalid(`not a ${TRANSITION_PROTOCOL} message`);
  const runId = Reflect.get(data, "runId");
  if (!isRunId(runId)) return invalid("missing or malformed runId");
  const protocol = TRANSITION_PROTOCOL;
  switch (data.kind) {
    case "start":
      return valid({ protocol, kind: "start", runId });
    case "ping": {
      const sequence = Reflect.get(data, "sequence");
      return isSequence(sequence) ? valid({ protocol, kind: "ping", runId, sequence }) : invalid("malformed ping");
    }
    case "cancel": {
      const reason = Reflect.get(data, "reason");
      return isCancelReason(reason) ? valid({ protocol, kind: "cancel", runId, reason }) : invalid("malformed cancel");
    }
    case "prepare":
      return parsePrepare({ data, runId });
    default:
      return invalid(`unknown message kind ${JSON.stringify(data.kind).slice(0, 40)}`);
  }
}

function parsePrepare(options: Readonly<{ data: object; runId: string }>): Parsed<HostToRunnerMessage> {
  const field = (name: string): unknown => Reflect.get(options.data, name);
  const bundle = field("bundle");
  const script = isObject(bundle) ? Reflect.get(bundle, "script") : undefined;
  const stylesheet = isObject(bundle) ? Reflect.get(bundle, "stylesheet") : undefined;
  const markup = isObject(bundle) ? Reflect.get(bundle, "markup") : undefined;
  if (typeof script !== "string" || typeof stylesheet !== "string" || typeof markup !== "string") return invalid("malformed bundle");
  const outgoingField = field("outgoing");
  const outgoing = outgoingField === null ? null : parseSlideMarkup(outgoingField);
  const incoming = parseSlideMarkup(field("incoming"));
  if (incoming === null || (outgoingField !== null && outgoing === null)) return invalid("malformed slide markup");
  const assets = parseList(field("assets"), parseTransferredAsset);
  const fonts = parseList(field("fonts"), parseTransferredFont);
  if (assets === null || fonts === null) return invalid("malformed assets or fonts");
  const pageHeight = field("pageHeight");
  const durationMilliseconds = field("durationMilliseconds");
  const direction = field("direction");
  const parameters = field("parameters");
  const reducedMotion = field("reducedMotion");
  if (!isPositiveNumber(pageHeight) || !isNonNegativeNumber(durationMilliseconds) || !isDirection(direction) || typeof reducedMotion !== "boolean") {
    return invalid("malformed prepare fields");
  }
  const parsedParameters = parseSerialisableObject(parameters);
  if (parsedParameters === null) return invalid("malformed parameters");
  return valid({
    protocol: TRANSITION_PROTOCOL,
    kind: "prepare",
    runId: options.runId,
    bundle: { script, stylesheet, markup },
    outgoing,
    incoming,
    assets,
    fonts,
    pageHeight,
    durationMilliseconds: Math.min(durationMilliseconds, TRANSITION_LIMITS.maximumDurationMilliseconds),
    direction,
    parameters: parsedParameters,
    reducedMotion,
  });
}

function parseSlideMarkup(candidate: unknown): SlideMarkup | null {
  if (!isObject(candidate)) return null;
  const markup = Reflect.get(candidate, "markup");
  const elements = parseList(Reflect.get(candidate, "elements"), parseStageElementRecord);
  const assetIds = parseList(Reflect.get(candidate, "assetIds"), parseAssetIdField);
  const fontFaces = parseList(Reflect.get(candidate, "fontFaces"), parseFontFaceRequest);
  if (typeof markup !== "string" || elements === null || assetIds === null || fontFaces === null) return null;
  return { markup, elements, assetIds, fontFaces };
}

const LEAF_KINDS: readonly StageElementRecord["kind"][] = ["shape", "image", "line", "table", "unsupported"];

function parseStageElementRecord(candidate: unknown): StageElementRecord | null {
  if (!isObject(candidate)) return null;
  const elementId = parseIdField(Reflect.get(candidate, "elementId"));
  const morphKey = Reflect.get(candidate, "morphKey");
  const kind = LEAF_KINDS.find((leafKind) => leafKind === Reflect.get(candidate, "kind"));
  const frame = Reflect.get(candidate, "frame");
  const bounds = Reflect.get(candidate, "bounds");
  const groupPath = parseList(Reflect.get(candidate, "groupPath"), parseIdField);
  if (elementId === null || typeof morphKey !== "string" || kind === undefined || groupPath === null || !isObject(frame) || !isObject(bounds)) return null;
  const x = numberField(frame, "x");
  const y = numberField(frame, "y");
  const width = numberField(frame, "width");
  const height = numberField(frame, "height");
  const rotation = numberField(frame, "rotation");
  const flipHorizontal = Reflect.get(frame, "flipHorizontal");
  const flipVertical = Reflect.get(frame, "flipVertical");
  const boundsX = numberField(bounds, "x");
  const boundsY = numberField(bounds, "y");
  const boundsWidth = numberField(bounds, "width");
  const boundsHeight = numberField(bounds, "height");
  if (x === null || y === null || width === null || height === null || rotation === null) return null;
  if (boundsX === null || boundsY === null || boundsWidth === null || boundsHeight === null) return null;
  if (typeof flipHorizontal !== "boolean" || typeof flipVertical !== "boolean") return null;
  return {
    elementId,
    morphKey,
    kind,
    frame: { x, y, width, height, rotation, flipHorizontal, flipVertical },
    bounds: { x: boundsX, y: boundsY, width: boundsWidth, height: boundsHeight },
    groupPath,
  };
}

function parseTransferredAsset(candidate: unknown): TransferredAsset | null {
  if (!isObject(candidate)) return null;
  const assetId = parseAssetIdField(Reflect.get(candidate, "assetId"));
  const mediaType = parseAssetMediaType(Reflect.get(candidate, "mediaType"));
  const bytes = Reflect.get(candidate, "bytes");
  if (assetId === null || mediaType === null || !(bytes instanceof ArrayBuffer)) return null;
  return { assetId, mediaType, bytes };
}

function parseTransferredFont(candidate: unknown): TransferredFont | null {
  const face = parseFontFaceRequest(candidate);
  if (face === null || !isObject(candidate)) return null;
  const bytes = Reflect.get(candidate, "bytes");
  return bytes instanceof ArrayBuffer ? { ...face, bytes } : null;
}

function parseFontFaceRequest(candidate: unknown): FontFaceRequest | null {
  if (!isObject(candidate)) return null;
  const family = Reflect.get(candidate, "family");
  const weight = Reflect.get(candidate, "weight");
  const style = Reflect.get(candidate, "style");
  if (typeof family !== "string" || !isPositiveNumber(weight) || (style !== "normal" && style !== "italic")) return null;
  return { family, weight, style };
}

function parseAssetIdField(candidate: unknown): AssetId | null {
  return typeof candidate === "string" ? parseAssetId(candidate) : null;
}

function parseIdField(candidate: unknown): ElementId | null {
  return typeof candidate === "string" ? parseElementId(candidate) : null;
}

function parseSerialisableObject(candidate: unknown): SerialisableObject | null {
  const value = parseSerialisableValue({ candidate, depth: 0 });
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // `parseSerialisableValue` built a plain object of serialisable values; the array case is excluded above.
  return value as SerialisableObject;
}

function parseSerialisableValue(options: Readonly<{ candidate: unknown; depth: number }>): SerialisableValue | undefined {
  const candidate = options.candidate;
  if (options.depth > 16) return undefined;
  if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
  if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : undefined;
  if (Array.isArray(candidate)) {
    const values: SerialisableValue[] = [];
    for (const entry of candidate) {
      const value = parseSerialisableValue({ candidate: entry, depth: options.depth + 1 });
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  }
  if (!isObject(candidate)) return undefined;
  const result: { [key: string]: SerialisableValue } = {};
  for (const key of Object.keys(candidate)) {
    const value = parseSerialisableValue({ candidate: Reflect.get(candidate, key), depth: options.depth + 1 });
    if (value === undefined) return undefined;
    result[key] = value;
  }
  return result;
}

function parseList<TItem>(candidate: unknown, parseItem: (item: unknown) => TItem | null): readonly TItem[] | null {
  if (!Array.isArray(candidate)) return null;
  const items: TItem[] = [];
  for (const entry of candidate) {
    const item = parseItem(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

function truncateLog(message: string): string {
  return message.length <= TRANSITION_LIMITS.maximumLogMessageLength ? message : message.slice(0, TRANSITION_LIMITS.maximumLogMessageLength);
}

function isRunId(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 64;
}

function isSequence(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0;
}

function isCancelReason(candidate: unknown): candidate is TransitionCancelReason {
  return candidate === "skippedByPresenter" || candidate === "superseded" || candidate === "presentationEnded";
}

function isDirection(candidate: unknown): candidate is TransitionDirection {
  return candidate === "forward" || candidate === "backward";
}

function isObject(candidate: unknown): candidate is object {
  return typeof candidate === "object" && candidate !== null;
}

function numberField(container: object, name: string): number | null {
  const value: unknown = Reflect.get(container, name);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPositiveNumber(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0;
}

function isNonNegativeNumber(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
}

function valid<TMessage>(message: TMessage): Parsed<TMessage> {
  return { kind: "valid", message };
}

function invalid<TMessage>(problem: string): Parsed<TMessage> {
  return { kind: "invalid", problem };
}

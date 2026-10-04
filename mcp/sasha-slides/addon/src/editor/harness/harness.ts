// THE HARNESS PAGE — the editor driven in a real browser, with no Apps Script anywhere near it.
//
//   npx tsx src/editor/harness/drive.e2e.ts
//
// It loads one of the four real candidates from mcp/sasha-slides/e2e/fixtures/ into a 1280x720
// iframe scaled by 0.7 (a deliberately odd factor: every coordinate in the editor is a fraction of
// the slide, so nothing may depend on the scale), attaches the editor, and shows `edits()` live.
//
// It also runs the ROUND-TRIP CHECK, which is the one property that cannot be unit-tested without a
// browser: feed `html()` into a second iframe, re-measure every element, and prove that
//
//   1. every element lands within half a pixel of where it is in the frame the user edited,
//   2. the edited elements' colours and text match their RECORDS, not just each other, and
//   3. every element the user did NOT touch is still exactly where the candidate's author put it
//      -- which is what makes "a move must not reflow the slide" a measurement instead of a claim.
//
// `window.sashaHarness` is the driver's handle on all of it.

import { createSlideEditor, type SlideEditor } from "../slide-editor.ts";
import { overridesOf, type SlideEdit, type TargetOverride } from "../slide-edit.ts";
import { selectorIndexOf } from "../stable-selector.ts";
import { hexOfCssColour } from "../css-colour.ts";

export type RoundTripCheck = Readonly<{ what: string; ok: boolean; detail: string }>;
export type RoundTripReport = Readonly<{ checks: readonly RoundTripCheck[] }>;

export type HarnessState = Readonly<{
  fixture: string | null;
  attached: boolean;
  selected: string | null;
  editCount: number;
}>;

/** Everything drive.e2e.ts is allowed to call. Pointer gestures are REAL input, never this. */
export type HarnessApi = Readonly<{
  load(fixture: string): Promise<void>;
  state(): HarnessState;
  edits(): readonly SlideEdit[];
  html(): string;
  undo(): boolean;
  /** Detach, so the driver can prove the chrome and the listeners really are gone. */
  detachEditor(): void;
  warnings(): readonly string[];
  /** A native `<input type="color">` cannot be opened by synthetic input, so the driver sets it. */
  setColour(options: Readonly<{ which: "text" | "background"; value: string }>): void;
  roundTrip(): Promise<RoundTripReport>;
}>;

declare global {
  interface Window {
    sashaHarness?: HarnessApi;
  }
}

/** Half a pixel of the 1280x720 slide: below anything a human or a renderer can mean. */
const TOLERANCE_PX = 0.5;

const FIXTURES: readonly string[] = ["01-text.html", "02-table.html", "03-image.html", "04-gradient-shadow.html"];

type Rect = Readonly<{ left: number; top: number; width: number; height: number }>;

const warnings: string[] = [];
let editor: SlideEditor | null = null;
let fixture: string | null = null;
/** Every element's rect at attach time, for the "nothing else moved" check. */
let baselineRects: ReadonlyMap<string, Rect> = new Map();

function main(): void {
  const header = required(document.getElementById("fixtures"));
  for (const name of FIXTURES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name.slice(0, 2);
    button.title = name;
    button.addEventListener("click", () => void load(name));
    header.append(button);
  }
  required(document.getElementById("undo")).addEventListener("click", () => {
    editor?.undo();
    render();
  });
  required(document.getElementById("roundtrip")).addEventListener("click", () => void runRoundTrip());
  window.sashaHarness = {
    load,
    state: () => ({
      fixture,
      attached: editor !== null,
      selected: selectedTargetOf(),
      editCount: editor?.edits().length ?? 0,
    }),
    edits: () => editor?.edits() ?? [],
    html: () => editor?.html() ?? "",
    undo: () => {
      const stepped = editor?.undo() ?? false;
      render();
      return stepped;
    },
    detachEditor: () => {
      editor?.detach();
      editor = null;
      render();
    },
    warnings: () => [...warnings],
    setColour: ({ which, value }) => {
      const input = required(document.querySelector<HTMLInputElement>(`.sasha-ed-bar input[title="${which === "text" ? "text colour" : "background"}"]`));
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    roundTrip: runRoundTrip,
  };
  void load(FIXTURES[0] ?? "01-text.html");
}

async function load(name: string): Promise<void> {
  editor?.detach();
  editor = null;
  warnings.length = 0;
  fixture = name;
  // Clear the round-trip evidence before the new candidate loads. A stale re-render next to a
  // different slide, and a stale report naming a selector that is not on it, reads as a bug in the
  // editor when it is only this page forgetting to tidy up.
  required(document.getElementById("report")).replaceChildren();
  required(document.querySelector<HTMLIFrameElement>("#verify")).srcdoc = "";
  const frame = slideFrame();
  const response = await fetch(`fixtures/${name}`);
  await renderInto({ frame, html: await response.text() });
  const created = createSlideEditor({
    onWarning: (message) => {
      warnings.push(message);
      render();
    },
  });
  created.attach({ frame, onChange: () => render() });
  editor = created;
  baselineRects = rectsOf(frame);
  for (const button of document.querySelectorAll<HTMLButtonElement>("#fixtures button")) {
    button.setAttribute("aria-pressed", button.title === name ? "true" : "false");
  }
  render();
}

/** srcdoc + an iframe `load` event: the same way the picker's authoritative pane renders. */
function renderInto({ frame, html }: { frame: HTMLIFrameElement; html: string }): Promise<void> {
  return new Promise((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
    frame.srcdoc = html;
  });
}

async function runRoundTrip(): Promise<RoundTripReport> {
  const current = editor;
  const list = required(document.getElementById("report"));
  if (current === null) {
    const report: RoundTripReport = { checks: [{ what: "an editor is attached", ok: false, detail: "nothing loaded" }] };
    paintReport({ list, report });
    return report;
  }
  const verify = required(document.querySelector<HTMLIFrameElement>("#verify"));
  await renderInto({ frame: verify, html: current.html() });
  const report = compareFrames({ edits: current.edits(), live: slideFrame(), rendered: verify });
  paintReport({ list, report });
  return report;
}

function compareFrames({
  edits,
  live,
  rendered,
}: {
  edits: readonly SlideEdit[];
  live: HTMLIFrameElement;
  rendered: HTMLIFrameElement;
}): RoundTripReport {
  const liveDom = documentOf(live);
  const renderedDom = documentOf(rendered);
  if (liveDom === null || renderedDom === null) {
    return { checks: [{ what: "both frames are reachable", ok: false, detail: "an iframe document was null" }] };
  }
  const overrides = overridesOf(edits);
  const edited = new Set(overrides.map((override) => override.target));
  const removed = new Set(overrides.filter((override) => override.removed).map((override) => override.target));
  const checks: RoundTripCheck[] = [];

  let worst = 0;
  let worstWhere = "nothing";
  let compared = 0;
  for (const [selector, liveRect] of rectsOf(live)) {
    if (removed.has(selector)) continue;
    const mirrored = renderedDom.querySelectorAll(selector);
    if (mirrored.length !== 1) continue;
    const node = mirrored[0];
    if (node === undefined) continue;
    compared++;
    const delta = rectDelta({ left: liveRect, right: rectOf(node) });
    if (delta > worst) {
      worst = delta;
      worstWhere = selector;
    }
  }
  checks.push({
    what: `every element re-renders where it is now (${compared} compared)`,
    ok: worst <= TOLERANCE_PX && compared > 0,
    detail: `worst delta ${worst.toFixed(2)}px at ${worstWhere}`,
  });

  // An edited element's DESCENDANTS travel with it (that is what moving a title means) and its
  // ANCESTORS legitimately grow around a resized child, so the check is about everything ELSE:
  // the siblings and the unrelated elements that a reflow would have shoved around.
  const editedNodes = [...edited].flatMap((target) => {
    const node = liveDom.querySelector(target);
    return node === null ? [] : [node];
  });
  let untouchedWorst = 0;
  let untouchedWhere = "nothing";
  for (const [selector, baseline] of baselineRects) {
    if (edited.has(selector)) continue;
    const node = liveDom.querySelectorAll(selector);
    if (node.length !== 1) continue;
    const current = node[0];
    if (current === undefined) continue;
    if (editedNodes.some((other) => other.contains(current) || current.contains(other))) continue;
    const delta = rectDelta({ left: baseline, right: rectOf(current) });
    if (delta > untouchedWorst) {
      untouchedWorst = delta;
      untouchedWhere = selector;
    }
  }
  // A MOVE must leave the rest of the slide alone -- that is the whole reason a move is a
  // `translate` and not `position: absolute`, and this is the measurement that proves it. A RESIZE
  // genuinely does reflow what follows an in-flow element, so when the edit list contains one the
  // check reports the reflow with its number instead of pretending the property still holds.
  const resized = overrides.some((override) => override.size !== null);
  checks.push({
    what: resized
      ? "a resize reflowed the elements after it (expected: a resize changes layout, a move does not)"
      : "no element outside the edited elements has moved",
    ok: resized || untouchedWorst <= TOLERANCE_PX,
    detail: `worst delta ${untouchedWorst.toFixed(2)}px at ${untouchedWhere}`,
  });

  for (const override of overrides) {
    checks.push(...checksForOverride({ override, liveDom, renderedDom }));
  }
  return { checks };
}

function checksForOverride({
  override,
  liveDom,
  renderedDom,
}: {
  override: TargetOverride;
  liveDom: Document;
  renderedDom: Document;
}): readonly RoundTripCheck[] {
  const checks: RoundTripCheck[] = [];
  const mirrored = renderedDom.querySelector(override.target);
  if (override.removed) {
    checks.push({
      what: `${override.target} is gone from html()`,
      ok: mirrored === null,
      detail: mirrored === null ? "absent" : "still present",
    });
    return checks;
  }
  if (mirrored === null) {
    checks.push({ what: `${override.target} survives html()`, ok: false, detail: "not found in the re-render" });
    return checks;
  }
  const liveNode = liveDom.querySelector(override.target);
  if (liveNode === null) {
    checks.push({ what: `${override.target} is still in the edited slide`, ok: false, detail: "not found" });
    return checks;
  }
  if (override.position !== null) {
    const asked = { x: override.position.to.x * 1280, y: override.position.to.y * 720 };
    const got = rectOf(mirrored);
    const delta = Math.max(Math.abs(asked.x - got.left), Math.abs(asked.y - got.top));
    checks.push({
      what: `${override.target} sits where the moved record says`,
      ok: delta <= TOLERANCE_PX,
      detail: `record ${asked.x.toFixed(1)},${asked.y.toFixed(1)} vs rendered ${got.left.toFixed(1)},${got.top.toFixed(1)}`,
    });
  }
  if (override.size !== null) {
    const asked = { w: override.size.to.w * 1280, h: override.size.to.h * 720 };
    const got = rectOf(mirrored);
    const delta = Math.max(Math.abs(asked.w - got.width), Math.abs(asked.h - got.height));
    checks.push({
      what: `${override.target} is the size the resized record says`,
      ok: delta <= TOLERANCE_PX,
      detail: `record ${asked.w.toFixed(1)}x${asked.h.toFixed(1)} vs rendered ${got.width.toFixed(1)}x${got.height.toFixed(1)}`,
    });
  }
  for (const colour of override.colours) {
    const view = renderedDom.defaultView;
    const computed = view === null ? "" : view.getComputedStyle(mirrored);
    const actual = computed === "" ? "" : hexOfCssColour(colour.property === "color" ? computed.color : computed.backgroundColor);
    checks.push({
      what: `${override.target} ${colour.property} is the recoloured record's value`,
      ok: actual.toLowerCase() === colour.to.toLowerCase(),
      detail: `record ${colour.to} vs rendered ${actual}`,
    });
  }
  if (override.text !== null) {
    const actual = (mirrored.textContent ?? "").replace(/\s+/g, " ").trim();
    checks.push({
      what: `${override.target} carries the retext record's words`,
      ok: actual === override.text,
      detail: `record "${override.text}" vs rendered "${actual}"`,
    });
  }
  return checks;
}

function paintReport({ list, report }: { list: HTMLElement; report: RoundTripReport }): void {
  list.replaceChildren(
    ...report.checks.map((check) => {
      const item = document.createElement("li");
      item.className = check.ok ? "ok" : "bad";
      item.textContent = `${check.ok ? "ok" : "FAIL"} - ${check.what} (${check.detail})`;
      return item;
    }),
  );
}

function render(): void {
  const current = editor;
  required(document.getElementById("edits")).textContent = JSON.stringify(current?.edits() ?? [], null, 1);
  required(document.getElementById("status")).textContent =
    current === null ? "no candidate loaded" : `${fixture ?? "?"} - ${current.edits().length} edit(s)`;
  required(document.getElementById("warnings")).replaceChildren(
    ...warnings.map((message) => {
      const item = document.createElement("li");
      item.textContent = message;
      return item;
    }),
  );
}

/** Every addressable element's rect, keyed by the selector the editor would give it. */
function rectsOf(frame: HTMLIFrameElement): ReadonlyMap<string, Rect> {
  const dom = documentOf(frame);
  const body = dom?.body ?? null;
  if (body === null) return new Map();
  const rects = new Map<string, Rect>();
  for (const [element, selector] of selectorIndexOf({ root: body }).targetOf) {
    rects.set(selector, rectOf(element));
  }
  return rects;
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

function rectDelta({ left, right }: { left: Rect; right: Rect }): number {
  return Math.max(
    Math.abs(left.left - right.left),
    Math.abs(left.top - right.top),
    Math.abs(left.width - right.width),
    Math.abs(left.height - right.height),
  );
}

function selectedTargetOf(): string | null {
  const label = document.querySelector(".sasha-ed-target");
  const bar = document.querySelector<HTMLElement>(".sasha-ed-bar");
  if (label === null || bar === null || bar.style.display === "none") return null;
  const text = label.textContent;
  return text === null || text === "" ? null : text;
}

function slideFrame(): HTMLIFrameElement {
  return required(document.querySelector<HTMLIFrameElement>("#slide"));
}

function documentOf(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}

/** The harness owns its own page, so a missing node is a bug in the page, not a runtime case. */
function required<TElement>(node: TElement | null): TElement {
  if (node === null) throw new Error("the harness page is missing a node it just built");
  return node;
}

main();

// THE DIAGRAM DIALOG'S STATE: one value, changed only by `reduceDiagram`. diagram.tsx renders it and
// runs the effects (the editor frame, the server calls); this file decides nothing that needs I/O,
// so every transition is a unit test (diagram-state.test.ts).

import type { DiagramModel, DiagramSeed, DiagramSourceRead } from "./diagram-wire.ts";
import { assertNever } from "./protocol.ts";

/** What the editor is open on: a diagram of the deck (by entry key, diagram-flow.ts), or a new one. */
export type EditTarget =
  | Readonly<{ kind: "existing"; entryKey: string; editedObjectId: string | null }>
  | Readonly<{ kind: "new" }>;

export type EditorStatus = "loading" | "ready" | "saving";

export type DiagramView =
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "editing"; target: EditTarget; seedXml: string; status: EditorStatus; exitAfterSave: boolean }>;

export type Notice = Readonly<{ tone: "info" | "success" | "error"; text: string }>;

export type DiagramState = Readonly<{
  /** Null until the seed is read, and when it could not be. */
  model: DiagramModel | null;
  failure: string | null;
  /** Sources read so far, by Drive file id. */
  sources: ReadonlyMap<string, DiagramSourceRead>;
  view: DiagramView;
  /** A sentence while a list action runs (reading, drawing, saving); null when idle. */
  busy: string | null;
  notice: Notice | null;
}>;

export type DiagramEvent =
  | Readonly<{ kind: "seeded"; seed: DiagramSeed }>
  | Readonly<{ kind: "seed-failed"; reason: string }>
  | Readonly<{ kind: "sources-read"; reads: readonly DiagramSourceRead[] }>
  | Readonly<{ kind: "busy"; text: string }>
  | Readonly<{ kind: "finished"; model: DiagramModel | null; notice: Notice }>
  | Readonly<{ kind: "edit-opened"; target: EditTarget; seedXml: string }>
  | Readonly<{ kind: "editor-ready" }>
  | Readonly<{ kind: "save-started"; exitAfterSave: boolean }>
  /** A save Code.gs confirmed: the new model and source, and what the editor is now open on. */
  | Readonly<{ kind: "saved"; model: DiagramModel; source: DiagramSourceRead; target: EditTarget; text: string }>
  | Readonly<{ kind: "save-failed"; text: string }>
  | Readonly<{ kind: "editor-closed" }>;

export const INITIAL_DIAGRAM_STATE: DiagramState = {
  model: null,
  failure: null,
  sources: new Map(),
  view: { kind: "list" },
  busy: null,
  notice: null,
};

export function reduceDiagram(state: DiagramState, event: DiagramEvent): DiagramState {
  switch (event.kind) {
    case "seeded":
      return {
        ...state,
        model: event.seed.model,
        failure: null,
        sources: event.seed.selectedSource === null ? state.sources : withSources({ sources: state.sources, reads: [event.seed.selectedSource] }),
      };
    case "seed-failed":
      return { ...state, model: null, failure: event.reason };
    case "sources-read":
      return { ...state, sources: withSources({ sources: state.sources, reads: event.reads }) };
    case "busy":
      return { ...state, busy: event.text, notice: null };
    case "finished":
      return { ...state, busy: null, model: event.model ?? state.model, notice: event.notice };
    case "edit-opened":
      return { ...state, busy: null, notice: null, view: { kind: "editing", target: event.target, seedXml: event.seedXml, status: "loading", exitAfterSave: false } };
    case "editor-ready":
      return state.view.kind === "editing" && state.view.status === "loading" ? { ...state, view: { ...state.view, status: "ready" } } : state;
    case "save-started":
      // One save at a time: a second Save while one is running is ignored, never sent twice.
      if (state.view.kind !== "editing" || state.view.status === "saving") return state;
      return { ...state, notice: { tone: "info", text: "Saving the diagram..." }, view: { ...state.view, status: "saving", exitAfterSave: event.exitAfterSave } };
    case "saved": {
      const sources = withSources({ sources: state.sources, reads: [event.source] });
      const notice: Notice = { tone: "success", text: event.text };
      if (state.view.kind !== "editing" || state.view.exitAfterSave) return { ...state, model: event.model, sources, notice, view: { kind: "list" } };
      return { ...state, model: event.model, sources, notice, view: { ...state.view, target: event.target, status: "ready", exitAfterSave: false } };
    }
    case "save-failed":
      if (state.view.kind !== "editing") return { ...state, notice: { tone: "error", text: event.text } };
      return { ...state, notice: { tone: "error", text: event.text }, view: { ...state.view, status: "ready", exitAfterSave: false } };
    case "editor-closed":
      // Closing while a save runs would drop its answer; the save closes the editor when it lands.
      if (state.view.kind === "editing" && state.view.status === "saving") return { ...state, view: { ...state.view, exitAfterSave: true } };
      return { ...state, view: { kind: "list" } };
    default:
      return assertNever(event);
  }
}

/** Is the editor open and able to take a Save right now. */
export function canSave(state: DiagramState): boolean {
  return state.view.kind === "editing" && state.view.status !== "saving";
}

function withSources(options: Readonly<{ sources: ReadonlyMap<string, DiagramSourceRead>; reads: readonly DiagramSourceRead[] }>): ReadonlyMap<string, DiagramSourceRead> {
  const next = new Map(options.sources);
  for (const read of options.reads) next.set(read.fileId, read);
  return next;
}

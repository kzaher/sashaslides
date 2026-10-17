// DIAGRAM.HTML: the draw.io diagram dialog (menu "Edit diagram", diagram-code-gs.ts).
//
// It lists the deck's diagrams (the selected one first), opens the self-hosted draw.io editor on one
// of them, and saves through ONE server call per save (sashaSaveDiagram): the copy-on-write plan is
// computed here (diagram-flow.ts), Code.gs executes it (diagram-host.ts). It also draws a new
// diagram, uploads a .drawio / .drawio.svg / .drawio.png / .xml file as a new picture, and redraws
// pictures that are older than their source ("Update stale pictures": an agent wrote new XML through
// the connector, or another deck saved the file in place).
//
// This file is the composition root and the effects; every decision is in diagram-state.ts,
// diagram-flow.ts and diagram-wire.ts under unit tests.

import { useEffect, useRef, type ReactElement } from "react";
import { mxfileFromPngBytes, parseDrawioSource } from "../../converter/drawio-diagram.ts";
import { DRAWIO_RENDER_SCALE, drawioEditorAddress, drawioLoadAction, parseDrawioMessage, renderDrawioPicture, type DrawioAction } from "../../converter/drawio-embed.ts";
import { appsScriptCall, appsScriptDiagramApi } from "./bridge-client.ts";
import {
  BLANK_DIAGRAM_XML,
  diagramEntriesOf,
  editSaveSpec,
  modelAfterSave,
  newDiagramSaveSpec,
  refreshSaveSpec,
  staleEntriesOf,
  type DiagramEntry,
  type PlannedSave,
} from "./diagram-flow.ts";
import { DIAGRAM_CSS } from "./diagram-styles.ts";
import { canSave, INITIAL_DIAGRAM_STATE, reduceDiagram, type DiagramEvent, type DiagramState, type EditTarget } from "./diagram-state.ts";
import { DIAGRAM_SEED_ELEMENT_ID, parseDiagramSeed, type DiagramModel, type DiagramSourceRead } from "./diagram-wire.ts";
import type { DiagramApi } from "./drive-api.ts";
import { assertNever, describeParsedFailure } from "./protocol.ts";
import { newPageObjectId } from "./slide-insert.ts";
import { seedText, surfaceRenderer } from "./surface-host.ts";

const EDITOR_ORIGIN = __SASHA_EDITOR_ORIGIN__;

let state: DiagramState = INITIAL_DIAGRAM_STATE;
const renderSurface = surfaceRenderer();
const diagrams: DiagramApi = appsScriptDiagramApi({ call: appsScriptCall({ run: google.script.run }) });
/** The editor frame, while the editor is open. */
let editorFrame: HTMLIFrameElement | null = null;
/** The XML of the save in flight, until draw.io answers the PNG export. */
let pendingXml: string | null = null;

function dispatch(event: DiagramEvent): void {
  state = reduceDiagram(state, event);
  render();
}

async function main(): Promise<void> {
  const style = document.createElement("style");
  style.textContent = DIAGRAM_CSS;
  document.head.append(style);
  window.addEventListener("message", onEditorMessage);
  render();
  const text = await seedText(DIAGRAM_SEED_ELEMENT_ID);
  if (text === null) {
    dispatch({ kind: "seed-failed", reason: "Code.gs sent no seed. Close this window and choose Edit diagram again." });
    return;
  }
  const parsed = parseDiagramSeed(text);
  switch (parsed.kind) {
    case "ok":
      dispatch({ kind: "seeded", seed: parsed.value });
      return;
    case "invalid":
    case "unsupported-version":
      dispatch({ kind: "seed-failed", reason: describeParsedFailure({ parsed, what: "The diagram dialog's seed" }) });
      return;
    default:
      return assertNever(parsed);
  }
}

// ---------------------------------------------------------------------------------------------
// The editor frame: draw.io's JSON embed protocol (drawio-embed.ts), from its own origin only.
// ---------------------------------------------------------------------------------------------

function onEditorMessage(message: MessageEvent): void {
  if (editorFrame === null || message.source !== editorFrame.contentWindow || message.origin !== new URL(EDITOR_ORIGIN).origin) return;
  const event = parseDrawioMessage(message.data);
  if (event === null || state.view.kind !== "editing") return;
  switch (event.kind) {
    case "init":
      postToEditor(drawioLoadAction({ seed: state.view.seedXml, autosave: false }));
      return;
    case "load":
      dispatch({ kind: "editor-ready" });
      return;
    case "save":
      if (!canSave(state)) return;
      pendingXml = event.xml;
      dispatch({ kind: "save-started", exitAfterSave: event.exit });
      postToEditor({ action: "export", format: "xmlpng", scale: DRAWIO_RENDER_SCALE, border: 0, spin: "Saving" });
      return;
    case "export": {
      const xml = event.xml ?? pendingXml;
      pendingXml = null;
      if (xml === null || state.view.kind !== "editing" || state.view.status !== "saving") return;
      void saveFromEditor({ target: state.view.target, xml, pngDataUrl: event.data });
      return;
    }
    case "exit":
      dispatch({ kind: "editor-closed" });
      return;
    case "autosave":
      return;
    default:
      return assertNever(event);
  }
}

function postToEditor(action: DrawioAction): void {
  editorFrame?.contentWindow?.postMessage(JSON.stringify(action), new URL(EDITOR_ORIGIN).origin);
}

/** The editor's Save: plan, one server call, then the model and the editor catch up. */
async function saveFromEditor(options: Readonly<{ target: EditTarget; xml: string; pngDataUrl: string }>): Promise<void> {
  const model = state.model;
  if (model === null) return;
  switch (options.target.kind) {
    case "existing": {
      const entryKey = options.target.entryKey;
      const entry = diagramEntriesOf(model).find((candidate) => candidate.key === entryKey);
      if (entry === undefined) {
        dispatch({ kind: "save-failed", text: "The diagram is no longer in the presentation's list. Close the editor and open it again." });
        return;
      }
      const source = entry.fileId === null ? null : (state.sources.get(entry.fileId) ?? null);
      const planned = editSaveSpec({ model, entry, source, xml: options.xml, pngDataUrl: options.pngDataUrl, editedObjectId: options.target.editedObjectId });
      if (planned.kind === "refused") return dispatch({ kind: "save-failed", text: planned.reason });
      await runSave({ model, planned: planned.value, added: null, editedObjectId: options.target.editedObjectId });
      return;
    }
    case "new": {
      const objectId = newPageObjectId({ random: Math.random });
      const planned = newDiagramSaveSpec({ model, xml: options.xml, pngDataUrl: options.pngDataUrl, objectId });
      if (planned.kind === "refused") return dispatch({ kind: "save-failed", text: planned.reason });
      await runSave({ model, planned: planned.value, added: { pageObjectId: planned.value.pageObjectId, box: planned.value.box }, editedObjectId: objectId });
      return;
    }
    default:
      return assertNever(options.target);
  }
}

async function runSave(
  options: Readonly<{ model: DiagramModel; planned: PlannedSave; added: Parameters<typeof modelAfterSave>[0]["added"]; editedObjectId: string | null }>,
): Promise<void> {
  const saved = await diagrams.save(options.planned.spec);
  if (saved.kind !== "ok") {
    dispatch({ kind: "save-failed", text: `The diagram was not saved: ${saved.message}` });
    return;
  }
  const model = modelAfterSave({ model: options.model, planned: options.planned, saved: saved.value, added: options.added });
  const parentFolderIds = saved.value.folderId === null ? [] : [saved.value.folderId];
  const previous = state.sources.get(saved.value.fileId);
  const source: DiagramSourceRead = {
    kind: "read",
    fileId: saved.value.fileId,
    name: options.planned.spec.file.kind === "create" ? options.planned.spec.file.fileName : previous?.kind === "read" ? previous.name : "",
    parentFolderIds: previous?.kind === "read" ? previous.parentFolderIds : parentFolderIds,
    xml: options.planned.spec.xml,
  };
  dispatch({
    kind: "saved",
    model,
    source,
    target: { kind: "existing", entryKey: `file:${saved.value.fileId}`, editedObjectId: options.editedObjectId },
    text: savedSentence({ planned: options.planned, created: saved.value.created }),
  });
  postToEditor({ action: "status", message: "Saved", modified: false });
}

function savedSentence(options: Readonly<{ planned: PlannedSave; created: boolean }>): string {
  const pictures = options.planned.imageObjectIds.length;
  const updated = `${String(pictures)} picture${pictures === 1 ? "" : "s"} updated`;
  switch (options.planned.spec.file.kind) {
    case "update":
      return `Saved ${options.planned.diagramId}: ${updated}.`;
    case "create":
      return `Saved ${options.planned.diagramId} as a new file in this presentation's folder: ${updated}. The original file was not changed.`;
    case "keep":
      return `Redrew ${options.planned.diagramId}: ${updated}.`;
    default:
      return assertNever(options.planned.spec.file);
  }
}

// ---------------------------------------------------------------------------------------------
// The list's actions.
// ---------------------------------------------------------------------------------------------

async function openEntry(entry: DiagramEntry): Promise<void> {
  const editedObjectId = (entry.pictures.find((picture) => state.model?.selection.objectIds.includes(picture.objectId)) ?? entry.pictures[0])?.objectId ?? null;
  if (entry.fileId === null) {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: "This picture names a diagram but links to no source file, so there is nothing to edit. Upload its .drawio file to add it again." } });
    return;
  }
  const source = await sourceOf(entry.fileId);
  if (source === null) return;
  if (source.kind === "unreadable") {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: source.reason } });
    return;
  }
  dispatch({ kind: "edit-opened", target: { kind: "existing", entryKey: entry.key, editedObjectId }, seedXml: source.xml });
}

/** A source from what this window has read, or ONE server call for it; null after a reported failure. */
async function sourceOf(fileId: string): Promise<DiagramSourceRead | null> {
  const known = state.sources.get(fileId);
  if (known !== undefined) return known;
  dispatch({ kind: "busy", text: "Reading the diagram's source..." });
  const read = await diagrams.readSources([fileId]);
  if (read.kind !== "ok") {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: `The diagram's source could not be read: ${read.message}` } });
    return null;
  }
  dispatch({ kind: "sources-read", reads: read.value });
  dispatch({ kind: "finished", model: null, notice: { tone: "info", text: "" } });
  return state.sources.get(fileId) ?? null;
}

async function uploadFile(file: File): Promise<void> {
  const model = state.model;
  if (model === null) return;
  dispatch({ kind: "busy", text: `Reading ${file.name}...` });
  const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
  const text = isPng ? mxfileFromPngBytes(new Uint8Array(await file.arrayBuffer())) : await file.text();
  const parsed = text === null ? { kind: "invalid" as const, reason: "the PNG carries no draw.io source" } : parseDrawioSource(text);
  if (parsed.kind === "invalid") {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: `${file.name} is not a draw.io diagram: ${parsed.reason}` } });
    return;
  }
  dispatch({ kind: "busy", text: `Drawing ${file.name}...` });
  const rendered = await renderDrawioPicture({ document, editorOrigin: EDITOR_ORIGIN, xml: parsed.xml });
  if (rendered.kind === "failed") {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: `${file.name} could not be drawn: ${rendered.reason}` } });
    return;
  }
  const objectId = newPageObjectId({ random: Math.random });
  const planned = newDiagramSaveSpec({ model, xml: parsed.xml, pngDataUrl: rendered.picture.pngDataUrl, objectId });
  if (planned.kind === "refused") {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: planned.reason } });
    return;
  }
  dispatch({ kind: "busy", text: `Adding ${file.name} to the slide...` });
  const saved = await diagrams.save(planned.value.spec);
  if (saved.kind !== "ok") {
    dispatch({ kind: "finished", model: null, notice: { tone: "error", text: `${file.name} was not added: ${saved.message}` } });
    return;
  }
  dispatch({
    kind: "finished",
    model: modelAfterSave({ model, planned: planned.value, saved: saved.value, added: { pageObjectId: planned.value.pageObjectId, box: planned.value.box } }),
    notice: { tone: "success", text: `Added ${file.name} as ${planned.value.diagramId}, linked to its source in this presentation's folder.` },
  });
}

/** Read every linked source not read yet (one call), then redraw each diagram whose pictures are older. */
async function updateStalePictures(): Promise<void> {
  const startModel = state.model;
  if (startModel === null) return;
  const entries = diagramEntriesOf(startModel);
  const unread = entries.flatMap((entry) => (entry.fileId !== null && !state.sources.has(entry.fileId) ? [entry.fileId] : []));
  if (unread.length > 0) {
    dispatch({ kind: "busy", text: "Reading the diagrams' sources..." });
    const read = await diagrams.readSources(unread);
    if (read.kind !== "ok") {
      dispatch({ kind: "finished", model: null, notice: { tone: "error", text: `The sources could not be read: ${read.message}` } });
      return;
    }
    dispatch({ kind: "sources-read", reads: read.value });
  }
  const stale = staleEntriesOf({ entries, sources: state.sources });
  if (stale.length === 0) {
    dispatch({ kind: "finished", model: null, notice: { tone: "success", text: "Every diagram picture matches its source." } });
    return;
  }
  let model = startModel;
  let redrawn = 0;
  for (const { entry, source } of stale) {
    dispatch({ kind: "busy", text: `Redrawing ${source.name || entry.key} (${String(redrawn + 1)} of ${String(stale.length)})...` });
    const rendered = await renderDrawioPicture({ document, editorOrigin: EDITOR_ORIGIN, xml: source.xml });
    if (rendered.kind === "failed") {
      dispatch({ kind: "finished", model, notice: { tone: "error", text: `${source.name} could not be drawn: ${rendered.reason}` } });
      return;
    }
    const planned = refreshSaveSpec({ model, entry, source, pngDataUrl: rendered.picture.pngDataUrl });
    if (planned.kind === "refused") {
      dispatch({ kind: "finished", model, notice: { tone: "error", text: planned.reason } });
      return;
    }
    const saved = await diagrams.save(planned.value.spec);
    if (saved.kind !== "ok") {
      dispatch({ kind: "finished", model, notice: { tone: "error", text: `${source.name} was not redrawn: ${saved.message}` } });
      return;
    }
    model = modelAfterSave({ model, planned: planned.value, saved: saved.value, added: null });
    redrawn += 1;
  }
  dispatch({ kind: "finished", model, notice: { tone: "success", text: `Redrew ${String(redrawn)} diagram${redrawn === 1 ? "" : "s"} from ${redrawn === 1 ? "its source" : "their sources"}.` } });
}

// ---------------------------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------------------------

function render(): void {
  renderSurface(<DiagramWindow state={state} />);
}

function DiagramWindow({ state: current }: Readonly<{ state: DiagramState }>): ReactElement {
  if (current.view.kind === "editing") return <EditorView state={current} />;
  return <ListView state={current} />;
}

function ListView({ state: current }: Readonly<{ state: DiagramState }>): ReactElement {
  const model = current.model;
  const entries = model === null ? [] : diagramEntriesOf(model);
  const busy = current.busy !== null;
  return (
    <main className="sasha-diagram-list">
      <header className="sasha-diagram-header">
        <h1>Diagrams</h1>
        <div className="sasha-diagram-actions">
          <button type="button" className="sasha-diagram-primary" disabled={busy || model === null} onClick={() => dispatch({ kind: "edit-opened", target: { kind: "new" }, seedXml: BLANK_DIAGRAM_XML })}>
            New diagram
          </button>
          <label className={`sasha-diagram-secondary${busy || model === null ? " sasha-diagram-disabled" : ""}`}>
            Upload a diagram
            <input
              type="file"
              accept=".drawio,.xml,.svg,.png,application/xml,image/svg+xml,image/png"
              disabled={busy || model === null}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                input.value = "";
                if (file !== undefined) void uploadFile(file);
              }}
            />
          </label>
          <button type="button" className="sasha-diagram-secondary" disabled={busy || entries.length === 0} onClick={() => void updateStalePictures()}>
            Update stale pictures
          </button>
        </div>
      </header>
      {current.failure !== null ? <p className="sasha-diagram-notice sasha-diagram-error">{current.failure}</p> : null}
      {current.busy !== null ? <p className="sasha-diagram-notice">{current.busy}</p> : null}
      {current.busy === null && current.notice !== null && current.notice.text !== "" ? <p className={`sasha-diagram-notice sasha-diagram-${current.notice.tone}`}>{current.notice.text}</p> : null}
      {model === null && current.failure === null ? <p className="sasha-diagram-empty">Reading the presentation...</p> : null}
      {model !== null && entries.length === 0 ? (
        <p className="sasha-diagram-empty">This presentation has no draw.io diagrams yet. Draw a new one, or upload a .drawio file.</p>
      ) : null}
      <ul className="sasha-diagram-rows">
        {entries.map((entry) => (
          <li key={entry.key} className={entry.selected ? "sasha-diagram-row sasha-diagram-selected" : "sasha-diagram-row"}>
            <div>
              <strong>{entryTitle({ entry, sources: current.sources })}</strong>
              <span className="sasha-diagram-meta">{entryDetail({ entry, sources: current.sources })}</span>
            </div>
            <button type="button" className="sasha-diagram-primary" disabled={busy} onClick={() => void openEntry(entry)}>
              Edit
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

function EditorView({ state: current }: Readonly<{ state: DiagramState }>): ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    editorFrame = frameRef.current;
    return () => {
      editorFrame = null;
    };
  }, []);
  const view = current.view;
  const status = view.kind === "editing" ? view.status : "loading";
  return (
    <main className="sasha-diagram-editor">
      <div className="sasha-diagram-bar">
        <button type="button" className="sasha-diagram-secondary" onClick={() => dispatch({ kind: "editor-closed" })}>
          Back to the diagrams
        </button>
        <span className={current.notice === null ? "sasha-diagram-status" : `sasha-diagram-status sasha-diagram-${current.notice.tone}`}>
          {current.notice?.text ?? (status === "loading" ? "Opening draw.io..." : "Save in draw.io updates every picture of this diagram in this presentation.")}
        </span>
      </div>
      <iframe ref={frameRef} className="sasha-diagram-frame" title="draw.io editor" src={drawioEditorAddress({ origin: EDITOR_ORIGIN, interactive: true })} />
    </main>
  );
}

function entryTitle(options: Readonly<{ entry: DiagramEntry; sources: ReadonlyMap<string, DiagramSourceRead> }>): string {
  const source = options.entry.fileId === null ? undefined : options.sources.get(options.entry.fileId);
  if (source?.kind === "read" && source.name !== "") return source.name;
  return options.entry.stampedDiagramId ?? "Linked diagram";
}

function entryDetail(options: Readonly<{ entry: DiagramEntry; sources: ReadonlyMap<string, DiagramSourceRead> }>): string {
  const slides = [...new Set(options.entry.pictures.map((picture) => picture.slideNumber))].sort((left, right) => left - right);
  const where = `${slides.length === 1 ? "Slide" : "Slides"} ${slides.join(", ")}`;
  const count = options.entry.pictures.length;
  const pictures = count === 1 ? "" : ` · ${String(count)} pictures`;
  const selected = options.entry.selected ? " · selected" : "";
  const source = options.entry.fileId === null ? undefined : options.sources.get(options.entry.fileId);
  const stale = source?.kind === "read" && staleEntriesOf({ entries: [options.entry], sources: options.sources }).length > 0 ? " · older than its source" : "";
  const unreadable = source?.kind === "unreadable" ? " · source unreadable" : "";
  const unlinked = options.entry.fileId === null ? " · no source file" : "";
  return `${where}${pictures}${selected}${stale}${unreadable}${unlinked}`;
}

// The bundle runs in the HtmlService page; under the unit tests there is no document.
if (typeof document !== "undefined") void main();

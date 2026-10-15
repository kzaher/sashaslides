// THE DIALOGS: a `.sasha-scrim` dimming layer (never a blur of the canvas) under a `.sasha-dialog`
// in nearly opaque glass, one per `EditorDialog` kind -- insert an image, insert a table, edit a
// link, the transition script editor, keyboard shortcuts, rename, new slide from a layout (SPEC.md
// section 9). Escape or a click on the scrim closes; the first field takes focus.
//
// THE SCRIPT DIALOG is a plain-text code editor (system monospace, Tab inserts two spaces) over the
// state's `TransitionScriptEditor`: Save is a person approving what they saved; a script written by
// an agent or pasted from another deck shows its author and full text and an "Approve" button; a
// save that lost a race offers "Reload theirs" or "Overwrite" (SPEC.md section 9). Run plays the
// saved transition into the current slide with the presenter's `TransitionPreview`. A BUILD STEP
// script (purpose "animation") is worded as one, and its Run plays the current slide's builds with
// `BuildPreview` instead.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { TransitionScriptDraft } from "../../contracts/commands.ts";
import { scriptFingerprint, type DocumentSnapshot, type ScriptPurpose, type TransitionScriptRecord } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorDialog, EditorState, TransitionScriptEditor } from "../../contracts/editor-state.ts";
import type { LayoutId, SlideId } from "../../contracts/ids.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { shallowEqual, useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon } from "./icons.tsx";
import { shortcutRows } from "./menu-model.ts";
import { shortcutStyle } from "./menus.tsx";

export function DialogLayer(): ReactElement | null {
  const dialog = useEditorSelector((state) => state.chrome.dialog);
  const dispatch = useEditorServices().system.dispatch;
  if (!dialogIsOpen(dialog)) return null;
  const close = (): void => dispatch({ kind: "dialogClosed" });
  return (
    <>
      <div className={TIDEPOOL_CLASS.scrim} onPointerDown={close} aria-hidden="true" />
      <div className={VIEW_CLASS.dialogLayer}>
        <DialogBody dialog={dialog} close={close} />
      </div>
    </>
  );
}

function dialogIsOpen(dialog: EditorDialog): boolean {
  switch (dialog.kind) {
    case "none":
      return false;
    case "insertImage":
    case "insertTable":
    case "linkEditor":
    case "transitionScriptEditor":
    case "keyboardShortcuts":
    case "renameDeck":
    case "newSlideFromLayout":
      return true;
    default:
      return assertNever(dialog);
  }
}

function DialogBody(properties: Readonly<{ dialog: EditorDialog; close: () => void }>): ReactElement | null {
  const dialog = properties.dialog;
  switch (dialog.kind) {
    case "none":
      return null;
    case "insertImage":
      return <InsertImageDialog close={properties.close} />;
    case "insertTable":
      return <InsertTableDialog close={properties.close} />;
    case "linkEditor":
      return <LinkDialog close={properties.close} />;
    case "transitionScriptEditor":
      return <TransitionScriptDialog editor={dialog.editor} close={properties.close} />;
    case "keyboardShortcuts":
      return <ShortcutsDialog close={properties.close} />;
    case "renameDeck":
      return <RenameDialog close={properties.close} />;
    case "newSlideFromLayout":
      return <LayoutDialog layoutIds={dialog.layoutIds} close={properties.close} />;
    default:
      return assertNever(dialog);
  }
}

/** The dialog frame: title, body, actions; Escape closes, the first field is focused. */
export function Dialog(properties: Readonly<{ title: string; close: () => void; children: ReactNode; actions: ReactNode; wide?: boolean }>): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, textarea, select, button:not([data-close])")?.focus();
  }, []);
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={properties.title}
      className={`${TIDEPOOL_CLASS.dialog}${properties.wide === true ? ` ${VIEW_CLASS.scriptDialog}` : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          properties.close();
        }
      }}
    >
      <div className={VIEW_CLASS.dialogHeader}>
        <h2 className={VIEW_CLASS.dialogTitle}>{properties.title}</h2>
        <button type="button" data-close="" className={TIDEPOOL_CLASS.iconButton} style={{ marginInlineStart: "auto" }} aria-label="Close" onClick={properties.close}>
          <Icon name="close" />
        </button>
      </div>
      <div className={VIEW_CLASS.dialogBody}>{properties.children}</div>
      <div className={VIEW_CLASS.dialogActions}>{properties.actions}</div>
    </div>
  );
}

function InsertImageDialog(properties: Readonly<{ close: () => void }>): ReactElement {
  const services = useEditorServices();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog title="Insert an image" close={properties.close} actions={<button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={properties.close}>Cancel</button>}>
      <p className={TIDEPOOL_CLASS.muted} style={{ margin: 0 }}>
        PNG, JPEG, GIF, WebP or SVG. You can also paste an image, or drop one onto the slide.
      </p>
      <input
        type="file"
        className={TIDEPOOL_CLASS.field}
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        aria-label="Image file"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          void Promise.all(files.map((file) => services.readImageFile(file))).then((read) => {
            const chosen = read.filter((file): file is NonNullable<typeof file> => file !== null);
            if (chosen.length === 0) {
              setProblem("That file is not an image this editor can use.");
              return;
            }
            services.system.dispatch({ kind: "imageFilesChosen", files: chosen, at: null, destination: "newImage" });
            properties.close();
          });
        }}
      />
      {problem === null ? null : <p className={TIDEPOOL_CLASS.notice} data-tone="error">{problem}</p>}
    </Dialog>
  );
}

function InsertTableDialog(properties: Readonly<{ close: () => void }>): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  const [rows, setRows] = useState("3");
  const [columns, setColumns] = useState("3");
  const rowCount = Math.max(1, Math.min(20, Math.round(Number(rows) || 0)));
  const columnCount = Math.max(1, Math.min(20, Math.round(Number(columns) || 0)));
  return (
    <Dialog
      title="Insert a table"
      close={properties.close}
      actions={
        <>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={properties.close}>Cancel</button>
          <button
            type="button"
            className={TIDEPOOL_CLASS.primaryPill}
            onClick={() => {
              dispatch({ kind: "toolChosen", tool: { kind: "table", rowCount, columnCount } });
              properties.close();
            }}
          >
            Draw the table
          </button>
        </>
      }
    >
      <div className={VIEW_CLASS.fieldGrid}>
        <label className={VIEW_CLASS.fieldLabel}>
          <span>Rows</span>
          <input className={TIDEPOOL_CLASS.field} inputMode="numeric" value={rows} onChange={(event) => setRows(event.currentTarget.value)} />
        </label>
        <label className={VIEW_CLASS.fieldLabel}>
          <span>Columns</span>
          <input className={TIDEPOOL_CLASS.field} inputMode="numeric" value={columns} onChange={(event) => setColumns(event.currentTarget.value)} />
        </label>
      </div>
      <p className={VIEW_CLASS.explanation}>
        Then drag on the slide where the {rowCount} by {columnCount} table goes, or click for the default size.
      </p>
    </Dialog>
  );
}

function LinkDialog(properties: Readonly<{ close: () => void }>): ReactElement {
  const services = useEditorServices();
  const slides = useEditorSelector((state) => state.document.slides);
  const [address, setAddress] = useState("");
  const [slideId, setSlideId] = useState("");
  const dispatch = services.system.dispatch;
  const apply = (): void => {
    const slide = slides.find((candidate) => candidate.id === slideId);
    if (slide !== undefined) dispatch({ kind: "runStyleRequested", patch: { link: { kind: "slide", slideId: slide.id } }, clear: [] });
    else if (address.trim().length > 0) dispatch({ kind: "runStyleRequested", patch: { link: { kind: "webAddress", address: address.trim() } }, clear: [] });
    properties.close();
  };
  return (
    <Dialog
      title="Link"
      close={properties.close}
      actions={
        <>
          <button type="button" className={TIDEPOOL_CLASS.dangerPill} onClick={() => { dispatch({ kind: "runStyleRequested", patch: { link: { kind: "none" } }, clear: [] }); properties.close(); }}>
            Remove link
          </button>
          <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={apply}>Apply</button>
        </>
      }
    >
      <label className={VIEW_CLASS.fieldLabel}>
        <span>Web address</span>
        <input className={TIDEPOOL_CLASS.field} value={address} placeholder="https://" onChange={(event) => setAddress(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && apply()} />
      </label>
      <label className={VIEW_CLASS.fieldLabel}>
        <span>Or a slide of this deck</span>
        <select className={VIEW_CLASS.select} value={slideId} onChange={(event) => setSlideId(event.currentTarget.value)}>
          <option value="">No slide</option>
          {slides.map((slide, index) => (
            <option key={slide.id} value={slide.id}>
              Slide {index + 1}
            </option>
          ))}
        </select>
      </label>
    </Dialog>
  );
}

function ShortcutsDialog(properties: Readonly<{ close: () => void }>): ReactElement {
  const services = useEditorServices();
  return (
    <Dialog title="Keyboard shortcuts" close={properties.close} actions={<button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={properties.close}>Done</button>}>
      <table className={VIEW_CLASS.shortcutTable}>
        <tbody>
          {shortcutRows(shortcutStyle(services.primaryModifier)).map((row) => (
            <tr key={row.action}>
              <td>
                <kbd>{row.keys}</kbd>
              </td>
              <td>{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

function RenameDialog(properties: Readonly<{ close: () => void }>): ReactElement {
  const services = useEditorServices();
  const title = useEditorSelector((state) => state.document.title);
  const [draft, setDraft] = useState(title);
  const rename = (): void => services.system.dispatch({ kind: "deckRenamed", title: draft });
  const usable = draft.trim().length > 0;
  return (
    <Dialog
      title="Rename deck"
      close={properties.close}
      actions={
        <>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={properties.close}>Cancel</button>
          <button type="button" className={TIDEPOOL_CLASS.primaryPill} disabled={!usable} onClick={rename}>Rename</button>
        </>
      }
    >
      <label className={VIEW_CLASS.fieldLabel}>
        <span>Name</span>
        <input
          className={TIDEPOOL_CLASS.field}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !usable) return;
            event.preventDefault();
            rename();
          }}
        />
      </label>
    </Dialog>
  );
}

function LayoutDialog(properties: Readonly<{ layoutIds: readonly LayoutId[]; close: () => void }>): ReactElement {
  const services = useEditorServices();
  const layouts = useEditorSelector((state) => state.document.layouts);
  return (
    <Dialog title="New slide from a layout" close={properties.close} actions={<button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={properties.close}>Cancel</button>}>
      <div className={VIEW_CLASS.layoutChoices}>
        {layouts
          .filter((layout) => properties.layoutIds.includes(layout.id))
          .map((layout) => (
            <button
              key={layout.id}
              type="button"
              className={TIDEPOOL_CLASS.secondaryPill}
              onClick={() => {
                services.system.dispatch({ kind: "newSlideRequested", layoutId: layout.id });
                properties.close();
              }}
            >
              {layout.name}
            </button>
          ))}
      </div>
    </Dialog>
  );
}

type ScriptTab = "script" | "stylesheet" | "markup" | "reference";

function TransitionScriptDialog(properties: Readonly<{ editor: TransitionScriptEditor; close: () => void }>): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector(
    (state) => ({ scripts: state.document.transitionScripts, preview: state.chrome.transitionPreview, buildPreview: state.chrome.buildPreview, currentSlideId: state.currentSlideId, document: state.document }),
    shallowEqual,
  );
  const [tab, setTab] = useState<ScriptTab>("script");
  const draft = properties.editor.draft;
  const record = view.scripts.find((script) => script.id === draft.id) ?? null;
  const change = (patch: Partial<TransitionScriptDraft>): void => dispatch({ kind: "transitionScriptDraftChanged", draft: { ...draft, ...patch } });
  const words = SCRIPT_WORDS[draft.purpose];
  const run = (slideId: SlideId): EditorEvent => runEventFor({ purpose: draft.purpose, slideId });
  return (
    <Dialog
      wide
      title={record === null ? `New ${words.noun} script` : `${words.title} script: ${record.name}`}
      close={properties.close}
      actions={
        <>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={view.currentSlideId === null || record === null} title={record === null ? "Save the script first" : words.runHint} onClick={() => view.currentSlideId !== null && dispatch(run(view.currentSlideId))}>
            <Icon name="present" /> Run
          </button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={properties.close}>Close</button>
          <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={() => dispatch({ kind: "transitionScriptSaveRequested", overwrite: false })}>
            Save and approve
          </button>
        </>
      }
    >
      {record === null ? null : <ApprovalBanner record={record} draft={draft} />}
      {properties.editor.conflict ? (
        <div className={`${VIEW_CLASS.conflict} ${VIEW_CLASS.fieldRow}`} role="alert">
          <span>Someone saved this script since you opened it.</span>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => dispatch({ kind: "transitionScriptReloadRequested" })}>Reload theirs</button>
          <button type="button" className={TIDEPOOL_CLASS.dangerPill} onClick={() => dispatch({ kind: "transitionScriptSaveRequested", overwrite: true })}>Overwrite</button>
        </div>
      ) : null}
      <div className={VIEW_CLASS.fieldGrid}>
        <label className={VIEW_CLASS.fieldLabel}>
          <span>Name</span>
          <input className={TIDEPOOL_CLASS.field} value={draft.name} onChange={(event) => change({ name: event.currentTarget.value })} />
        </label>
        <label className={VIEW_CLASS.fieldLabel}>
          <span>Description</span>
          <input className={TIDEPOOL_CLASS.field} value={draft.description} onChange={(event) => change({ description: event.currentTarget.value })} />
        </label>
      </div>
      <div className={TIDEPOOL_CLASS.tabs} role="tablist" aria-label="Script parts">
        {(["script", "stylesheet", "markup", "reference"] as const).map((name) => (
          <button key={name} type="button" role="tab" className={TIDEPOOL_CLASS.tab} aria-selected={tab === name} onClick={() => setTab(name)}>
            {SCRIPT_TAB_LABEL[name]}
          </button>
        ))}
      </div>
      <ScriptTabBody tab={tab} draft={draft} change={change} />
      <ScriptRunPreview purpose={draft.purpose} transitionPreview={view.preview} buildPreview={view.buildPreview} document={view.document} />
    </Dialog>
  );
}

/** Where a script's purpose changes the dialog's words: a build step is not a transition. */
const SCRIPT_WORDS: Readonly<Record<ScriptPurpose, Readonly<{ noun: string; title: string; runHint: string; fallback: string }>>> = {
  transition: { noun: "transition", title: "Transition", runHint: "Plays the saved script into this slide", fallback: "presenting plays a simple fade instead" },
  animation: { noun: "build step", title: "Build step", runHint: "Plays this slide's builds, this script's steps included", fallback: "its build steps show the element without animation" },
};

function runEventFor(options: Readonly<{ purpose: ScriptPurpose; slideId: SlideId }>): EditorEvent {
  switch (options.purpose) {
    case "transition":
      return { kind: "transitionPreviewRequested", slideId: options.slideId };
    case "animation":
      return { kind: "buildPreviewRequested", slideId: options.slideId };
    default:
      return assertNever(options.purpose);
  }
}

/** "Run": a transition plays into the current slide; a build step script plays the slide's builds. */
function ScriptRunPreview(properties: Readonly<{
  purpose: ScriptPurpose;
  transitionPreview: EditorState["chrome"]["transitionPreview"];
  buildPreview: EditorState["chrome"]["buildPreview"];
  document: DocumentSnapshot;
}>): ReactElement | null {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  switch (properties.purpose) {
    case "transition": {
      const preview = properties.transitionPreview;
      if (preview === null) return null;
      const Preview = services.TransitionPreview;
      return (
        <div className={VIEW_CLASS.previewBox}>
          <Preview dependencies={services.presenterDependencies} document={properties.document} slideId={preview.slideId} generation={preview.generation} width={420} onEnded={() => dispatch({ kind: "transitionPreviewEnded" })} />
        </div>
      );
    }
    case "animation": {
      const preview = properties.buildPreview;
      if (preview === null) return null;
      const Preview = services.BuildPreview;
      return (
        <div className={VIEW_CLASS.previewBox}>
          <Preview key={preview.generation} dependencies={services.presenterDependencies} document={properties.document} slideId={preview.slideId} generation={preview.generation} width={420} onEnded={() => dispatch({ kind: "buildPreviewEnded" })} />
        </div>
      );
    }
    default:
      return assertNever(properties.purpose);
  }
}

const SCRIPT_TAB_LABEL: Readonly<Record<ScriptTab, string>> = { script: "Script", stylesheet: "Stylesheet", markup: "Overlay markup", reference: "How to write one" };

function ScriptTabBody(properties: Readonly<{ tab: ScriptTab; draft: TransitionScriptDraft; change: (patch: Partial<TransitionScriptDraft>) => void }>): ReactElement {
  switch (properties.tab) {
    case "script":
      return <CodeArea label="Script" value={properties.draft.script} onChange={(script) => properties.change({ script })} />;
    case "stylesheet":
      return <CodeArea label="Stylesheet" value={properties.draft.stylesheet} onChange={(stylesheet) => properties.change({ stylesheet })} />;
    case "markup":
      return <CodeArea label="Overlay markup" value={properties.draft.markup} onChange={(markup) => properties.change({ markup })} />;
    case "reference":
      return <pre className={`${TIDEPOOL_CLASS.code} ${VIEW_CLASS.scriptReference}`}>{REFERENCE_FOR[properties.draft.purpose]}</pre>;
    default:
      return assertNever(properties.tab);
  }
}

/** A plain-text code field: system monospace, Tab inserts two spaces instead of leaving the field. */
function CodeArea(properties: Readonly<{ label: string; value: string; onChange: (value: string) => void }>): ReactElement {
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => {
    if (pendingCaret.current === null || area.current === null) return;
    area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });
  return (
    <textarea
      ref={area}
      className={`${TIDEPOOL_CLASS.code} ${VIEW_CLASS.scriptEditor}`}
      aria-label={properties.label}
      spellCheck={false}
      value={properties.value}
      onChange={(event) => properties.onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        const element = event.currentTarget;
        const start = element.selectionStart;
        const end = element.selectionEnd;
        pendingCaret.current = start + 2;
        properties.onChange(`${properties.value.slice(0, start)}  ${properties.value.slice(end)}`);
      }}
    />
  );
}

function ApprovalBanner(properties: Readonly<{ record: TransitionScriptRecord; draft: TransitionScriptDraft }>): ReactElement | null {
  const dispatch = useEditorServices().system.dispatch;
  const record = properties.record;
  const fingerprint = scriptFingerprint(record);
  const approval = record.approval;
  switch (approval.kind) {
    case "approved":
      return approval.fingerprint === fingerprint ? <p className={VIEW_CLASS.explanation}>Approved: this exact script runs when presenting.</p> : <UnapprovedNotice record={record} fingerprint={fingerprint} onApprove={() => dispatch({ kind: "transitionScriptApproved", scriptId: record.id, fingerprint })} />;
    case "unapproved":
      return <UnapprovedNotice record={record} fingerprint={fingerprint} onApprove={() => dispatch({ kind: "transitionScriptApproved", scriptId: record.id, fingerprint })} />;
    default:
      return assertNever(approval);
  }
}

function UnapprovedNotice(properties: Readonly<{ record: TransitionScriptRecord; fingerprint: string; onApprove: () => void }>): ReactElement {
  return (
    <div className={`${TIDEPOOL_CLASS.card} ${VIEW_CLASS.fieldRow}`} role="note">
      <span style={{ flex: 1 }}>
        <strong>Not approved yet.</strong> Written by {authorName(properties.record.author)}. Read the whole script below before approving it: until then, {SCRIPT_WORDS[properties.record.purpose].fallback}. It runs
        in an isolated frame on this site with no network, and only approved scripts run.
      </span>
      <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={properties.onApprove}>
        Approve
      </button>
    </div>
  );
}

function authorName(author: TransitionScriptRecord["author"]): string {
  switch (author.kind) {
    case "agent":
      return `${author.name} (an agent)`;
    case "person":
      return "a person";
    default:
      return assertNever(author);
  }
}

/** The authoring reference shown beside the code (contracts/transition-protocol.ts, condensed). */
export const AUTHORING_REFERENCE = `sashaTransition.define({
  name: "My transition",
  async run(context) { ... }   // resolve when done; throwing cuts to the next slide
});

context.outgoing        the outgoing slide's root, or null when starting from black
context.incoming        the incoming slide's root, fully rendered, beneath the outgoing one
context.overlay         a layer above both slides holding the overlay markup
context.stage           both slides, scaled to fit; slide units inside (1280 wide)
context.durationMilliseconds, context.direction ("forward" | "backward"), context.parameters
context.reducedMotion   true when the viewer prefers reduced motion: fade or cut, do not fly
context.signal          aborted when the presenter skips ahead or the run times out
context.elements(side)  leaf elements of "outgoing" or "incoming", back to front:
                        { elementId, morphKey, kind, frame (unrotated), bounds (rotated), node }
context.pairs()         elements on both slides with the same morph key: { morphKey, outgoing, incoming }
context.animate(node, keyframes, options)   Web Animations, cancelled on abort
context.wait(milliseconds)                  resolves later, rejects on abort

Morphing: interpolate x, y, width and height of the UNROTATED frame, and rotation separately.
The runner has no network: images and fonts arrive as bytes with the slides.`;

/** What a build step script gets on top of a transition's context (contracts/animations.ts, scripted steps). */
export const BUILD_STEP_REFERENCE = `A build step script runs for one step of a slide's builds:
context.outgoing        the slide BEFORE the step (its earlier builds done)
context.incoming        the slide AFTER the step: animate the step's element into how it looks here
context.parameters      { ...defaults, ...the step's parameters, targetElementId, category }
                        targetElementId: the element the step animates (a group's leaves keep their own ids)
                        category: "entrance" | "emphasis" | "exit" -- where the element rests afterwards

`;

const REFERENCE_FOR: Readonly<Record<ScriptPurpose, string>> = { transition: AUTHORING_REFERENCE, animation: BUILD_STEP_REFERENCE + AUTHORING_REFERENCE };

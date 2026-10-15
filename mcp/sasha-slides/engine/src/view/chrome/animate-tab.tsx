// THE ANIMATE TAB: the current slide's build sequence (contracts/animations.ts) in the properties
// panel -- "Add animation" for the selection, the steps in play order, the chosen step's fields,
// and Preview, which plays the builds over the canvas (canvas/build-overlays.tsx). Every control
// dispatches one event; what the rows say comes from animate-values.ts.
//
// Key decisions:
//
//  * THE SEQUENCE IS A LISTBOX. Each row is an option: a click or the arrow keys choose it, Alt+Up
//    and Alt+Down move it, Delete removes it, and a pointer can drag it onto another row (native
//    drag and drop, so no gesture state reaches the reducer until the drop). Each key the list
//    handles is prevented, so the shell never turns it into a nudge or a delete of the selection.
//  * A STEP THAT CANNOT PLAY STAYS VISIBLE and says why: "element removed" when its element is gone,
//    "made with a newer version" when stored values were not understood -- the latter read-only,
//    since a patch would lose what this editor cannot see.
//  * A SCRIPTED STEP NAMES ONLY BUILD-STEP SCRIPTS (purpose "animation"); "New script" opens the
//    script dialog for a build step, and an unapproved script is called out, because the element
//    then simply appears until a person approves the script.

import { useState, type KeyboardEvent, type ReactElement } from "react";
import { ANIMATION_EDGES, ANIMATION_EFFECT_KINDS, ANIMATION_EFFECT_LABELS, ANIMATION_TRIGGERS, ANIMATION_TRIGGER_LABELS, type AnimationEdge, type AnimationEffect, type AnimationEffectKind, type AnimationStepPatch, type AnimationTrigger, type ScriptedAnimationCategory } from "../../contracts/animations.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import { scriptFingerprint, type ThemeSnapshot, type TransitionEasing, type TransitionScriptRecord } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorState } from "../../contracts/editor-state.ts";
import type { AnimationStepId } from "../../contracts/ids.ts";
import type { Selection, TextTarget } from "../../contracts/selection.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { ANIMATION_EFFECT_GROUPS, ANIMATION_FIELD_RANGES, ELEMENT_REMOVED_LABEL, NEWER_VERSION_LABEL, ROW_PLAYS, animationRows, animationScripts, clampedNumber, dropMoveFor, effectWithKind, isScriptedEffect, stepMoveFor, type AnimationRow } from "./animate-values.ts";
import { ChoiceField, ColourField, NumberField, Section } from "./fields.tsx";
import { Icon } from "./icons.tsx";

export const NO_SLIDE_TO_ANIMATE = "Add a slide to animate what is on it.";
export const SELECT_TO_ANIMATE = "Select something on the slide, then add an animation to it.";
export const NO_ANIMATIONS_YET = "No animations on this slide yet.";
export const UNAPPROVED_SCRIPT_NOTE = "This script is not approved yet: until a person approves it, the element appears without animation.";
export const NEWER_VERSION_EXPLANATION = "Made with a newer version of Sasha Slides: shown here, but it cannot be changed or played in this version.";
export const ADD_ANIMATION_LABEL = "Add animation";

export function AnimateTab(properties: Readonly<{ state: EditorState; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const state = properties.state;
  const dispatch = properties.dispatch;
  const slide = state.document.slides.find((candidate) => candidate.id === state.currentSlideId) ?? null;
  if (slide === null) return <p className={TIDEPOOL_CLASS.muted}>{NO_SLIDE_TO_ANIMATE}</p>;
  const scripts = animationScripts(state.document);
  const rows = animationRows({ slide, scripts });
  const chosen = rows.find((row) => row.step.id === state.chrome.selectedAnimationStepId) ?? null;
  const canAdd = selectionIsOnSlide(state.selection, slide.id);
  const order = rows.map((row) => row.step.id);
  const move = (stepId: AnimationStepId, direction: "up" | "down"): void => {
    const target = stepMoveFor({ order, stepId, direction });
    if (target !== null) dispatch({ kind: "animationStepsMoved", stepIds: [stepId], after: target.after });
  };
  return (
    <>
      <Section title="Add animation" explanation={canAdd ? null : SELECT_TO_ANIMATE}>
        <AddAnimationPicker disabled={!canAdd} scripts={scripts} onAdd={(effect) => dispatch({ kind: "animationAddRequested", effect })} />
      </Section>
      <Section title="Sequence">
        {rows.length === 0 ? <p className={TIDEPOOL_CLASS.muted}>{NO_ANIMATIONS_YET}</p> : <SequenceList rows={rows} chosenId={chosen?.step.id ?? null} onMove={move} dispatch={dispatch} />}
        <div className={VIEW_CLASS.fieldRow}>
          <button type="button" className={TIDEPOOL_CLASS.primaryPill} disabled={!rows.some((row) => ROW_PLAYS[row.status])} onClick={() => dispatch({ kind: "buildPreviewRequested", slideId: slide.id })}>
            <Icon name="present" /> Preview
          </button>
          {chosen === null ? null : (
            <>
              <button type="button" className={TIDEPOOL_CLASS.secondaryPill} aria-label={`Move animation ${chosen.number} up`} disabled={chosen.number === 1} onClick={() => move(chosen.step.id, "up")}>
                Move up
              </button>
              <button type="button" className={TIDEPOOL_CLASS.secondaryPill} aria-label={`Move animation ${chosen.number} down`} disabled={chosen.number === rows.length} onClick={() => move(chosen.step.id, "down")}>
                Move down
              </button>
            </>
          )}
        </div>
      </Section>
      {chosen === null ? null : <StepFields key={chosen.step.id} row={chosen} scripts={scripts} theme={state.document.theme} dispatch={dispatch} />}
    </>
  );
}

/** "Add animation": the effects grouped as entrance, emphasis, exit and motion; scripted once the deck has a build-step script. */
export function AddAnimationPicker(properties: Readonly<{ disabled: boolean; scripts: readonly TransitionScriptRecord[]; onAdd: (effect: AnimationEffect) => void }>): ReactElement {
  return (
    <label className={VIEW_CLASS.fieldLabel}>
      <span className={VIEW_CLASS.visuallyHidden}>{ADD_ANIMATION_LABEL}</span>
      <select
        className={VIEW_CLASS.select}
        aria-label={ADD_ANIMATION_LABEL}
        value=""
        disabled={properties.disabled}
        title={properties.disabled ? SELECT_TO_ANIMATE : undefined}
        onChange={(event) => {
          const kind = ANIMATION_EFFECT_KINDS.find((candidate) => candidate === event.currentTarget.value);
          if (kind === undefined) return;
          const effect = effectWithKind({ kind, previous: null, scripts: properties.scripts });
          if (effect !== null) properties.onAdd(effect);
        }}
      >
        <option value="">{`${ADD_ANIMATION_LABEL}…`}</option>
        {ANIMATION_EFFECT_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.kinds.map((kind) => (
              <option key={kind} value={kind}>
                {ANIMATION_EFFECT_LABELS[kind]}
              </option>
            ))}
          </optgroup>
        ))}
        {properties.scripts.length === 0 ? null : (
          <optgroup label="Scripted">
            <option value="scripted">{ANIMATION_EFFECT_LABELS.scripted}</option>
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** The sequence in play order (see the header for the keys and the drag). */
export function SequenceList(properties: Readonly<{ rows: readonly AnimationRow[]; chosenId: AnimationStepId | null; onMove: (stepId: AnimationStepId, direction: "up" | "down") => void; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const [draggingId, setDraggingId] = useState<AnimationStepId | null>(null);
  const order = properties.rows.map((row) => row.step.id);
  const focusId = properties.chosenId ?? order[0] ?? null;
  const chooseNeighbour = (options: Readonly<{ list: HTMLElement | null; stepId: AnimationStepId; step: 1 | -1 }>): void => {
    const next = order[order.indexOf(options.stepId) + options.step];
    if (next === undefined) return;
    properties.dispatch({ kind: "animationStepSelected", stepId: next });
    focusRow(options.list, next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: AnimationRow): void => {
    const handled = rowKeyIntent({ key: event.key, alt: event.altKey });
    if (handled === null) return;
    event.preventDefault();
    switch (handled) {
      case "moveUp":
        properties.onMove(row.step.id, "up");
        return;
      case "moveDown":
        properties.onMove(row.step.id, "down");
        return;
      case "chooseNext":
        chooseNeighbour({ list: event.currentTarget.parentElement, stepId: row.step.id, step: 1 });
        return;
      case "choosePrevious":
        chooseNeighbour({ list: event.currentTarget.parentElement, stepId: row.step.id, step: -1 });
        return;
      case "remove":
        properties.dispatch({ kind: "animationStepRemoved", stepId: row.step.id });
        return;
      default:
        assertNever(handled);
    }
  };
  return (
    <ol className={VIEW_CLASS.animationList} role="listbox" aria-label="Animation sequence">
      {properties.rows.map((row) => (
        <li
          key={row.step.id}
          role="option"
          className={VIEW_CLASS.animationRow}
          aria-selected={row.step.id === properties.chosenId}
          aria-label={rowAccessibleName(row)}
          tabIndex={row.step.id === focusId ? 0 : -1}
          data-step-id={row.step.id}
          data-status={row.status}
          data-dragging={row.step.id === draggingId}
          draggable
          onClick={() => properties.dispatch({ kind: "animationStepSelected", stepId: row.step.id })}
          onKeyDown={(event) => onKeyDown(event, row)}
          onDragStart={(event) => {
            setDraggingId(row.step.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", row.step.id);
          }}
          onDragOver={(event) => {
            if (draggingId !== null) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const target = draggingId === null ? null : dropMoveFor({ order, stepId: draggingId, targetId: row.step.id });
            if (draggingId !== null && target !== null) properties.dispatch({ kind: "animationStepsMoved", stepIds: [draggingId], after: target.after });
            setDraggingId(null);
          }}
          onDragEnd={() => setDraggingId(null)}
        >
          <span className={VIEW_CLASS.animationNumber} aria-hidden="true">
            {row.number}
          </span>
          <span className={VIEW_CLASS.animationDetail} aria-hidden="true">
            <strong>{row.elementLabel}</strong>
            <span>
              {row.effectLabel} · {row.triggerLabel}
            </span>
            {ROW_PLAYS[row.status] ? null : <span className={TIDEPOOL_CLASS.subtle}>{statusLabel(row)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

type RowKeyIntent = "moveUp" | "moveDown" | "chooseNext" | "choosePrevious" | "remove";

/** What a key on a focused row does; null leaves it to the shell. */
export function rowKeyIntent(options: Readonly<{ key: string; alt: boolean }>): RowKeyIntent | null {
  switch (options.key) {
    case "ArrowUp":
      return options.alt ? "moveUp" : "choosePrevious";
    case "ArrowDown":
      return options.alt ? "moveDown" : "chooseNext";
    case "Delete":
    case "Backspace":
      return options.alt ? null : "remove";
    default:
      return null;
  }
}

/** The chosen step's fields: effect, trigger, timing, easing and the effect's own options. */
function StepFields(properties: Readonly<{ row: AnimationRow; scripts: readonly TransitionScriptRecord[]; theme: ThemeSnapshot; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const step = properties.row.step;
  const readOnly = READ_ONLY_EXPLANATION[properties.row.status];
  const patch = (next: AnimationStepPatch): void => properties.dispatch({ kind: "animationStepPatchRequested", stepId: step.id, patch: next });
  const number = (text: string, range: Readonly<{ minimum: number; maximum: number }>, apply: (value: number) => void): void => {
    const value = clampedNumber({ text, range });
    if (value !== null) apply(value);
  };
  const effectKinds = ANIMATION_EFFECT_KINDS.filter((kind) => effectKindOffered({ kind, current: step.effect, scripts: properties.scripts }));
  return (
    <Section title={`Animation ${properties.row.number}`} explanation={readOnly}>
      <ChoiceField<AnimationEffectKind>
        label="Effect"
        value={{ kind: "value", value: step.effect.kind }}
        options={effectKinds.map((kind) => ({ value: kind, label: ANIMATION_EFFECT_LABELS[kind] }))}
        onChoose={(kind) => {
          const effect = effectWithKind({ kind, previous: step.effect, scripts: properties.scripts });
          if (effect !== null) patch({ effect });
        }}
        explanation={readOnly}
      />
      <ChoiceField<AnimationTrigger>
        label="Start"
        value={{ kind: "value", value: step.trigger }}
        options={ANIMATION_TRIGGERS.map((trigger) => ({ value: trigger, label: ANIMATION_TRIGGER_LABELS[trigger] }))}
        onChoose={(trigger) => patch({ trigger })}
        explanation={readOnly}
      />
      <div className={VIEW_CLASS.fieldGrid}>
        <NumberField label="Duration" suffix="milliseconds" value={{ kind: "value", value: step.durationMilliseconds }} onCommit={(text) => number(text, ANIMATION_FIELD_RANGES.duration, (durationMilliseconds) => patch({ durationMilliseconds }))} explanation={readOnly} />
        <NumberField label="Delay" suffix="milliseconds" value={{ kind: "value", value: step.delayMilliseconds }} onCommit={(text) => number(text, ANIMATION_FIELD_RANGES.delay, (delayMilliseconds) => patch({ delayMilliseconds }))} explanation={readOnly} />
      </div>
      <ChoiceField<TransitionEasing> label="Easing" value={{ kind: "value", value: step.easing }} options={EASING_OPTIONS} onChoose={(easing) => patch({ easing })} explanation={readOnly} />
      <EffectOptions effect={step.effect} scripts={properties.scripts} theme={properties.theme} explanation={readOnly} onEffect={(effect) => patch({ effect })} onNumber={number} dispatch={properties.dispatch} />
      <div className={VIEW_CLASS.fieldRow}>
        <button type="button" className={TIDEPOOL_CLASS.dangerPill} aria-label={`Remove animation ${properties.row.number}`} onClick={() => properties.dispatch({ kind: "animationStepRemoved", stepId: step.id })}>
          Remove
        </button>
      </div>
    </Section>
  );
}

/** Total over the statuses: why a step's fields are locked, or null when they are editable. */
const READ_ONLY_EXPLANATION: Readonly<Record<AnimationRow["status"], string | null>> = { playable: null, elementRemoved: null, newerVersion: NEWER_VERSION_EXPLANATION };

const EASING_OPTIONS: readonly Readonly<{ value: TransitionEasing; label: string }>[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease in" },
  { value: "easeOut", label: "Ease out" },
  { value: "easeInOut", label: "Ease in and out" },
];

const EDGE_LABEL: Readonly<Record<AnimationEdge, string>> = { left: "Left edge", right: "Right edge", top: "Top edge", bottom: "Bottom edge" };
const EDGE_OPTIONS = ANIMATION_EDGES.map((edge) => ({ value: edge, label: EDGE_LABEL[edge] }));

const CATEGORY_OPTIONS: readonly Readonly<{ value: ScriptedAnimationCategory; label: string }>[] = [
  { value: "entrance", label: "Entrance: visible after it" },
  { value: "emphasis", label: "Emphasis: unchanged after it" },
  { value: "exit", label: "Exit: hidden after it" },
];

/** The options of the chosen effect; nothing for the effects that have none. */
function EffectOptions(properties: Readonly<{
  effect: AnimationEffect;
  scripts: readonly TransitionScriptRecord[];
  theme: ThemeSnapshot;
  explanation: string | null;
  onEffect: (effect: AnimationEffect) => void;
  onNumber: (text: string, range: Readonly<{ minimum: number; maximum: number }>, apply: (value: number) => void) => void;
  dispatch: (event: EditorEvent) => void;
}>): ReactElement | null {
  const effect = properties.effect;
  const explanation = properties.explanation;
  switch (effect.kind) {
    case "flyIn":
    case "wipe":
      return <ChoiceField<AnimationEdge> label="From" value={{ kind: "value", value: effect.from }} options={EDGE_OPTIONS} onChoose={(from) => properties.onEffect({ ...effect, from })} explanation={explanation} />;
    case "flyOut":
      return <ChoiceField<AnimationEdge> label="To" value={{ kind: "value", value: effect.to }} options={EDGE_OPTIONS} onChoose={(to) => properties.onEffect({ ...effect, to })} explanation={explanation} />;
    case "growShrink":
      return <NumberField label="Scale" suffix="times its size" value={{ kind: "value", value: effect.scale }} onCommit={(text) => properties.onNumber(text, ANIMATION_FIELD_RANGES.scale, (scale) => properties.onEffect({ ...effect, scale }))} explanation={explanation} />;
    case "spin":
      return <NumberField label="Turn" suffix="degrees" value={{ kind: "value", value: effect.degrees }} onCommit={(text) => properties.onNumber(text, ANIMATION_FIELD_RANGES.degrees, (degrees) => properties.onEffect({ ...effect, degrees }))} explanation={explanation} />;
    case "colourChange":
      return (
        <>
          <ColourField label="Colour" value={{ kind: "value", value: effect.colour }} theme={properties.theme} onChoose={(colour) => properties.onEffect({ ...effect, colour })} explanation={explanation} />
          <ChoiceField label="Part" value={{ kind: "value", value: effect.part }} options={[{ value: "fill", label: "Fill" }, { value: "text", label: "Text" }]} onChoose={(part) => properties.onEffect({ ...effect, part })} explanation={explanation} />
        </>
      );
    case "motionPath":
      return (
        <div className={VIEW_CLASS.fieldGrid}>
          <NumberField label="Offset X" suffix="slide units" value={{ kind: "value", value: effect.offsetX }} onCommit={(text) => properties.onNumber(text, ANIMATION_FIELD_RANGES.offset, (offsetX) => properties.onEffect({ ...effect, offsetX }))} explanation={explanation} />
          <NumberField label="Offset Y" suffix="slide units" value={{ kind: "value", value: effect.offsetY }} onCommit={(text) => properties.onNumber(text, ANIMATION_FIELD_RANGES.offset, (offsetY) => properties.onEffect({ ...effect, offsetY }))} explanation={explanation} />
        </div>
      );
    case "scripted":
      return <ScriptedOptions effect={effect} scripts={properties.scripts} explanation={explanation} onEffect={properties.onEffect} dispatch={properties.dispatch} />;
    case "appear":
    case "fadeIn":
    case "zoomIn":
    case "floatIn":
    case "pulse":
    case "disappear":
    case "fadeOut":
    case "zoomOut":
      return null;
    default:
      return assertNever(effect);
  }
}

function ScriptedOptions(properties: Readonly<{
  effect: Extract<AnimationEffect, { kind: "scripted" }>;
  scripts: readonly TransitionScriptRecord[];
  explanation: string | null;
  onEffect: (effect: AnimationEffect) => void;
  dispatch: (event: EditorEvent) => void;
}>): ReactElement {
  const effect = properties.effect;
  const script = properties.scripts.find((candidate) => candidate.id === effect.scriptId) ?? null;
  return (
    <>
      <ChoiceField
        label="Script"
        value={script === null ? { kind: "none" } : { kind: "value", value: script.id }}
        options={properties.scripts.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
        onChoose={(scriptId) => properties.onEffect({ ...effect, scriptId })}
        explanation={properties.explanation}
      />
      <ChoiceField<ScriptedAnimationCategory> label="Category" value={{ kind: "value", value: effect.category }} options={CATEGORY_OPTIONS} onChoose={(category) => properties.onEffect({ ...effect, category })} explanation={properties.explanation} />
      {script !== null && !scriptApproved(script) ? (
        <p className={VIEW_CLASS.explanation} role="note">
          {UNAPPROVED_SCRIPT_NOTE}
        </p>
      ) : null}
      <div className={VIEW_CLASS.fieldRow}>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={script === null} onClick={() => script !== null && properties.dispatch({ kind: "transitionScriptEditorOpened", scriptId: script.id, purpose: "animation" })}>
          Edit script
        </button>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => properties.dispatch({ kind: "transitionScriptEditorOpened", scriptId: null, purpose: "animation" })}>
          New script
        </button>
      </div>
    </>
  );
}

/** Approved, and for exactly the text and purpose stored now (an edit voids an approval). */
export function scriptApproved(script: TransitionScriptRecord): boolean {
  const approval = script.approval;
  switch (approval.kind) {
    case "approved":
      return approval.fingerprint === scriptFingerprint(script);
    case "unapproved":
      return false;
    default:
      return assertNever(approval);
  }
}

/** Every built-in effect, and Scripted when the deck has a build-step script or the step already is one. */
function effectKindOffered(options: Readonly<{ kind: AnimationEffectKind; current: AnimationEffect; scripts: readonly TransitionScriptRecord[] }>): boolean {
  switch (options.kind) {
    case "scripted":
      return options.scripts.length > 0 || isScriptedEffect(options.current);
    case "appear":
    case "fadeIn":
    case "flyIn":
    case "zoomIn":
    case "floatIn":
    case "wipe":
    case "pulse":
    case "growShrink":
    case "spin":
    case "colourChange":
    case "disappear":
    case "fadeOut":
    case "flyOut":
    case "zoomOut":
    case "motionPath":
      return true;
    default:
      return assertNever(options.kind);
  }
}

function statusLabel(row: AnimationRow): string {
  switch (row.status) {
    case "playable":
      return "";
    case "elementRemoved":
      return ELEMENT_REMOVED_LABEL;
    case "newerVersion":
      return NEWER_VERSION_LABEL;
    default:
      return assertNever(row.status);
  }
}

function rowAccessibleName(row: AnimationRow): string {
  const status = statusLabel(row);
  return `${row.number}. ${row.elementLabel}, ${row.effectLabel}, ${row.triggerLabel}${status.length === 0 ? "" : `, ${status}`}`;
}

/** True when the selection names elements (or text in one) on this slide: what "Add animation" needs. */
function selectionIsOnSlide(selection: Selection, slideId: EditorState["currentSlideId"]): boolean {
  switch (selection.kind) {
    case "elements":
      return selection.slideId === slideId && selection.elementIds.length > 0;
    case "tableCells":
      return selection.slideId === slideId;
    case "text":
      return selection.target.slideId === slideId && textIsOnCanvas(selection.target);
    case "none":
    case "slides":
      return false;
    default:
      return assertNever(selection);
  }
}

function textIsOnCanvas(target: TextTarget): boolean {
  switch (target.kind) {
    case "element":
    case "tableCell":
      return true;
    case "speakerNotes":
      return false;
    default:
      return assertNever(target);
  }
}

function focusRow(list: HTMLElement | null, stepId: AnimationStepId): void {
  const row = list?.querySelector<HTMLElement>(`[data-step-id="${stepId}"]`) ?? null;
  row?.focus();
}

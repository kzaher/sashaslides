// THE PROPERTIES PANEL: a glass panel with pill tabs -- Arrange, Fill, Border, Effects, Text, Slide,
// Transition, Animate (animate-tab.tsx) -- whose controls each dispatch one event (SPEC.md section
// 9). What a control shows comes from properties-values.ts (points for font sizes, "mixed" across a selection, locked
// controls for values from a newer version); this file only lays the controls out.
//
// Key decisions:
//
//  * THE PANEL DOES NOT RENDER DURING A DRAG. It subscribes to the slices it shows -- selection,
//    document, typing style, measured layout, its own tab -- and never to the gesture, so a pointer
//    move re-renders the canvas and nothing here (the 4 millisecond drag budget).
//  * STYLE GROUPS ARE EDITED FROM THE FIRST LEAF THAT HAS THEM. A padding, a stroke width, a border
//    width is sent as that first leaf's whole group with the one field replaced; the reducer merges
//    the changed field into every selected element's own group (state element-patches.ts), so the
//    fields SHOW the shared value ("mixed" when the selection differs) but EDIT from that base.
//  * A ROLE THAT CANNOT EDIT SEES THE PANEL READ-ONLY: the tab body sits in a disabled fieldset with
//    the reason above it (access.ts), so every control is disabled at once and says why.
//  * THE TABS ARE A TABLIST with a roving tab index; the arrow keys switch tabs and never nudge the
//    selected element (pill-group.ts).

import { memo, useRef, useState, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { BuiltinTransitionEffect, ElementSnapshot, ImageCrop, ImageElement, ShapeElement, SlideDirection, SlideTransition, TableElement, ThemeSnapshot } from "../../contracts/document.ts";
import { mintId } from "../../contracts/ids.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorState, PropertiesTab } from "../../contracts/editor-state.ts";
import type { Border, Colour, CornerRadius, DashStyle, Fill, ImageFit, ListGlyph, NoColour, Shadow, Stroke, TextBoxStyle } from "../../contracts/style.ts";
import { literalColour, themeColour } from "../../contracts/style.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { shallowEqual, useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { isRectangleFamily } from "../render/shape-geometry.ts";
import { linearGradientValue, radialGradientValue } from "../render/inline-styles.ts";
import { slideBackground } from "../render/static-slide.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { editingDisabledReason } from "./access.ts";
import { AnimateTab } from "./animate-tab.tsx";
import { ChoiceField, ColourField, NumberField, PillChoice, Section, ToggleButton } from "./fields.tsx";
import { MAXIMUM_GRADIENT_STOPS, MINIMUM_GRADIENT_STOPS, withAddedStop, withLinearAngle, withRadialCentre, withStopColour, withStopOffset, withoutStop, type GradientFill } from "./gradient-stops.ts";
import { Icon } from "./icons.tsx";
import { LIST_GLYPH_PRESETS } from "./list-glyphs.ts";
import { UNGROUP_HINT, selectionHoldsGroup } from "./menu-model.ts";
import { handlePillGroupKey, rovingTabIndex } from "./pill-group.ts";
import { fontSizeEvent, frameValues, leafElements, lockedExplanation, panelSubject, roundTo, sharedValue, subjectElements, textValues, type PanelSubject, type SharedValue } from "./properties-values.ts";

export const PROPERTIES_TABS: readonly Readonly<{ tab: PropertiesTab; label: string }>[] = [
  { tab: "arrange", label: "Arrange" },
  { tab: "fill", label: "Fill" },
  { tab: "border", label: "Border" },
  { tab: "effects", label: "Effects" },
  { tab: "text", label: "Text" },
  { tab: "slide", label: "Slide" },
  { tab: "transition", label: "Transition" },
  { tab: "animate", label: "Animate" },
];

/** Families offered besides the theme's two: Google Fonts with open licences (SPEC.md section 19). */
export const CURATED_FONT_FAMILIES: readonly string[] = ["Manrope", "Inter", "Roboto", "Lora", "Merriweather", "Playfair Display", "Source Code Pro", "Caveat", "Patrick Hand", "Montserrat", "Nunito", "Work Sans"];

export const PropertiesPanel = memo(function PropertiesPanel(): ReactElement {
  const services = useEditorServices();
  const tab = useEditorSelector((state) => state.chrome.propertiesTab);
  useEditorSelector(
    (state) => ({
      selection: state.selection,
      document: state.document,
      typing: state.textEditing.typingStyle,
      measured: state.measuredLayouts,
      currentSlideId: state.currentSlideId,
      preview: state.chrome.transitionPreview,
      chosenStep: state.chrome.selectedAnimationStepId,
    }),
    shallowEqual,
  );
  const state = services.system.currentState();
  const dispatch = services.system.dispatch;
  const refusal = editingDisabledReason(state);
  const chosenIndex = PROPERTIES_TABS.findIndex((entry) => entry.tab === tab);
  return (
    <aside className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.sidePanel}`} aria-label="Properties">
      <div className={VIEW_CLASS.panelHeader}>
        <div
          className={TIDEPOOL_CLASS.tabs}
          role="tablist"
          aria-label="Properties"
          onKeyDown={(event) =>
            handlePillGroupKey(event, (index) => {
              const entry = PROPERTIES_TABS[index];
              if (entry !== undefined) dispatch({ kind: "propertiesTabChosen", tab: entry.tab });
            })
          }
        >
          {PROPERTIES_TABS.map((entry, index) => (
            <button
              key={entry.tab}
              type="button"
              role="tab"
              className={TIDEPOOL_CLASS.tab}
              aria-selected={entry.tab === tab}
              tabIndex={rovingTabIndex({ index, chosenIndex })}
              data-properties-tab={entry.tab}
              onClick={() => dispatch({ kind: "propertiesTabChosen", tab: entry.tab })}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className={VIEW_CLASS.panelBody} role="tabpanel">
        {refusal === null ? null : <p className={VIEW_CLASS.explanation}>{refusal}</p>}
        <fieldset className={VIEW_CLASS.panelFieldset} disabled={refusal !== null} title={refusal ?? undefined}>
          <TabBody tab={tab} state={state} dispatch={dispatch} />
        </fieldset>
      </div>
    </aside>
  );
});

function TabBody(properties: Readonly<{ tab: PropertiesTab; state: EditorState; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const subject = panelSubject(properties.state);
  const elements = subjectElements(subject);
  const leaves = elements.flatMap(leafElements);
  const nothing = <p className={TIDEPOOL_CLASS.muted}>Select something on the slide to change it here.</p>;
  switch (properties.tab) {
    case "arrange":
      return elements.length === 0 ? nothing : <ArrangeTab state={properties.state} elements={elements} dispatch={properties.dispatch} />;
    case "fill":
      return elements.length === 0 ? nothing : <FillTab theme={properties.state.document.theme} elements={leaves} dispatch={properties.dispatch} />;
    case "border":
      return elements.length === 0 ? nothing : <BorderTab theme={properties.state.document.theme} elements={leaves} dispatch={properties.dispatch} />;
    case "effects":
      return elements.length === 0 ? nothing : <EffectsTab theme={properties.state.document.theme} elements={leaves} dispatch={properties.dispatch} />;
    case "text":
      return textBearing(elements) ? <TextTab state={properties.state} subject={subject} elements={leaves} dispatch={properties.dispatch} /> : <p className={TIDEPOOL_CLASS.muted}>Select a text box, a shape or a table, or click into its text.</p>;
    case "slide":
      return <SlideTab state={properties.state} dispatch={properties.dispatch} />;
    case "transition":
      return <TransitionTab state={properties.state} dispatch={properties.dispatch} />;
    case "animate":
      return <AnimateTab state={properties.state} dispatch={properties.dispatch} />;
    default:
      return assertNever(properties.tab);
  }
}

function ArrangeTab(properties: Readonly<{ state: EditorState; elements: readonly ElementSnapshot[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const values = frameValues(properties.state);
  const locked = lockedExplanation({ elements: properties.elements, control: "frame" });
  const dispatch = properties.dispatch;
  const field = (name: "x" | "y" | "width" | "height" | "rotation") => (text: string) => {
    const value = Number(text);
    if (Number.isFinite(value)) dispatch({ kind: "frameFieldEdited", field: name, value });
  };
  const arrange = (action: Extract<EditorEvent, { kind: "arrangeRequested" }>["action"]) => () => dispatch({ kind: "arrangeRequested", action });
  return (
    <>
      <Section title="Position and size" explanation={locked}>
        <div className={VIEW_CLASS.fieldGrid}>
          <NumberField label="Left" value={values.x} onCommit={field("x")} explanation={locked} />
          <NumberField label="Top" value={values.y} onCommit={field("y")} explanation={locked} />
          <NumberField label="Width" value={values.width} onCommit={field("width")} explanation={locked} />
          <NumberField label="Height" value={values.height} onCommit={field("height")} explanation={locked} />
          <NumberField label="Rotation" suffix="degrees" value={values.rotation} onCommit={field("rotation")} explanation={locked} />
        </div>
        <div className={VIEW_CLASS.fieldRow}>
          <ToggleButton label="Lock the aspect ratio" icon="lock" pressed={properties.state.chrome.aspectRatioLocked} onToggle={() => dispatch({ kind: "aspectRatioLockToggled" })} explanation={locked} />
          <ToggleButton label="Flip horizontally" icon="flipHorizontal" pressed={false} onToggle={arrange({ kind: "flip", axis: "horizontal" })} explanation={locked} />
          <ToggleButton label="Flip vertically" icon="flipVertical" pressed={false} onToggle={arrange({ kind: "flip", axis: "vertical" })} explanation={locked} />
          <ToggleButton label="Rotate 90 degrees" icon="rotate" pressed={false} onToggle={arrange({ kind: "rotate", degrees: 90 })} explanation={locked} />
        </div>
      </Section>
      <Section title="Order">
        <div className={VIEW_CLASS.fieldRow}>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "reorder", placement: "front" })}>To front</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "reorder", placement: "forward" })}>Forward</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "reorder", placement: "backward" })}>Backward</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "reorder", placement: "back" })}>To back</button>
        </div>
      </Section>
      <Section title="Align and distribute" explanation={properties.elements.length === 1 ? "One element aligns to the slide." : null}>
        <div className={VIEW_CLASS.fieldRow}>
          <ToggleButton label="Align left" icon="alignStart" pressed={false} onToggle={arrange({ kind: "align", edge: "left" })} explanation={null} />
          <ToggleButton label="Align centre" icon="alignCentre" pressed={false} onToggle={arrange({ kind: "align", edge: "horizontalCentre" })} explanation={null} />
          <ToggleButton label="Align right" icon="alignEnd" pressed={false} onToggle={arrange({ kind: "align", edge: "right" })} explanation={null} />
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "align", edge: "top" })}>Top</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "align", edge: "verticalCentre" })}>Middle</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={arrange({ kind: "align", edge: "bottom" })}>Bottom</button>
        </div>
        <div className={VIEW_CLASS.fieldRow}>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.elements.length < 3} onClick={arrange({ kind: "distribute", axis: "horizontal" })}>Distribute across</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.elements.length < 3} onClick={arrange({ kind: "distribute", axis: "vertical" })}>Distribute down</button>
        </div>
      </Section>
      <Section title="Group">
        <div className={VIEW_CLASS.fieldRow}>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.elements.length < 2} onClick={arrange({ kind: "group" })}>Group</button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={!selectionHoldsGroup(properties.state)} title={selectionHoldsGroup(properties.state) ? undefined : UNGROUP_HINT} onClick={arrange({ kind: "ungroup" })}>Ungroup</button>
        </div>
      </Section>
    </>
  );
}

function FillTab(properties: Readonly<{ theme: ThemeSnapshot; elements: readonly ElementSnapshot[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const boxes = properties.elements.flatMap(boxStyleOf);
  const tables = properties.elements.flatMap(tablesOf);
  if (boxes.length === 0 && tables.length > 0) {
    const cellFill = sharedValue(tables.flatMap((table) => table.cells.map((cell) => cell.fill)), sameStructure);
    const setCellFill = (next: Fill): void => properties.dispatch({ kind: "tableCellPatchRequested", patch: { fill: next } });
    return <FillEditor title="Cell fill" theme={properties.theme} fill={cellFill} onFill={setCellFill} explanation={null} allowImage={false} destination="fill" dispatch={properties.dispatch} />;
  }
  if (boxes.length === 0) return <p className={TIDEPOOL_CLASS.muted}>Lines and groups have no fill; select a shape, an image or a text box.</p>;
  const locked = lockedExplanation({ elements: properties.elements, control: "fill" });
  const fill = sharedValue(boxes.map((box) => box.fill), sameStructure);
  const setFill = (next: Fill): void => properties.dispatch({ kind: "elementPatchRequested", patch: { fill: next } });
  return <FillEditor title="Fill" theme={properties.theme} fill={fill} onFill={setFill} explanation={locked} allowImage destination="fill" dispatch={properties.dispatch} />;
}

/** A fill editor shared by elements and the slide background. */
function FillEditor(properties: Readonly<{
  title: string;
  theme: ThemeSnapshot;
  fill: SharedValue<Fill>;
  onFill: (fill: Fill) => void;
  explanation: string | null;
  allowImage: boolean;
  destination: "fill" | "slideBackground";
  dispatch: (event: EditorEvent) => void;
}>): ReactElement {
  const fill = properties.fill.kind === "value" ? properties.fill.value : null;
  const kind = fill?.kind ?? null;
  const fileInput = useRef<HTMLInputElement>(null);
  const services = useEditorServices();
  const base = fillColours(fill);
  const choose = (next: Fill["kind"]): void => {
    switch (next) {
      case "none":
        properties.onFill({ kind: "none" });
        return;
      case "solid":
        properties.onFill({ kind: "solid", colour: base.first });
        return;
      case "linearGradient":
        properties.onFill({ kind: "linearGradient", angle: 90, stops: [{ colour: base.first, offset: 0 }, { colour: base.second, offset: 1 }] });
        return;
      case "radialGradient":
        properties.onFill({ kind: "radialGradient", centreX: 0.5, centreY: 0.5, stops: [{ colour: base.first, offset: 0 }, { colour: base.second, offset: 1 }] });
        return;
      case "image":
        fileInput.current?.click();
        return;
      default:
        assertNever(next);
    }
  };
  return (
    <Section title={properties.title} explanation={properties.explanation}>
      <PillChoice
        label="Fill kind"
        value={kind}
        disabled={properties.explanation !== null}
        onChoose={choose}
        options={[
          { value: "none", label: "None" },
          { value: "solid", label: "Solid" },
          { value: "linearGradient", label: "Linear" },
          { value: "radialGradient", label: "Radial" },
          ...(properties.allowImage ? [{ value: "image" as const, label: "Image" }] : []),
        ]}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        className={VIEW_CLASS.visuallyHidden}
        aria-label="Choose an image"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file === undefined) return;
          void services.readImageFile(file).then((read) => {
            if (read !== null) properties.dispatch({ kind: "imageFilesChosen", files: [read], at: null, destination: properties.destination });
          });
        }}
      />
      {fill === null ? (properties.fill.kind === "mixed" ? <p className={VIEW_CLASS.explanation}>The selection has different fills; choosing one sets them all.</p> : null) : <FillDetails fill={fill} theme={properties.theme} onFill={properties.onFill} explanation={properties.explanation} />}
    </Section>
  );
}

function FillDetails(properties: Readonly<{ fill: Fill; theme: ThemeSnapshot; onFill: (fill: Fill) => void; explanation: string | null }>): ReactElement | null {
  const fill = properties.fill;
  switch (fill.kind) {
    case "none":
      return null;
    case "solid":
      return <ColourField label="Colour" value={{ kind: "value", value: fill.colour }} theme={properties.theme} onChoose={(colour) => properties.onFill({ kind: "solid", colour })} explanation={properties.explanation} />;
    case "linearGradient":
    case "radialGradient":
      return <GradientEditor fill={fill} theme={properties.theme} onFill={properties.onFill} explanation={properties.explanation} />;
    case "image":
      return (
        <div className={VIEW_CLASS.fieldGrid}>
          <ChoiceField<ImageFit>
            label="Fit"
            value={{ kind: "value", value: fill.fit }}
            options={[{ value: "cover", label: "Cover" }, { value: "contain", label: "Contain" }, { value: "stretch", label: "Stretch" }, { value: "tile", label: "Tile" }]}
            onChoose={(fit) => properties.onFill({ ...fill, fit })}
            explanation={properties.explanation}
          />
          <NumberField label="Opacity" suffix="percent" value={{ kind: "value", value: roundTo(fill.opacity * 100, 0) }} onCommit={(text) => numberOr(text, (value) => properties.onFill({ ...fill, opacity: clamp(value / 100, 0, 1) }))} explanation={properties.explanation} />
        </div>
      );
    default:
      return assertNever(fill);
  }
}

/**
 * A gradient's stops -- colour and position each, added in the widest gap and removed down to two,
 * at most ten -- and its angle (linear) or centre (radial); positions and centres in percent
 * (gradient-stops.ts holds the rules).
 */
export function GradientEditor(properties: Readonly<{ fill: GradientFill; theme: ThemeSnapshot; onFill: (fill: Fill) => void; explanation: string | null }>): ReactElement {
  const fill = properties.fill;
  const explanation = properties.explanation;
  const added = withAddedStop(fill);
  return (
    <>
      <div className={VIEW_CLASS.gradientPreview} aria-hidden="true" style={{ background: gradientPreviewValue(fill, properties.theme) }} />
      <div className={VIEW_CLASS.gradientStops} role="group" aria-label="Gradient stops">
        {fill.stops.map((stop, index) => (
          <div key={index} className={VIEW_CLASS.gradientStopRow}>
            <ColourField label={`Stop ${index + 1}`} value={{ kind: "value", value: stop.colour }} theme={properties.theme} onChoose={(colour) => properties.onFill(withStopColour(fill, { index, colour }))} explanation={explanation} />
            <NumberField label="Position" suffix="percent" value={{ kind: "value", value: roundTo(stop.offset * 100, 1) }} onCommit={(text) => numberOr(text, (percent) => properties.onFill(withStopOffset(fill, { index, offset: percent / 100 })))} explanation={explanation} />
            <button
              type="button"
              className={TIDEPOOL_CLASS.iconButton}
              aria-label={`Remove stop ${index + 1}`}
              title={fill.stops.length <= MINIMUM_GRADIENT_STOPS ? `A gradient needs at least ${MINIMUM_GRADIENT_STOPS} stops` : `Remove stop ${index + 1}`}
              disabled={explanation !== null || fill.stops.length <= MINIMUM_GRADIENT_STOPS}
              onClick={() => {
                const removed = withoutStop(fill, index);
                if (removed !== null) properties.onFill(removed);
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={TIDEPOOL_CLASS.secondaryPill}
          disabled={explanation !== null || added === null}
          title={added === null ? `A gradient holds at most ${MAXIMUM_GRADIENT_STOPS} stops` : undefined}
          onClick={() => {
            if (added !== null) properties.onFill(added);
          }}
        >
          <Icon name="plus" /> Add a stop
        </button>
      </div>
      {fill.kind === "linearGradient" ? (
        <NumberField label="Angle" suffix="degrees" value={{ kind: "value", value: fill.angle }} onCommit={(text) => numberOr(text, (angle) => properties.onFill(withLinearAngle(fill, angle)))} explanation={explanation} />
      ) : (
        <div className={VIEW_CLASS.fieldGrid}>
          <NumberField label="Centre across" suffix="percent" value={{ kind: "value", value: roundTo(fill.centreX * 100, 1) }} onCommit={(text) => numberOr(text, (value) => properties.onFill(withRadialCentre(fill, { x: value / 100 })))} explanation={explanation} />
          <NumberField label="Centre down" suffix="percent" value={{ kind: "value", value: roundTo(fill.centreY * 100, 1) }} onCommit={(text) => numberOr(text, (value) => properties.onFill(withRadialCentre(fill, { y: value / 100 })))} explanation={explanation} />
        </div>
      )}
    </>
  );
}

/** The gradient as the preview strip draws it: a linear one across, at its own stops. */
function gradientPreviewValue(fill: GradientFill, theme: ThemeSnapshot): string {
  switch (fill.kind) {
    case "linearGradient":
      return linearGradientValue({ angle: 90, stops: fill.stops, theme });
    case "radialGradient":
      return radialGradientValue({ centreX: fill.centreX, centreY: fill.centreY, stops: fill.stops, theme });
    default:
      return assertNever(fill);
  }
}

function BorderTab(properties: Readonly<{ theme: ThemeSnapshot; elements: readonly ElementSnapshot[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const lines = properties.elements.flatMap(lineOf);
  if (lines.length > 0) return <LineStrokeEditor theme={properties.theme} elements={properties.elements} lines={lines} dispatch={properties.dispatch} />;
  const boxes = properties.elements.flatMap(boxStyleOf);
  const tables = properties.elements.flatMap(tablesOf);
  if (boxes.length === 0 && tables.length > 0) return <CellBordersEditor theme={properties.theme} tables={tables} dispatch={properties.dispatch} />;
  if (boxes.length === 0) return <p className={TIDEPOOL_CLASS.muted}>Select a shape, an image, a line or a table.</p>;
  const locked = lockedExplanation({ elements: properties.elements, control: "border" });
  const radiusLocked = lockedExplanation({ elements: properties.elements, control: "cornerRadius" });
  const first = boxes[0];
  const perSideAllowed = properties.elements.every(allowsPerSide);
  // Edits start from the first box's border (see the header); the fields show what the boxes share.
  const current = first?.border ?? null;
  const kind = sharedValue(boxes.map((box) => box.border.kind));
  const strokes = boxes.flatMap((box) => drawnStrokes(box.border));
  const stroke = current === null ? DEFAULT_STROKE : borderStroke(current);
  const setBorder = (next: Border): void => properties.dispatch({ kind: "elementPatchRequested", patch: { border: next } });
  const setRadius = (next: CornerRadius): void => properties.dispatch({ kind: "elementPatchRequested", patch: { cornerRadius: next } });
  return (
    <>
      <Section title="Border" explanation={locked}>
        <PillChoice
          label="Border kind"
          value={kind.kind === "value" ? kind.value : null}
          disabled={locked !== null}
          onChoose={(kind) => setBorder(borderOfKind({ kind, stroke }))}
          options={[{ value: "none", label: "None" }, { value: "uniform", label: "All sides" }, ...(perSideAllowed ? [{ value: "perSide" as const, label: "Per side" }] : [])]}
        />
        {current === null || borderKindIsNone(current) ? null : (
          <>
            <div className={VIEW_CLASS.fieldGrid}>
              <NumberField label="Width" value={sharedValue(strokes.map((side) => side.width))} onCommit={(text) => numberOr(text, (width) => setBorder(withStroke(current, { ...stroke, width: Math.max(0, width) })))} explanation={locked} />
              <ChoiceField<DashStyle> label="Dash" value={sharedValue(strokes.map((side) => side.dash))} options={DASH_OPTIONS} onChoose={(dash) => setBorder(withStroke(current, { ...stroke, dash }))} explanation={locked} />
            </div>
            <ColourField label="Colour" value={sharedValue(strokes.map((side) => side.colour), sameStructure)} theme={properties.theme} onChoose={(colour) => setBorder(withStroke(current, { ...stroke, colour }))} explanation={locked} />
            {current.kind === "perSide" ? <SideToggles border={current} stroke={stroke} onBorder={setBorder} explanation={locked} /> : null}
          </>
        )}
      </Section>
      {first === undefined || !perSideAllowed ? null : (
        <Section title="Corners" explanation={radiusLocked}>
          <RadiusEditor radius={first.cornerRadius} onRadius={setRadius} explanation={radiusLocked} />
        </Section>
      )}
    </>
  );
}

function SideToggles(properties: Readonly<{ border: Extract<Border, { kind: "perSide" }>; stroke: Stroke; onBorder: (border: Border) => void; explanation: string | null }>): ReactElement {
  const sides = ["top", "right", "bottom", "left"] as const;
  return (
    <div className={VIEW_CLASS.fieldRow} role="group" aria-label="Sides with a border">
      {sides.map((side) => {
        const on = properties.border[side] !== null;
        return (
          <button key={side} type="button" className={TIDEPOOL_CLASS.tab} aria-selected={on} aria-pressed={on} disabled={properties.explanation !== null} onClick={() => properties.onBorder({ ...properties.border, [side]: on ? null : properties.stroke })}>
            {side[0]?.toUpperCase()}
            {side.slice(1)}
          </button>
        );
      })}
    </div>
  );
}

function RadiusEditor(properties: Readonly<{ radius: CornerRadius; onRadius: (radius: CornerRadius) => void; explanation: string | null }>): ReactElement {
  const radius = properties.radius;
  switch (radius.kind) {
    case "uniform":
      return (
        <>
          <NumberField label="Radius" value={{ kind: "value", value: radius.radius }} onCommit={(text) => numberOr(text, (value) => properties.onRadius({ kind: "uniform", radius: Math.max(0, value) }))} explanation={properties.explanation} />
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.explanation !== null} onClick={() => properties.onRadius({ kind: "perCorner", topLeft: radius.radius, topRight: radius.radius, bottomRight: radius.radius, bottomLeft: radius.radius })}>
            Set each corner
          </button>
        </>
      );
    case "perCorner": {
      const corner = (name: "topLeft" | "topRight" | "bottomRight" | "bottomLeft", label: string) => (
        <NumberField label={label} value={{ kind: "value", value: radius[name] }} onCommit={(text) => numberOr(text, (value) => properties.onRadius({ ...radius, [name]: Math.max(0, value) }))} explanation={properties.explanation} />
      );
      return (
        <>
          <div className={VIEW_CLASS.fieldGrid}>
            {corner("topLeft", "Top left")}
            {corner("topRight", "Top right")}
            {corner("bottomLeft", "Bottom left")}
            {corner("bottomRight", "Bottom right")}
          </div>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.explanation !== null} onClick={() => properties.onRadius({ kind: "uniform", radius: radius.topLeft })}>
            Same for all corners
          </button>
        </>
      );
    }
    default:
      return assertNever(radius);
  }
}

function LineStrokeEditor(properties: Readonly<{ theme: ThemeSnapshot; elements: readonly ElementSnapshot[]; lines: readonly Extract<ElementSnapshot, { kind: "line" }>[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const locked = lockedExplanation({ elements: properties.elements, control: "stroke" });
  const first = properties.lines[0];
  const stroke = first?.stroke ?? DEFAULT_STROKE;
  const patch = (next: Partial<Stroke>): void => properties.dispatch({ kind: "elementPatchRequested", patch: { stroke: { ...stroke, ...next } } });
  const arrowOptions = ARROW_OPTIONS;
  return (
    <Section title="Line" explanation={locked}>
      <div className={VIEW_CLASS.fieldGrid}>
        <NumberField label="Width" value={sharedValue(properties.lines.map((line) => line.stroke.width))} onCommit={(text) => numberOr(text, (width) => patch({ width: Math.max(0.5, width) }))} explanation={locked} />
        <ChoiceField<DashStyle> label="Dash" value={sharedValue(properties.lines.map((line) => line.stroke.dash))} options={DASH_OPTIONS} onChoose={(dash) => patch({ dash })} explanation={locked} />
        <ChoiceField label="Start" value={sharedValue(properties.lines.map((line) => line.startArrow))} options={arrowOptions} onChoose={(startArrow) => properties.dispatch({ kind: "elementPatchRequested", patch: { startArrow } })} explanation={locked} />
        <ChoiceField label="End" value={sharedValue(properties.lines.map((line) => line.endArrow))} options={arrowOptions} onChoose={(endArrow) => properties.dispatch({ kind: "elementPatchRequested", patch: { endArrow } })} explanation={locked} />
      </div>
      <ColourField label="Colour" value={sharedValue(properties.lines.map((line) => line.stroke.colour), sameStructure)} theme={properties.theme} onChoose={(colour) => patch({ colour })} explanation={locked} />
    </Section>
  );
}

function EffectsTab(properties: Readonly<{ theme: ThemeSnapshot; elements: readonly ElementSnapshot[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const boxes = properties.elements.flatMap(boxStyleOf);
  const shadowLocked = lockedExplanation({ elements: properties.elements, control: "shadow" });
  const opacityLocked = lockedExplanation({ elements: properties.elements, control: "opacity" });
  // Edits start from the first box's shadow (see the header); on and off show what the boxes share.
  const shadowOn = sharedValue(boxes.map((box) => (box.shadow === null ? "off" : "on")));
  const current = boxes[0]?.shadow ?? null;
  const shadows = boxes.flatMap((box) => (box.shadow === null ? [] : [box.shadow]));
  const opacities = properties.elements.flatMap(opacityOf);
  const setShadow = (next: Shadow | null): void => properties.dispatch({ kind: "elementPatchRequested", patch: { shadow: next } });
  return (
    <>
      {boxes.length === 0 ? null : (
        <Section title="Shadow" explanation={shadowLocked}>
          <PillChoice label="Shadow" value={shadowOn.kind === "value" ? shadowOn.value : null} disabled={shadowLocked !== null} options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} onChoose={(choice) => setShadow(choice === "on" ? (current ?? DEFAULT_SHADOW) : null)} />
          {current === null ? null : (
            <>
              <div className={VIEW_CLASS.fieldGrid}>
                <NumberField label="Across" value={sharedValue(shadows.map((each) => each.offsetX))} onCommit={(text) => numberOr(text, (offsetX) => setShadow({ ...current, offsetX }))} explanation={shadowLocked} />
                <NumberField label="Down" value={sharedValue(shadows.map((each) => each.offsetY))} onCommit={(text) => numberOr(text, (offsetY) => setShadow({ ...current, offsetY }))} explanation={shadowLocked} />
                <NumberField label="Blur" value={sharedValue(shadows.map((each) => each.blur))} onCommit={(text) => numberOr(text, (blur) => setShadow({ ...current, blur: Math.max(0, blur) }))} explanation={shadowLocked} />
                <NumberField label="Spread" value={sharedValue(shadows.map((each) => each.spread))} onCommit={(text) => numberOr(text, (spread) => setShadow({ ...current, spread }))} explanation={shadowLocked} />
              </div>
              <ColourField label="Colour" value={sharedValue(shadows.map((each) => each.colour), sameStructure)} theme={properties.theme} onChoose={(colour) => setShadow({ ...current, colour })} explanation={shadowLocked} />
            </>
          )}
        </Section>
      )}
      <Section title="Opacity" explanation={opacityLocked}>
        <NumberField label="Opacity" suffix="percent" value={sharedValue(opacities.map((opacity) => roundTo(opacity * 100, 0)))} onCommit={(text) => numberOr(text, (value) => properties.dispatch({ kind: "elementPatchRequested", patch: { opacity: clamp(value / 100, 0, 1) } }))} explanation={opacityLocked} />
      </Section>
      <CropSection elements={properties.elements} dispatch={properties.dispatch} />
    </>
  );
}

const CROP_SIDES: readonly Readonly<{ side: keyof ImageCrop; opposite: keyof ImageCrop; label: string }>[] = [
  { side: "left", opposite: "right", label: "Crop left" },
  { side: "right", opposite: "left", label: "Crop right" },
  { side: "top", opposite: "bottom", label: "Crop top" },
  { side: "bottom", opposite: "top", label: "Crop bottom" },
];

/**
 * Crop by numbers (SPEC.md section 3): percent of the image cut from each side, at least 1 % left
 * visible. Only for ONE selected image: a crop is one value per element, so a shared patch would
 * copy the first image's other three sides onto every other image.
 */
function CropSection(properties: Readonly<{ elements: readonly ElementSnapshot[]; dispatch: (event: EditorEvent) => void }>): ReactElement | null {
  const images = properties.elements.filter((element): element is ImageElement => element.kind === "image");
  const first = images[0];
  if (first === undefined || properties.elements.length !== 1) return null;
  const locked = lockedExplanation({ elements: images, control: "crop" });
  return (
    <Section title="Crop" explanation={locked}>
      <div className={VIEW_CLASS.fieldGrid}>
        {CROP_SIDES.map((entry) => (
          <NumberField
            key={entry.side}
            label={entry.label}
            suffix="percent"
            value={sharedValue(images.map((image) => roundTo(image.crop[entry.side] * 100, 1)))}
            onCommit={(text) =>
              numberOr(text, (percent) => {
                const crop = first.crop;
                properties.dispatch({ kind: "elementPatchRequested", patch: { crop: { ...crop, [entry.side]: clamp(percent / 100, 0, 0.99 - crop[entry.opposite]) } } });
              })
            }
            explanation={locked}
          />
        ))}
      </div>
    </Section>
  );
}

function TextTab(properties: Readonly<{ state: EditorState; subject: PanelSubject; elements: readonly ElementSnapshot[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const values = textValues(properties.state);
  const theme = properties.state.document.theme;
  const locked = lockedExplanation({ elements: properties.elements, control: "text" });
  const textBoxLocked = lockedExplanation({ elements: properties.elements, control: "textBox" });
  const dispatch = properties.dispatch;
  const runStyle = (patch: Extract<EditorEvent, { kind: "runStyleRequested" }>["patch"]): void => dispatch({ kind: "runStyleRequested", patch, clear: [] });
  const paragraphStyle = (patch: Extract<EditorEvent, { kind: "paragraphStyleRequested" }>["patch"]): void => dispatch({ kind: "paragraphStyleRequested", patch, clear: [] });
  const families = [...new Set([theme.headingFontFamily, theme.bodyFontFamily, ...CURATED_FONT_FAMILIES])];
  const shapes = properties.elements.flatMap(shapeOf);
  const firstShape = shapes[0];
  const setTextBox = (patch: Partial<TextBoxStyle>): void => {
    if (firstShape !== undefined) dispatch({ kind: "elementPatchRequested", patch: { textBox: { ...firstShape.textBox, ...patch } } });
  };
  return (
    <>
      <Section title="Characters" explanation={locked}>
        <div className={VIEW_CLASS.fieldGrid}>
          <ChoiceField label="Font" value={values.fontFamily} options={families.map((family) => ({ value: family, label: family }))} onChoose={(fontFamily) => runStyle({ fontFamily })} explanation={locked} />
          <NumberField
            label="Size"
            suffix="points"
            value={values.fontSizePoints}
            onCommit={(text) => {
              const event = fontSizeEvent(text);
              if (event !== null) dispatch(event);
            }}
            explanation={locked}
          />
          <ChoiceField
            label="Weight"
            value={sharedValue(values.fontWeight.kind === "value" ? [String(values.fontWeight.value)] : values.fontWeight.kind === "mixed" ? ["400", "700"] : [])}
            options={WEIGHT_OPTIONS}
            onChoose={(weight) => runStyle({ fontWeight: Number(weight) })}
            explanation={locked}
          />
          <NumberField label="Letter spacing" value={values.letterSpacing} onCommit={(text) => numberOr(text, (letterSpacing) => runStyle({ letterSpacing }))} explanation={locked} />
        </div>
        <div className={VIEW_CLASS.fieldRow}>
          <ToggleButton label="Bold" icon="bold" pressed={sharedBoolean(values.fontWeight, (weight) => weight >= 600)} onToggle={() => runStyle({ fontWeight: isOn(values.fontWeight, (weight) => weight >= 600) ? 400 : 700 })} explanation={locked} />
          <ToggleButton label="Italic" icon="italic" pressed={values.italic} onToggle={() => runStyle({ fontStyle: isOn(values.italic, (value) => value) ? "normal" : "italic" })} explanation={locked} />
          <ToggleButton label="Underline" icon="underline" pressed={values.underline} onToggle={() => runStyle({ underline: !isOn(values.underline, (value) => value) })} explanation={locked} />
          <ToggleButton label="Strikethrough" icon="strikethrough" pressed={values.strikethrough} onToggle={() => runStyle({ strikethrough: !isOn(values.strikethrough, (value) => value) })} explanation={locked} />
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={locked !== null} onClick={() => dispatch({ kind: "dialogOpened", dialog: { kind: "linkEditor" } })}>
            Link
          </button>
        </div>
        <div className={VIEW_CLASS.fieldGrid}>
          <ChoiceField label="Position" value={values.baselineOffset} options={[{ value: "none", label: "Normal" }, { value: "superscript", label: "Superscript" }, { value: "subscript", label: "Subscript" }]} onChoose={(baselineOffset) => runStyle({ baselineOffset })} explanation={locked} />
          <ChoiceField label="Case" value={values.textCase} options={[{ value: "none", label: "As typed" }, { value: "smallCaps", label: "Small capitals" }, { value: "allCaps", label: "All capitals" }]} onChoose={(textCase) => runStyle({ textCase })} explanation={locked} />
        </div>
        <div className={VIEW_CLASS.fieldGrid}>
          <ColourField label="Colour" value={values.colour} theme={theme} onChoose={(colour) => runStyle({ colour })} explanation={locked} />
          <ColourField label="Highlight" value={colourOnly(values.highlight)} theme={theme} onChoose={(highlight) => runStyle({ highlight })} explanation={locked} />
        </div>
      </Section>
      <Section title="Paragraphs" explanation={locked}>
        <div className={VIEW_CLASS.fieldRow}>
          <ToggleButton label="Align start" icon="alignStart" pressed={sharedIs(values.alignment, "start")} onToggle={() => paragraphStyle({ alignment: "start" })} explanation={locked} />
          <ToggleButton label="Align centre" icon="alignCentre" pressed={sharedIs(values.alignment, "centre")} onToggle={() => paragraphStyle({ alignment: "centre" })} explanation={locked} />
          <ToggleButton label="Align end" icon="alignEnd" pressed={sharedIs(values.alignment, "end")} onToggle={() => paragraphStyle({ alignment: "end" })} explanation={locked} />
          <ToggleButton label="Justify" icon="alignJustify" pressed={sharedIs(values.alignment, "justify")} onToggle={() => paragraphStyle({ alignment: "justify" })} explanation={locked} />
          <ToggleButton label="Bulleted list" icon="bulletedList" pressed={sharedIs(values.listKind, "bulleted")} onToggle={() => dispatch({ kind: "listToggled", list: "bulleted" })} explanation={locked} />
          <ToggleButton label="Numbered list" icon="numberedList" pressed={sharedIs(values.listKind, "numbered")} onToggle={() => dispatch({ kind: "listToggled", list: "numbered" })} explanation={locked} />
        </div>
        <ListGlyphPicker chosen={values.listGlyph} explanation={locked} onChoose={(glyph) => dispatch(listGlyphEvent({ glyph, listId: values.firstListId, state: properties.state }))} />
        <div className={VIEW_CLASS.fieldGrid}>
          <NumberField label="Line spacing" value={values.lineSpacing} onCommit={(text) => numberOr(text, (lineSpacing) => paragraphStyle({ lineSpacing: Math.max(0.5, lineSpacing) }))} explanation={locked} />
          <NumberField label="Indent" value={values.indentStart} onCommit={(text) => numberOr(text, (indentStart) => paragraphStyle({ indentStart: Math.max(0, indentStart) }))} explanation={locked} />
          <NumberField label="Space above" value={values.spaceAbove} onCommit={(text) => numberOr(text, (spaceAbove) => paragraphStyle({ spaceAbove: Math.max(0, spaceAbove) }))} explanation={locked} />
          <NumberField label="Space below" value={values.spaceBelow} onCommit={(text) => numberOr(text, (spaceBelow) => paragraphStyle({ spaceBelow: Math.max(0, spaceBelow) }))} explanation={locked} />
          <NumberField label="First line indent" value={values.indentFirstLine} onCommit={(text) => numberOr(text, (indentFirstLine) => paragraphStyle({ indentFirstLine }))} explanation={locked} />
          <ChoiceField label="Direction" value={values.direction} options={[{ value: "leftToRight", label: "Left to right" }, { value: "rightToLeft", label: "Right to left" }]} onChoose={(direction) => paragraphStyle({ direction })} explanation={locked} />
        </div>
      </Section>
      {firstShape === undefined ? null : (
        <Section title="Text box" explanation={textBoxLocked}>
          <PillChoice label="Vertical alignment" value={firstShape.textBox.verticalAlignment} disabled={textBoxLocked !== null} options={[{ value: "top", label: "Top" }, { value: "middle", label: "Middle" }, { value: "bottom", label: "Bottom" }]} onChoose={(verticalAlignment) => setTextBox({ verticalAlignment })} />
          <ChoiceField
            label="When text does not fit"
            value={sharedValue(shapes.map((shape) => shape.textBox.autofit))}
            options={[{ value: "none", label: "Let it overflow" }, { value: "shrinkText", label: "Shrink the text" }, { value: "resizeShape", label: "Grow the box" }]}
            onChoose={(autofit) => setTextBox({ autofit })}
            explanation={textBoxLocked}
          />
          <PillChoice label="Wrap text" value={firstShape.textBox.wrap ? "wrap" : "noWrap"} disabled={textBoxLocked !== null} options={[{ value: "wrap", label: "Wrap" }, { value: "noWrap", label: "One line" }]} onChoose={(choice) => setTextBox({ wrap: choice === "wrap" })} />
          <div className={VIEW_CLASS.fieldGrid}>
            <NumberField label="Padding top" value={sharedValue(shapes.map((shape) => shape.textBox.paddingTop))} onCommit={(text) => numberOr(text, (paddingTop) => setTextBox({ paddingTop: Math.max(0, paddingTop) }))} explanation={textBoxLocked} />
            <NumberField label="Padding bottom" value={sharedValue(shapes.map((shape) => shape.textBox.paddingBottom))} onCommit={(text) => numberOr(text, (paddingBottom) => setTextBox({ paddingBottom: Math.max(0, paddingBottom) }))} explanation={textBoxLocked} />
            <NumberField label="Padding left" value={sharedValue(shapes.map((shape) => shape.textBox.paddingLeft))} onCommit={(text) => numberOr(text, (paddingLeft) => setTextBox({ paddingLeft: Math.max(0, paddingLeft) }))} explanation={textBoxLocked} />
            <NumberField label="Padding right" value={sharedValue(shapes.map((shape) => shape.textBox.paddingRight))} onCommit={(text) => numberOr(text, (paddingRight) => setTextBox({ paddingRight: Math.max(0, paddingRight) }))} explanation={textBoxLocked} />
          </div>
        </Section>
      )}
    </>
  );
}

/** The 12 list styles (list-glyphs.ts), as a radio group; choosing one styles the selected paragraphs. */
export function ListGlyphPicker(properties: Readonly<{ chosen: SharedValue<ListGlyph | "none">; explanation: string | null; onChoose: (glyph: ListGlyph) => void }>): ReactElement {
  const chosen = properties.chosen.kind === "value" ? properties.chosen.value : null;
  const chosenIndex = LIST_GLYPH_PRESETS.findIndex((preset) => preset.glyph === chosen);
  return (
    <div
      className={VIEW_CLASS.glyphGrid}
      role="radiogroup"
      aria-label="List style"
      title={properties.explanation ?? undefined}
      onKeyDown={(event) =>
        handlePillGroupKey(event, (index) => {
          const preset = LIST_GLYPH_PRESETS[index];
          if (preset !== undefined) properties.onChoose(preset.glyph);
        })
      }
    >
      {LIST_GLYPH_PRESETS.map((preset, index) => (
        <button
          key={preset.glyph}
          type="button"
          role="radio"
          className={VIEW_CLASS.glyphChoice}
          aria-checked={preset.glyph === chosen}
          aria-label={preset.label}
          title={preset.label}
          data-list-glyph={preset.glyph}
          tabIndex={rovingTabIndex({ index, chosenIndex })}
          disabled={properties.explanation !== null}
          onClick={() => properties.onChoose(preset.glyph)}
        >
          {preset.sample}
        </button>
      ))}
    </div>
  );
}

/**
 * The picker's request: a paragraph list style with the chosen glyph. The reducer keeps each
 * paragraph's own list and level and mints a list for paragraphs in none (state text-editing.ts
 * `chooseListGlyph`), so the list id sent only has to be a valid one: the selection's first list,
 * or the next id the editor's seed would mint (never stored).
 */
export function listGlyphEvent(options: Readonly<{ glyph: ListGlyph; listId: ReturnType<typeof textValues>["firstListId"]; state: EditorState }>): EditorEvent {
  const listId = options.listId ?? mintId({ seed: options.state.idSeed, kind: "list" }).id;
  return { kind: "paragraphStyleRequested", patch: { list: { kind: "list", listId, glyph: options.glyph, level: 0 } }, clear: [] };
}

function SlideTab(properties: Readonly<{ state: EditorState; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const state = properties.state;
  const slide = state.document.slides.find((candidate) => candidate.id === state.currentSlideId) ?? null;
  if (slide === null) return <p className={TIDEPOOL_CLASS.muted}>Add a slide to set its background.</p>;
  const background = slideBackground({ slide, document: state.document });
  return (
    <>
      <FillEditor
        title="Background"
        theme={state.document.theme}
        fill={{ kind: "value", value: background }}
        onFill={(fill) => properties.dispatch({ kind: "slidePropertiesRequested", patch: { background: fill } })}
        explanation={null}
        allowImage
        destination="slideBackground"
        dispatch={properties.dispatch}
      />
      <Section title="Layout">
        <ChoiceField
          label="Layout"
          value={slide.layoutId === null ? { kind: "none" } : { kind: "value", value: slide.layoutId }}
          options={state.document.layouts.map((layout) => ({ value: layout.id, label: layout.name }))}
          onChoose={(layoutId) => properties.dispatch({ kind: "slideLayoutChosen", layoutId })}
          explanation={state.document.layouts.length === 0 ? "This deck has no layouts yet." : null}
        />
      </Section>
      <Section title="Presenting">
        <div className={VIEW_CLASS.fieldRow}>
          <ToggleButton label="Skip this slide when presenting" icon="skipped" pressed={slide.skipped} onToggle={() => properties.dispatch({ kind: "slidePropertiesRequested", patch: { skipped: !slide.skipped } })} explanation={null} />
          <span>{slide.skipped ? "Skipped when presenting" : "Shown when presenting"}</span>
        </div>
      </Section>
    </>
  );
}

/** The Transition tab; "Scripted" in a deck without scripts says how to get one (SPEC.md 21.9, fix 5). */
export function TransitionTab(properties: Readonly<{ state: EditorState; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const services = useEditorServices();
  // "Scripted" chosen while the deck has no script cannot be stored (a scripted transition names
  // its script), so the choice is this tab's own until a script exists.
  const [pickedScripted, setPickedScripted] = useState(false);
  const state = properties.state;
  const slide = state.document.slides.find((candidate) => candidate.id === state.currentSlideId) ?? null;
  if (slide === null) return <p className={TIDEPOOL_CLASS.muted}>Add a slide to give it a transition.</p>;
  const transition = slide.transition;
  const set = (next: SlideTransition | null): void => properties.dispatch({ kind: "slidePropertiesRequested", patch: { transition: next } });
  const choice = pickedScripted && transition === null ? "scripted" : transitionChoice(transition);
  const scripts = state.document.transitionScripts;
  const preview = state.chrome.transitionPreview;
  const Preview = services.TransitionPreview;
  return (
    <>
      <Section title="Into this slide">
        <ChoiceField<TransitionChoice>
          label="Transition"
          value={{ kind: "value", value: choice }}
          options={[
            { value: "none", label: "None (cut)" },
            { value: "fade", label: "Fade" },
            { value: "push", label: "Push" },
            { value: "slide", label: "Slide over" },
            { value: "zoom", label: "Zoom" },
            { value: "morph", label: "Morph" },
            { value: "scripted", label: "Scripted by Claude or you" },
          ]}
          onChoose={(next) => {
            setPickedScripted(next === "scripted");
            set(transitionFor({ choice: next, previous: transition, scripts }));
          }}
          explanation={null}
        />
        {choice === "scripted" && scripts.length === 0 ? <NoScriptsYet onWrite={() => properties.dispatch({ kind: "transitionScriptEditorOpened", scriptId: null, purpose: "transition" })} /> : null}
        {transition === null ? null : (
          <NumberField label="Duration" suffix="milliseconds" value={{ kind: "value", value: transition.durationMilliseconds }} onCommit={(text) => numberOr(text, (duration) => set({ ...transition, durationMilliseconds: clamp(duration, 50, 10_000) }))} explanation={null} />
        )}
        {transition !== null && transition.kind === "builtin" ? (
          <ChoiceField
            label="Easing"
            value={{ kind: "value", value: transition.easing }}
            options={[{ value: "linear", label: "Linear" }, { value: "easeIn", label: "Ease in" }, { value: "easeOut", label: "Ease out" }, { value: "easeInOut", label: "Ease in and out" }]}
            onChoose={(easing) => set({ ...transition, easing })}
            explanation={null}
          />
        ) : null}
        {transition !== null && transition.kind === "builtin" ? <BuiltinEffectFields effect={transition.effect} onEffect={(effect) => set({ ...transition, effect })} /> : null}
        {transition !== null && transition.kind === "scripted" ? (
          <>
            <ChoiceField label="Script" value={{ kind: "value", value: transition.scriptId }} options={scripts.map((script) => ({ value: script.id, label: script.name }))} onChoose={(scriptId) => set({ ...transition, scriptId })} explanation={scripts.length === 0 ? "No scripts yet." : null} />
            <div className={VIEW_CLASS.fieldRow}>
              <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => properties.dispatch({ kind: "transitionScriptEditorOpened", scriptId: transition.scriptId, purpose: "transition" })}>
                Edit script
              </button>
            </div>
          </>
        ) : null}
        <div className={VIEW_CLASS.fieldRow}>
          <button type="button" className={TIDEPOOL_CLASS.primaryPill} disabled={transition === null} onClick={() => properties.dispatch({ kind: "transitionPreviewRequested", slideId: slide.id })}>
            <Icon name="present" /> Preview
          </button>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => properties.dispatch({ kind: "transitionScriptEditorOpened", scriptId: null, purpose: "transition" })}>
            New script
          </button>
        </div>
        {preview === null || preview.slideId !== slide.id ? null : (
          <div className={VIEW_CLASS.previewBox}>
            <Preview dependencies={services.presenterDependencies} document={state.document} slideId={slide.id} generation={preview.generation} width={260} onEnded={() => properties.dispatch({ kind: "transitionPreviewEnded" })} />
          </div>
        )}
      </Section>
    </>
  );
}

export const NO_SCRIPTS_EXPLANATION = "No scripted transitions in this deck yet. Ask Claude to write one (it arrives for your approval), or write one yourself.";

function NoScriptsYet(properties: Readonly<{ onWrite: () => void }>): ReactElement {
  return (
    <div className={VIEW_CLASS.section} role="note">
      <p className={TIDEPOOL_CLASS.muted} style={{ margin: 0 }}>
        {NO_SCRIPTS_EXPLANATION}
      </p>
      <div className={VIEW_CLASS.fieldRow}>
        <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={properties.onWrite}>
          Write a script
        </button>
      </div>
    </div>
  );
}

const SLIDE_DIRECTION_OPTIONS: readonly Readonly<{ value: SlideDirection; label: string }>[] = [
  { value: "fromRight", label: "From the right" },
  { value: "fromLeft", label: "From the left" },
  { value: "fromBottom", label: "From the bottom" },
  { value: "fromTop", label: "From the top" },
];

/** Direction and mode of the built-ins that have them (SPEC.md section 9, "Transition"). */
function BuiltinEffectFields(properties: Readonly<{ effect: BuiltinTransitionEffect; onEffect: (effect: BuiltinTransitionEffect) => void }>): ReactElement | null {
  const effect = properties.effect;
  switch (effect.effect) {
    case "fade":
    case "morph":
      return null;
    case "push":
      return <ChoiceField label="Direction" value={{ kind: "value", value: effect.direction }} options={SLIDE_DIRECTION_OPTIONS} onChoose={(direction) => properties.onEffect({ ...effect, direction })} explanation={null} />;
    case "slide":
      return (
        <>
          <ChoiceField label="Direction" value={{ kind: "value", value: effect.direction }} options={SLIDE_DIRECTION_OPTIONS} onChoose={(direction) => properties.onEffect({ ...effect, direction })} explanation={null} />
          <ChoiceField label="Mode" value={{ kind: "value", value: effect.mode }} options={[{ value: "cover", label: "Cover the old slide" }, { value: "uncover", label: "Uncover the new slide" }]} onChoose={(mode) => properties.onEffect({ ...effect, mode })} explanation={null} />
        </>
      );
    case "zoom":
      return <ChoiceField label="Mode" value={{ kind: "value", value: effect.mode }} options={[{ value: "in", label: "Zoom in" }, { value: "out", label: "Zoom out" }]} onChoose={(mode) => properties.onEffect({ ...effect, mode })} explanation={null} />;
    default:
      return assertNever(effect);
  }
}

type TransitionChoice = "none" | "fade" | "push" | "slide" | "zoom" | "morph" | "scripted";

function transitionChoice(transition: SlideTransition | null): TransitionChoice {
  if (transition === null) return "none";
  switch (transition.kind) {
    case "builtin":
      return transition.effect.effect;
    case "scripted":
      return "scripted";
    default:
      return assertNever(transition);
  }
}

function transitionFor(options: Readonly<{ choice: TransitionChoice; previous: SlideTransition | null; scripts: EditorState["document"]["transitionScripts"] }>): SlideTransition | null {
  const duration = options.previous?.durationMilliseconds ?? 500;
  const easing = options.previous !== null && options.previous.kind === "builtin" ? options.previous.easing : "easeInOut";
  switch (options.choice) {
    case "none":
      return null;
    case "fade":
      return { kind: "builtin", effect: { effect: "fade" }, durationMilliseconds: duration, easing };
    case "push":
      return { kind: "builtin", effect: { effect: "push", direction: "fromRight" }, durationMilliseconds: duration, easing };
    case "slide":
      return { kind: "builtin", effect: { effect: "slide", direction: "fromRight", mode: "cover" }, durationMilliseconds: duration, easing };
    case "zoom":
      return { kind: "builtin", effect: { effect: "zoom", mode: "in" }, durationMilliseconds: duration, easing };
    case "morph":
      return { kind: "builtin", effect: { effect: "morph" }, durationMilliseconds: duration, easing };
    case "scripted": {
      const script = options.scripts[0];
      return script === undefined ? options.previous : { kind: "scripted", scriptId: script.id, durationMilliseconds: duration, parameters: {} };
    }
    default:
      return assertNever(options.choice);
  }
}

const DEFAULT_STROKE: Stroke = { width: 2, colour: themeColour({ slot: "dark1", alpha: 1 }), dash: "solid" };
const DEFAULT_SHADOW: Shadow = { offsetX: 0, offsetY: 8, blur: 16, spread: 0, colour: literalColour({ hexadecimal: "#1c2333", alpha: 0.25 }) };

const DASH_OPTIONS: readonly Readonly<{ value: DashStyle; label: string }>[] = [
  { value: "solid", label: "Solid" },
  { value: "dot", label: "Dotted" },
  { value: "dash", label: "Dashed" },
  { value: "longDash", label: "Long dashes" },
  { value: "dashDot", label: "Dash and dot" },
  { value: "longDashDot", label: "Long dash and dot" },
];

const ARROW_OPTIONS = [
  { value: "none", label: "None" },
  { value: "triangle", label: "Triangle" },
  { value: "openArrow", label: "Open arrow" },
  { value: "stealth", label: "Stealth" },
  { value: "diamond", label: "Diamond" },
  { value: "oval", label: "Oval" },
  { value: "bar", label: "Bar" },
] as const;

const WEIGHT_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
  { value: "800", label: "Extra bold" },
];

/**
 * Cell borders for the cells the selection means (the reducer decides which; editor-events.ts): no
 * borders, or one stroke on every side. The values shown are the table's cells, "mixed" when they
 * differ.
 */
function CellBordersEditor(properties: Readonly<{ theme: ThemeSnapshot; tables: readonly TableElement[]; dispatch: (event: EditorEvent) => void }>): ReactElement {
  const sides = properties.tables.flatMap((table) => table.cells.flatMap((cell) => [cell.borders.top, cell.borders.right, cell.borders.bottom, cell.borders.left]));
  const shared = sharedValue(sides, sameStructure);
  const current = shared.kind === "value" ? shared.value : null;
  const stroke = current ?? DEFAULT_STROKE;
  const setSides = (next: Stroke | null): void => properties.dispatch({ kind: "tableCellPatchRequested", patch: { borders: { top: next, right: next, bottom: next, left: next } } });
  const strokeForChoice: Readonly<Record<"none" | "all", Stroke | null>> = { none: null, all: stroke };
  return (
    <Section title="Cell borders" explanation={null}>
      <PillChoice
        label="Cell borders"
        value={shared.kind === "value" ? (current === null ? "none" : "all") : null}
        disabled={false}
        onChoose={(choice) => setSides(strokeForChoice[choice])}
        options={[{ value: "none", label: "None" }, { value: "all", label: "All sides" }]}
      />
      {current === null ? null : (
        <>
          <div className={VIEW_CLASS.fieldGrid}>
            <NumberField label="Width" value={{ kind: "value", value: current.width }} onCommit={(text) => numberOr(text, (width) => setSides({ ...current, width: Math.max(0, width) }))} explanation={null} />
            <ChoiceField<DashStyle> label="Dash" value={{ kind: "value", value: current.dash }} options={DASH_OPTIONS} onChoose={(dash) => setSides({ ...current, dash })} explanation={null} />
          </div>
          <ColourField label="Colour" value={{ kind: "value", value: current.colour }} theme={properties.theme} onChoose={(colour) => setSides({ ...current, colour })} explanation={null} />
        </>
      )}
    </Section>
  );
}

function tablesOf(element: ElementSnapshot): readonly TableElement[] {
  switch (element.kind) {
    case "table":
      return [element];
    case "shape":
    case "image":
    case "line":
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function boxStyleOf(element: ElementSnapshot): readonly ShapeElement["box"][] {
  switch (element.kind) {
    case "shape":
    case "image":
      return [element.box];
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function lineOf(element: ElementSnapshot): readonly Extract<ElementSnapshot, { kind: "line" }>[] {
  switch (element.kind) {
    case "line":
      return [element];
    case "shape":
    case "image":
    case "table":
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function shapeOf(element: ElementSnapshot): readonly ShapeElement[] {
  switch (element.kind) {
    case "shape":
      return [element];
    case "image":
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function opacityOf(element: ElementSnapshot): readonly number[] {
  switch (element.kind) {
    case "shape":
    case "image":
      return [element.box.opacity];
    case "line":
    case "table":
      return [element.opacity];
    case "group":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function textBearing(elements: readonly ElementSnapshot[]): boolean {
  return elements.some((element) => {
    switch (element.kind) {
      case "shape":
      case "table":
        return true;
      case "group":
        return textBearing(element.children);
      case "image":
      case "line":
      case "unsupported":
        return false;
      default:
        return assertNever(element);
    }
  });
}

function allowsPerSide(element: ElementSnapshot): boolean {
  switch (element.kind) {
    case "shape":
      return isRectangleFamily(element.preset);
    case "image":
      return true;
    case "line":
    case "table":
    case "group":
    case "unsupported":
      return false;
    default:
      return assertNever(element);
  }
}

/** The strokes a border draws, one per drawn side (none for no border). */
function drawnStrokes(border: Border): readonly Stroke[] {
  switch (border.kind) {
    case "none":
      return [];
    case "uniform":
      return [border.stroke];
    case "perSide":
      return [border.top, border.right, border.bottom, border.left].filter((side): side is Stroke => side !== null);
    default:
      return assertNever(border);
  }
}

function borderStroke(border: Border): Stroke {
  switch (border.kind) {
    case "none":
      return DEFAULT_STROKE;
    case "uniform":
      return border.stroke;
    case "perSide":
      return border.top ?? border.right ?? border.bottom ?? border.left ?? DEFAULT_STROKE;
    default:
      return assertNever(border);
  }
}

function borderKindIsNone(border: Border): boolean {
  switch (border.kind) {
    case "none":
      return true;
    case "uniform":
    case "perSide":
      return false;
    default:
      return assertNever(border);
  }
}

function borderOfKind(options: Readonly<{ kind: Border["kind"]; stroke: Stroke }>): Border {
  switch (options.kind) {
    case "none":
      return { kind: "none" };
    case "uniform":
      return { kind: "uniform", stroke: options.stroke };
    case "perSide":
      return { kind: "perSide", top: options.stroke, right: options.stroke, bottom: options.stroke, left: options.stroke };
    default:
      return assertNever(options.kind);
  }
}

/** The same border with every drawn side set to `stroke`. */
function withStroke(border: Border, stroke: Stroke): Border {
  switch (border.kind) {
    case "none":
      return border;
    case "uniform":
      return { kind: "uniform", stroke };
    case "perSide":
      return { kind: "perSide", top: border.top === null ? null : stroke, right: border.right === null ? null : stroke, bottom: border.bottom === null ? null : stroke, left: border.left === null ? null : stroke };
    default:
      return assertNever(border);
  }
}

function fillColours(fill: Fill | null): Readonly<{ first: Colour; second: Colour }> {
  const fallback = { first: themeColour({ slot: "accent1", alpha: 1 }), second: themeColour({ slot: "accent2", alpha: 1 }) };
  if (fill === null) return fallback;
  switch (fill.kind) {
    case "solid":
      return { first: fill.colour, second: fallback.second };
    case "linearGradient":
    case "radialGradient":
      return { first: fill.stops[0]?.colour ?? fallback.first, second: fill.stops[fill.stops.length - 1]?.colour ?? fallback.second };
    case "none":
    case "image":
      return fallback;
    default:
      return assertNever(fill);
  }
}

function sharedBoolean(value: SharedValue<number>, test: (value: number) => boolean): SharedValue<boolean> {
  switch (value.kind) {
    case "value":
      return { kind: "value", value: test(value.value) };
    case "mixed":
    case "none":
      return value;
    default:
      return assertNever(value);
  }
}

function sharedIs<TValue>(value: SharedValue<TValue>, expected: TValue): SharedValue<boolean> {
  switch (value.kind) {
    case "value":
      return { kind: "value", value: value.value === expected };
    case "mixed":
    case "none":
      return value;
    default:
      return assertNever(value);
  }
}

function isOn<TValue>(value: SharedValue<TValue>, test: (value: TValue) => boolean): boolean {
  switch (value.kind) {
    case "value":
      return test(value.value);
    case "mixed":
    case "none":
      return false;
    default:
      return assertNever(value);
  }
}

/** A highlight that is "no colour" shows as nothing chosen. */
function colourOnly(value: SharedValue<Colour | NoColour>): SharedValue<Colour> {
  switch (value.kind) {
    case "value": {
      const colour = value.value;
      switch (colour.kind) {
        case "none":
          return { kind: "none" };
        case "literal":
        case "theme":
          return { kind: "value", value: colour };
        default:
          return assertNever(colour);
      }
    }
    case "mixed":
    case "none":
      return value;
    default:
      return assertNever(value);
  }
}

function numberOr(text: string, use: (value: number) => void): void {
  const value = Number(text.trim());
  if (Number.isFinite(value)) use(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sameStructure<TValue>(first: TValue, second: TValue): boolean {
  return first === second || JSON.stringify(first) === JSON.stringify(second);
}

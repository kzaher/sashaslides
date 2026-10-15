// THE PANEL'S CONTROLS: number, choice, toggle and colour fields in Tidepool (pill-rounded fields on
// card glass, ink and secondary pills), each showing a `SharedValue` -- a value, "mixed" or nothing
// -- and each able to say why it is disabled. Every control commits ONE event per user decision:
// a number field on Enter or when it loses focus, never per keystroke, so one edit is one undo step.
//
// The colour field's popover is drawn over whatever is below it, which may be the slide, so it is a
// `.sasha-popover` (nearly opaque glass). Its palette holds SLIDE colours (theme slots, a standard
// set and this viewer's recent choices), which are document values, not chrome colours. Every
// colour the picker applies is reported as `recentColourUsed`, which keeps the "Recent" row.
//
// A pill choice is a radio group with a roving tab index: the arrow keys, Home and End move between
// its pills and choose, and never reach the canvas (pill-group.ts).

import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ThemeSnapshot } from "../../contracts/document.ts";
import { THEME_COLOUR_SLOTS, literalColour, themeColour, type Colour, type ThemeColourSlot } from "../../contracts/style.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { FloatingLayerContext, arrayItemsEqual, useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { colourValue } from "../render/inline-styles.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon, type IconName } from "./icons.tsx";
import { handlePillGroupKey, rovingTabIndex } from "./pill-group.ts";
import { MIXED_PLACEHOLDER, type SharedValue } from "./properties-values.ts";

export function NumberField(properties: Readonly<{
  label: string;
  value: SharedValue<number>;
  onCommit: (text: string) => void;
  explanation: string | null;
  suffix?: string;
}>): ReactElement {
  const shown = sharedText(properties.value);
  const [draft, setDraft] = useState(shown);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(shown);
  }, [shown]);
  const commit = (): void => {
    editing.current = false;
    if (draft.trim() === shown || draft.trim() === "") {
      setDraft(shown);
      return;
    }
    properties.onCommit(draft);
  };
  const disabled = properties.explanation !== null;
  return (
    <label className={VIEW_CLASS.fieldLabel} title={properties.explanation ?? undefined}>
      <span>
        {properties.label}
        {properties.suffix === undefined ? null : <span className={TIDEPOOL_CLASS.subtle}> {properties.suffix}</span>}
      </span>
      <input
        className={`${TIDEPOOL_CLASS.field} ${VIEW_CLASS.numberInput}`}
        inputMode="decimal"
        value={draft}
        placeholder={properties.value.kind === "mixed" ? MIXED_PLACEHOLDER : ""}
        disabled={disabled}
        aria-label={properties.label}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            editing.current = false;
            setDraft(shown);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function ChoiceField<TValue extends string>(properties: Readonly<{
  label: string;
  value: SharedValue<TValue>;
  options: readonly Readonly<{ value: TValue; label: string }>[];
  onChoose: (value: TValue) => void;
  explanation: string | null;
}>): ReactElement {
  const current = properties.value.kind === "value" ? properties.value.value : "";
  return (
    <label className={VIEW_CLASS.fieldLabel} title={properties.explanation ?? undefined}>
      <span>{properties.label}</span>
      <select
        className={VIEW_CLASS.select}
        value={current}
        disabled={properties.explanation !== null}
        aria-label={properties.label}
        onChange={(event) => {
          const chosen = properties.options.find((option) => option.value === event.currentTarget.value);
          if (chosen !== undefined) properties.onChoose(chosen.value);
        }}
      >
        {properties.value.kind === "value" ? null : <option value="">{properties.value.kind === "mixed" ? MIXED_PLACEHOLDER : "None"}</option>}
        {properties.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ToggleButton(properties: Readonly<{ label: string; icon: IconName; pressed: SharedValue<boolean> | boolean; onToggle: () => void; explanation: string | null }>): ReactElement {
  const pressed = typeof properties.pressed === "boolean" ? properties.pressed : properties.pressed.kind === "value" && properties.pressed.value;
  const mixed = typeof properties.pressed !== "boolean" && properties.pressed.kind === "mixed";
  return (
    <button
      type="button"
      className={TIDEPOOL_CLASS.iconButton}
      aria-label={properties.label}
      title={properties.explanation ?? properties.label}
      aria-pressed={mixed ? "mixed" : pressed}
      disabled={properties.explanation !== null}
      onClick={properties.onToggle}
    >
      <Icon name={properties.icon} />
    </button>
  );
}

export function PillChoice<TValue extends string>(properties: Readonly<{ label: string; value: TValue | null; options: readonly Readonly<{ value: TValue; label: string }>[]; onChoose: (value: TValue) => void; disabled?: boolean }>): ReactElement {
  const chosenIndex = properties.options.findIndex((option) => option.value === properties.value);
  return (
    <div
      className={TIDEPOOL_CLASS.tabs}
      role="radiogroup"
      aria-label={properties.label}
      onKeyDown={(event) =>
        handlePillGroupKey(event, (index) => {
          const option = properties.options[index];
          if (option !== undefined) properties.onChoose(option.value);
        })
      }
    >
      {properties.options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className={TIDEPOOL_CLASS.tab}
          aria-checked={properties.value === option.value}
          aria-selected={properties.value === option.value}
          tabIndex={rovingTabIndex({ index, chosenIndex })}
          disabled={properties.disabled === true}
          onClick={() => properties.onChoose(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Section(properties: Readonly<{ title: string; children: ReactNode; explanation?: string | null }>): ReactElement {
  return (
    <section className={`${TIDEPOOL_CLASS.card} ${VIEW_CLASS.section}`} aria-label={properties.title}>
      <h3 className={VIEW_CLASS.sectionTitle}>{properties.title}</h3>
      {properties.explanation === undefined || properties.explanation === null ? null : <p className={VIEW_CLASS.explanation}>{properties.explanation}</p>}
      {properties.children}
    </section>
  );
}

/** A colour control: a swatch button opening a palette with theme colours, a standard set, hexadecimal entry and alpha. */
export function ColourField(properties: Readonly<{
  label: string;
  value: SharedValue<Colour>;
  theme: ThemeSnapshot;
  onChoose: (colour: Colour) => void;
  explanation: string | null;
}>): ReactElement {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const recent = useEditorSelector((state) => state.chrome.recentColours, arrayItemsEqual);
  const dispatch = useEditorServices().system.dispatch;
  const shown = properties.value.kind === "value" ? colourValue(properties.value.value, properties.theme) : "transparent";
  return (
    <div className={VIEW_CLASS.popoverAnchor}>
      <span className={VIEW_CLASS.fieldLabel}>{properties.label}</span>
      <button
        ref={button}
        type="button"
        className={VIEW_CLASS.colourButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        disabled={properties.explanation !== null}
        title={properties.explanation ?? undefined}
        onClick={() => setOpen(!open)}
      >
        <span style={{ background: shown }} />
        <span>{colourLabel(properties.value, properties.theme)}</span>
      </button>
      {open ? (
        <ColourPopover
          anchor={button.current}
          id={popoverId}
          theme={properties.theme}
          value={properties.value}
          recent={recent}
          onChoose={(colour) => {
            properties.onChoose(colour);
            dispatch({ kind: "recentColourUsed", colour });
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ColourPopover(properties: Readonly<{ anchor: HTMLElement | null; id: string; theme: ThemeSnapshot; value: SharedValue<Colour>; recent: readonly Colour[]; onChoose: (colour: Colour) => void; onClose: () => void }>): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const floatingLayer = useContext(FloatingLayerContext);
  const [position, setPosition] = useState<Readonly<{ left: number; top: number }> | null>(null);
  useLayoutEffect(() => {
    const anchor = properties.anchor?.getBoundingClientRect();
    const element = root.current;
    if (anchor === undefined || element === null) return;
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - element.offsetWidth - 8)), top: Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - element.offsetHeight - 8)) });
  }, [properties.anchor]);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  const popover = (
    <div
      ref={root}
      id={properties.id}
      role="dialog"
      aria-label="Choose a colour"
      className={TIDEPOOL_CLASS.popover}
      style={{ position: "fixed", left: position?.left ?? 0, top: position?.top ?? 0, visibility: position === null ? "hidden" : "visible", inlineSize: 240, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          properties.onClose();
        }
      }}
    >
      <ColourPalette theme={properties.theme} value={properties.value} recent={properties.recent} onChoose={properties.onChoose} />
    </div>
  );
  const layered = (
    <>
      <div style={{ position: "fixed", inset: 0 }} onPointerDown={properties.onClose} aria-hidden="true" />
      {popover}
    </>
  );
  return floatingLayer === null ? layered : createPortal(layered, floatingLayer);
}

/**
 * The colour picker's content: "Recent" (this viewer's last choices, most recent first, from
 * `chrome.recentColours`), the theme, a standard set, hexadecimal entry and alpha.
 */
export function ColourPalette(properties: Readonly<{ theme: ThemeSnapshot; value: SharedValue<Colour>; recent: readonly Colour[]; onChoose: (colour: Colour) => void }>): ReactElement {
  const current = properties.value.kind === "value" ? properties.value.value : null;
  const [hexadecimal, setHexadecimal] = useState(current === null ? "" : colourValue({ ...current, alpha: 1 }, properties.theme));
  const [alpha, setAlpha] = useState(current?.alpha ?? 1);
  return (
    <>
      {properties.recent.length === 0 ? null : (
        <>
          <span className={TIDEPOOL_CLASS.subtle}>Recent</span>
          <div className={VIEW_CLASS.swatches} role="group" aria-label="Recent colours">
            {properties.recent.map((colour, index) => (
              <button
                key={index}
                type="button"
                className={VIEW_CLASS.swatch}
                style={{ background: colourValue(colour, properties.theme) }}
                aria-label={`Recent: ${colourName(colour, properties.theme)}`}
                aria-pressed={current !== null && sameColour(current, colour)}
                onClick={() => properties.onChoose(colour)}
              />
            ))}
          </div>
        </>
      )}
      <span className={TIDEPOOL_CLASS.subtle}>Theme</span>
      <div className={VIEW_CLASS.swatches}>
        {THEME_COLOUR_SLOTS.slice(0, 10).map((slot) => {
          const colour = themeColour({ slot, alpha });
          return <button key={slot} type="button" className={VIEW_CLASS.swatch} style={{ background: properties.theme.colours[slot] }} aria-label={THEME_SLOT_LABEL[slot]} aria-pressed={current !== null && sameColour(current, colour)} onClick={() => properties.onChoose(colour)} />;
        })}
      </div>
      <span className={TIDEPOOL_CLASS.subtle}>Standard</span>
      <div className={VIEW_CLASS.swatches}>
        {STANDARD_PALETTE.map((value) => {
          const colour = literalColour({ hexadecimal: value, alpha });
          return <button key={value} type="button" className={VIEW_CLASS.swatch} style={{ background: value }} aria-label={value} aria-pressed={current !== null && sameColour(current, colour)} onClick={() => properties.onChoose(colour)} />;
        })}
      </div>
      <div className={VIEW_CLASS.fieldRow}>
        <label className={VIEW_CLASS.fieldLabel} style={{ flex: 1 }}>
          <span>Hexadecimal</span>
          <input className={TIDEPOOL_CLASS.field} value={hexadecimal} placeholder="#1c2333" onChange={(event) => setHexadecimal(event.currentTarget.value)} />
        </label>
        <label className={VIEW_CLASS.fieldLabel} style={{ inlineSize: 72 }}>
          <span>Opacity</span>
          <input className={TIDEPOOL_CLASS.field} inputMode="numeric" value={Math.round(alpha * 100)} onChange={(event) => setAlpha(Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0)) / 100)} />
        </label>
      </div>
      <button
        type="button"
        className={TIDEPOOL_CLASS.primaryPill}
        onClick={() => {
          const parsed = /^#?([0-9a-f]{6})$/i.exec(hexadecimal.trim());
          if (parsed !== null) properties.onChoose(literalColour({ hexadecimal: `#${(parsed[1] ?? "000000").toLowerCase()}`, alpha }));
        }}
      >
        Use this colour
      </button>
    </>
  );
}

/** A colour in words for a swatch's accessible name: the theme slot's name, or its hexadecimal value and opacity. */
function colourName(colour: Colour, theme: ThemeSnapshot): string {
  const opacity = colour.alpha === 1 ? "" : ` at ${Math.round(colour.alpha * 100)} percent`;
  switch (colour.kind) {
    case "theme":
      return `${THEME_SLOT_LABEL[colour.slot]}${opacity}`;
    case "literal":
      return `${colourValue({ ...colour, alpha: 1 }, theme)}${opacity}`;
    default:
      return assertNever(colour);
  }
}

/** The theme slots in words, as the colour picker names them. */
export const THEME_SLOT_LABEL: Readonly<Record<ThemeColourSlot, string>> = {
  dark1: "Dark 1",
  light1: "Light 1",
  dark2: "Dark 2",
  light2: "Light 2",
  accent1: "Accent 1",
  accent2: "Accent 2",
  accent3: "Accent 3",
  accent4: "Accent 4",
  accent5: "Accent 5",
  accent6: "Accent 6",
  hyperlink: "Link",
  followedHyperlink: "Visited link",
};

/** Slide colours offered besides the theme's (document values, not chrome colours). */
const STANDARD_PALETTE: readonly string[] = ["#000000", "#434343", "#999999", "#ffffff", "#e11d48", "#f97316", "#facc15", "#22c55e", "#06b6d4", "#3b82f6", "#6366f1", "#a855f7"];

/** The text a shared number shows: the number, or empty for "mixed" and "none". */
export function sharedText(value: SharedValue<number>): string {
  switch (value.kind) {
    case "value":
      return String(value.value);
    case "mixed":
    case "none":
      return "";
    default:
      return assertNever(value);
  }
}

function colourLabel(value: SharedValue<Colour>, theme: ThemeSnapshot): string {
  switch (value.kind) {
    case "value": {
      const colour = value.value;
      switch (colour.kind) {
        case "theme":
          return THEME_SLOT_LABEL[colour.slot];
        case "literal":
          return colourValue({ ...colour, alpha: 1 }, theme);
        default:
          return assertNever(colour);
      }
    }
    case "mixed":
      return MIXED_PLACEHOLDER;
    case "none":
      return "None";
    default:
      return assertNever(value);
  }
}

/** Same kind, value and alpha (the state module's recent-colours rule). */
function sameColour(first: Colour, second: Colour): boolean {
  switch (first.kind) {
    case "literal":
      return second.kind === "literal" && first.hexadecimal === second.hexadecimal && first.alpha === second.alpha;
    case "theme":
      return second.kind === "theme" && first.slot === second.slot && first.alpha === second.alpha;
    default:
      return assertNever(first);
  }
}

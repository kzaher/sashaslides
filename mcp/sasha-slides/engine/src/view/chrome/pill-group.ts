// ARROW KEYS IN A ROW OF PILLS (SPEC.md 21.9, review fix 6). Tabs (`role="tablist"`) and segmented
// choices (`role="radiogroup"`) are one Tab stop each, with a roving tab index: the chosen pill is
// focusable, the others are reached with the arrow keys, Home and End, and moving focus also
// chooses, as the WAI-ARIA tabs and radio group patterns describe. The keys are consumed here,
// so they never reach the editor shell, whose arrow keys would otherwise nudge the selected
// element while the person was only switching a properties tab.

import type { KeyboardEvent } from "react";

/** The pills a group's keyboard moves between. */
export const PILL_SELECTOR = "[role='tab'], [role='radio']";
/** A focused element inside one of these keeps its arrow keys (editor-shell.tsx). */
export const PILL_GROUP_SELECTOR = "[role='tablist'], [role='radiogroup']";
/** The keys a pill group owns. */
export const PILL_GROUP_KEYS: ReadonlySet<string> = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"]);

/** Which pill a key moves to, skipping disabled ones and wrapping; null when the key is not a group key. */
export function pillGroupKeyTarget(options: Readonly<{ key: string; current: number; disabled: readonly boolean[] }>): number | null {
  const count = options.disabled.length;
  if (count === 0 || !PILL_GROUP_KEYS.has(options.key)) return null;
  const enabled = (index: number): boolean => options.disabled[index] === false;
  const step = (from: number, direction: 1 | -1): number => {
    for (let offset = 1; offset <= count; offset += 1) {
      const candidate = (((from + direction * offset) % count) + count) % count;
      if (enabled(candidate)) return candidate;
    }
    return options.current;
  };
  switch (options.key) {
    case "ArrowRight":
    case "ArrowDown":
      return step(options.current, 1);
    case "ArrowLeft":
    case "ArrowUp":
      return step(options.current, -1);
    case "Home":
      return step(-1, 1);
    case "End":
      return step(count, -1);
    default:
      return null;
  }
}

/** The group's `onKeyDown`: move focus to the target pill, choose it, and keep the key from the shell. */
export function handlePillGroupKey(event: KeyboardEvent<HTMLElement>, choose: (index: number) => void): void {
  if (!PILL_GROUP_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const pills = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(PILL_SELECTOR));
  const current = pills.findIndex((pill) => pill === event.target || pill.contains(event.target instanceof Node ? event.target : null));
  const target = pillGroupKeyTarget({ key: event.key, current: Math.max(0, current), disabled: pills.map((pill) => pill.hasAttribute("disabled") || pill.getAttribute("aria-disabled") === "true") });
  event.stopPropagation();
  event.preventDefault();
  if (target === null) return;
  pills[target]?.focus();
  if (target !== current) choose(target);
}

/** The roving tab index: the chosen pill (or the first, when none is) is the group's Tab stop. */
export function rovingTabIndex(options: Readonly<{ index: number; chosenIndex: number }>): 0 | -1 {
  const stop = options.chosenIndex < 0 ? 0 : options.chosenIndex;
  return options.index === stop ? 0 : -1;
}

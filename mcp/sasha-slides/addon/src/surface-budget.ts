/**
 * The size budgets of the HtmlService pages build-addon.ts emits, here so the unit tests check
 * the same numbers the build enforces.
 *
 * THE PER-PAGE SIZE BUDGET, and it is evidence, not taste: this repo has recorded HtmlService
 * relaying a ~560 KB inlined bundle back CORRUPTED, as "Uncaught SyntaxError: Invalid or unexpected
 * token" in minified code. 500 KB is the ceiling the surfaces are kept under, with the margin on
 * the safe side of the only failure ever measured. Raising it needs a measurement, not an opinion.
 */
export const SURFACE_BUDGET_BYTES = 500 * 1024;

/**
 * The editor shell only hosts the deck editor's frame (SPEC.md 21.13: "a few kilobytes"); 10 KB
 * keeps it honest. The editor itself is the web application, never bundled into the add-on
 * (SPEC.md 14: it would not fit beside anything).
 */
export const EDITOR_SHELL_BUDGET_BYTES = 10 * 1024;

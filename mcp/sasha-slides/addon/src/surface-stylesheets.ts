// WHICH STYLESHEETS EACH SURFACE RENDERS, in cascade order: one `<style>` per page, these joined.
//
// The order is the cascade and it is load-bearing: base first, then the rules the two wide windows
// share, then the surface's own, then its Tidepool look, which overrides the ones before it.
//
// surface-stylesheets.test.ts bundles each surface and checks these lists against its code: every
// rule a class in that bundle can match is in its sheets, nothing in its sheets is unmatchable, and
// the bundle carries exactly these sheets and no other.

import { BASE_CSS } from "./base-styles.ts";
import { DIALOG_CSS } from "./dialog-styles.ts";
import { REPORT_CSS } from "./report-styles.ts";
import { SIDEBAR_CSS } from "./sidebar-styles.ts";
import { TIDEPOOL_CALM_CSS } from "./tidepool-calm-styles.ts";
import { TIDEPOOL_CSS } from "./tidepool-styles.ts";
import { WINDOW_CSS } from "./window-styles.ts";

/** Dialog.html: the candidate grid, the mark-up view and the editor window, in the calm Tidepool look. */
export const DIALOG_STYLESHEETS: readonly string[] = [BASE_CSS, WINDOW_CSS, DIALOG_CSS, TIDEPOOL_CALM_CSS];

/** Report.html: the defect report. */
export const REPORT_STYLESHEETS: readonly string[] = [BASE_CSS, WINDOW_CSS, REPORT_CSS];

/** Sidebar.html: Ask Sasha, in the Tidepool look. */
export const SIDEBAR_STYLESHEETS: readonly string[] = [BASE_CSS, SIDEBAR_CSS, TIDEPOOL_CSS];

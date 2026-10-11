// THE DEFECT REPORT IN A WINDOW OF ITS OWN -- written once, used by both surfaces.
//
// MEASURED 2026-10-04 against the deployed add-on: Google Slides hosts exactly ONE modeless
// dialog, so showing the report EVICTED the Candidate slides window. Press "Report a defect" and
// the slides you are reporting on disappear and the report takes their frame -- which is what the
// user described as "it reloads the same popup". A web-app deployment is the only separate
// browser window Apps Script can give, and `doGet` serves the same Report document there.
//
// TWO RULES, both of which were got wrong before they were written down:
//
//  1. THE URL IS LEARNED AT STARTUP. `window.open` is blocked unless it runs inside the
//     synchronous call stack of a real user gesture, and an `await` ends that gesture. Asking the
//     server for the URL inside the click handler gets the popup blocked every time.
//  2. IT FALLS BACK. `open()` says whether a window actually appeared -- it did not if the script
//     is not deployed as a web app, or if a popup blocker refused. Both are ordinary, and neither
//     may cost the user their report, so the caller then asks the host for the dialog as before.

import type { PickerWindowApi } from "./drive-api.ts";

/** Just the part of `window` this needs, so a test can hand over a counter instead of a browser. */
export type PopupOpener = Readonly<{
  open: (url: string, target: string, features: string) => unknown;
}>;

export type ReportWindow = Readonly<{
  /** Ask the host for the web-app URL. Call once, at startup, never from a click handler. */
  learn: () => Promise<void>;
  /** Open it, synchronously. False means no window appeared and the dialog is the fallback. */
  open: () => boolean;
}>;

export function createReportWindow(
  options: Readonly<{ api: () => PickerWindowApi | null; opener: PopupOpener }>,
): ReportWindow {
  const { api, opener } = options;
  let url: string | null = null;
  return {
    async learn(): Promise<void> {
      const running = api();
      if (running === null) return;
      const replied = await running.reportWindowUrl();
      url = replied.kind === "ok" ? replied.value : null;
    },
    open(): boolean {
      if (url === null) return false;
      // A NAMED target, so pressing the button twice re-uses the window rather than littering
      // the screen with reports of the same slide.
      return opener.open(url, "sasha-defect-report", "popup=yes,width=1100,height=900") !== null;
    },
  };
}

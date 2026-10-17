// THE "REPORT DEFECT" ENTRY'S SWITCH, and it is OFF.
//
// The button under every candidate in the slides window (`candidate-grid.tsx`) opens the defect
// report window (`report.tsx`), which sends to the report service mounted in the connector at
// https://sashaslides.com/v1/reports (mcp/sasha-slides/reports/report-stack.ts). Until that is
// deployed every send ends as "nothing answered", so the entry is hidden rather than offered.
//
// TO TURN IT ON, after `deploy/publish.sh connector` with `--reports` and SASHA_ADMIN_EMAILS set
// (deploy/DEPLOY.md, "Defect reports"): set this to `true`, rebuild (`npm run build`) and deploy the
// add-on. Nothing else changes -- the window, its Code.gs functions and Report.html ship either way,
// so a deck that still has an old dialog open keeps working.
//
// A source constant rather than a build define because the build configuration (`build-addon.ts`)
// is owned elsewhere; the bundler folds the `false` branch away just the same.

/** Whether the slides window offers "Report defect" under each candidate. */
export const DEFECT_REPORTS_ENABLED: boolean = false;

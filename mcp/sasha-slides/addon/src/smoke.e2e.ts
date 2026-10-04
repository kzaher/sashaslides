// A real-browser smoke test for ALL THREE EMITTED pages, with `google.script.run` stubbed.
//
//   cd mcp/sasha-slides/addon && npx tsx build-addon.ts && node --import tsx src/smoke.e2e.ts
//   (about 12 s; the repo's command budget is 30 s)
//
// THREE SURFACES, THREE TABS, because that is exactly what Apps Script does: Ask Sasha, the slides
// window and the defect-report window are separate HtmlService documents with separate bundles and
// separate `google.script.run` injections, and they share nothing (UI-CONTRACT.md). The test
// therefore loads each in its own tab with its own stub, and the only things that cross between
// them are the things that cross in production: the canned `sashaScanInbox` answer, the event
// files, the candidates' comments, and the recorded report target.
//
// WHAT ONLY THIS CAN CATCH. The unit tests substitute every dependency, so they cannot see whether
// a ~420 KB inline bundle actually parses, whether React mounts, or whether the converter's staging
// iframe and its inline-<script> extractor path survive -- which now also proves the MINIFIED
// extractor still works, since it reaches the page through the same base64 route. This loads the
// files Apps Script would serve, answers the twelve server functions from a canned proposal with a
// canned event log and canned candidate comments, and reports what rendered: the conversation's
// LOG first (it is the one surface the menu opens), then the slides grid and its mark-up view,
// then the report window.
//
// AND THE THINGS ONLY A BROWSER CAN SEE AT ALL, which is why some checks here look like style
// assertions and are not:
//
//   * HOW MANY FRAMES ARE REACHABLE. `sandbox="allow-same-origin"` is granted to exactly one
//     iframe -- the selected candidate's, while the edit tool is live and the HTML pane shows --
//     and a reducer test cannot count attributes on real elements.
//   * THAT THE ANNOTATE TOOL ARRIVES WITHOUT A SCREEN CHANGE. `.sasha-overlay` has to appear on
//     every cell while `.sasha-grid` is still the thing on screen; the old "click a cell to enter
//     the annotation view" shape would pass every unit test and fail this.
//   * THAT BOTH SLIDES OF THE DEFECT PAIR RENDER. Two `EditorPane`s mean two live iframes with two
//     different documents, and "the right-hand one is an anonymisation, not a copy" is a statement
//     about bytes that reached a real `srcdoc`.
//   * THAT THE WAIT IS LIVE. The pinned waiting panel's pulse is a CSS animation precisely so it
//     keeps running when a poll stalls, and the elapsed clock is computed against a real clock.
//
// It serves over http rather than file:// on purpose: the converter reaches into its staging
// iframe's `contentWindow`, and a srcdoc iframe inside a file:// page gets an opaque origin, which
// would fail for a reason the sidebar will never hit in production.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule } from "../../../../types/cdp-types.ts";
import { slideHtml } from "./fake-drive.ts";

// SAFETY: types/ambient.d.ts declares the module's default export as `unknown` because the package
// ships no .d.ts; types/cdp-types.ts is the project's hand-written shape for it, and this is the
// one narrowing point the style guide asks for.
const CDP = CDPraw as unknown as CdpModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const EMITTED = join(REPO_ROOT, "dist", "mcp", "sasha-slides", "addon");
const DIALOG_FILE = join(EMITTED, "Dialog.html");
const SIDEBAR_FILE = join(EMITTED, "Sidebar.html");
const REPORT_FILE = join(EMITTED, "Report.html");
const CDP_PORT = 9222;
const PORT = 7331;
const READY_BUDGET_MS = 15_000;
const POLL_MS = 100;
/** Not submittable, so they go to the temp dir; the final report names the paths. */
const GRID_SHOT = join(tmpdir(), "sasha-grid-smoke.png");
/**
 * THE GRID WITH THE ANNOTATE TOOL ON IT -- the one surface none of the other four shows. The grid
 * shot is taken with the edit tool (the first paint), and the mark-up shot is one slide large, so
 * without this there is no picture of the thing this rework exists for: the drag gesture on every
 * cell at once, with the grid still the grid.
 */
const GRID_ANNOTATE_SHOT = join(tmpdir(), "sasha-grid-annotate-smoke.png");
const MARKUP_SHOT = join(tmpdir(), "sasha-markup-smoke.png");
const CHAT_SHOT = join(tmpdir(), "sasha-conversation-smoke.png");
const REPORT_SHOT = join(tmpdir(), "sasha-defect-report-smoke.png");
/** The dialog's own size, as Code.gs asks for it -- so the grid is measured at the real width. */
const DIALOG_WIDTH = 1000;
const DIALOG_HEIGHT = 760;
/** The report window's own size, as Code.gs asks for it. */
const REPORT_WIDTH = 1100;
const REPORT_HEIGHT = 800;
/** HtmlService gives the user no way to resize a sidebar; this is what it really is. */
const SIDEBAR_WIDTH = 300;

const PROPOSAL_ID = "p_1733219000000_a1b2c3";
const COUNT = 3;
/** The candidate the slides window records for the report window, and the one it comes up on. */
const REPORTED_SLIDE = 2;
/**
 * That candidate's own `<title>` (fake-drive.ts's `slideHtml`). The defect report's title field is
 * the one run the surface exposes as text, so this is the "before" its replacement is judged
 * against -- and the string typed back in to prove the replacement gate has no "the user said so"
 * exemption.
 */
const ORIGINAL_TITLE = `option ${REPORTED_SLIDE}`;
/**
 * The defect report's two text inputs, BY ID.
 *
 * They used to share `.sasha-endpoint`, and this test typed a report endpoint straight into the
 * slide's `<title>` because the selector took the first one -- found in the smoke screenshot. Ids
 * are the one selector two unrelated fields cannot collide on, so both are addressed that way and
 * the surface is checked for the collision as well.
 */
const TITLE_FIELD_ID = "sasha-report-title";
const ENDPOINT_FIELD_ID = "sasha-report-endpoint";

async function main(): Promise<void> {
  const server = await listen({
    "/dialog.html": stubbed(DIALOG_FILE),
    "/sidebar.html": stubbed(SIDEBAR_FILE),
    "/report.html": stubbed(REPORT_FILE),
  });
  const failures: string[] = [];
  try {
    // THE CONVERSATION FIRST, because it is the one thing the menu opens.
    await driveSidebar({ failures });
    await driveDialog({ failures });
    await driveReport({ failures });
  } finally {
    // closeAllConnections first: Chrome holds the keep-alive socket open, and `server.close()`
    // alone waits for it forever -- which looked exactly like a hung smoke test.
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }

  if (failures.length > 0) {
    process.stderr.write(`\nsmoke FAILED:\n  ${failures.join("\n  ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nsmoke ok\n");
}

/**
 * SURFACE 2: the modeless candidates window -- the grid, the toolbar's three independent choices,
 * the annotate tool arriving on every cell without a screen change, one slide large, the real
 * converter, and the pre-insert review path that puts a mark-up on the candidate's own file.
 */
async function driveDialog({ failures }: { failures: string[] }): Promise<void> {
  const tab = await CDP.New({ port: CDP_PORT, url: `http://127.0.0.1:${PORT}/dialog.html` });
  let client: CdpClient | null = null;
  try {
    client = await CDP({ target: tab, port: CDP_PORT });
    const { Runtime, Page } = client;
    await Page.enable();
    await Runtime.enable();
    const errors: string[] = [];
    client.on("Runtime.exceptionThrown", (params: unknown) => {
      const described = JSON.stringify(params).slice(0, 400);
      errors.push(described);
      // Printed AS IT HAPPENS, not only in the summary: a bundle that throws on first paint fails
      // every check below it, and reading twenty FAILs before the cause is the wrong order.
      process.stdout.write(`      uncaught: ${described}\n`);
    });
    // The real dialog's size, so the grid's measured scale is the one the user gets.
    await client.Emulation.setDeviceMetricsOverride({
      width: DIALOG_WIDTH,
      height: DIALOG_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const dialog = await pollFor({ client, expression: "!!document.querySelector('.sasha-dialog')" });
    check({ failures, what: "the candidates dialog mounted", ok: dialog });

    const grid = await pollFor({ client, expression: "!!document.querySelector('.sasha-grid')" });
    check({ failures, what: "the grid is the first surface", ok: grid });

    const cells = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-cell').length" });
    check({ failures, what: `${COUNT} cells, one per candidate`, ok: cells === COUNT, detail: `saw ${cells}` });

    // EXACTLY ONE SCROLLBAR IN THE WINDOW, and it belongs to the grid. The shell growing past
    // 100vh put a second one outside it and pushed the last row's caption below the fold.
    const bodyOverflow = await evaluateNumber({
      client,
      expression: "document.documentElement.scrollHeight - document.documentElement.clientHeight",
    });
    check({
      failures,
      what: "the window itself does not scroll -- only the grid does",
      ok: bodyOverflow <= 0,
      detail: `${bodyOverflow}px of overflow`,
    });

    // All N cells, including the last row's FOOTER, visible without scrolling the grid.
    //
    // "FOUR SLIDES AT ONCE IS THE REQUIREMENT, not a nice-to-have ... two rows of them fit without
    // scrolling, so a four-candidate proposal is comparable in one glance" (candidate-grid.tsx).
    // Three candidates are two rows, so this is the same claim with one cell to spare.
    //
    // THE DETAIL IS THE WHOLE VERTICAL BUDGET, not just "2 of 3": the grid is `flex: 1 1 auto`
    // inside a 100vh shell, so whether it fits is decided by what its SIBLINGS take -- the header,
    // the toolbar, the tool panel, the report bar and the actions -- and by the footer each cell
    // grew. A bare count sends the reader hunting for which of the six it was.
    const gridFit = await evaluateString({
      client,
      expression: `(function(){
        var grid = document.querySelector('.sasha-grid');
        var dialog = document.querySelector('.sasha-dialog');
        var cells = [].slice.call(document.querySelectorAll('.sasha-cell'));
        if (!grid || !dialog || cells.length === 0) return '';
        var box = grid.getBoundingClientRect();
        var fit = cells.filter(function (cell) {
          var at = cell.getBoundingClientRect();
          return at.bottom <= box.bottom + 1 && at.top >= box.top - 1;
        }).length;
        var first = cells[0].getBoundingClientRect();
        var last = cells[cells.length - 1].getBoundingClientRect();
        var foot = last.height - cells[cells.length - 1].querySelector('.sasha-cell-stage').getBoundingClientRect().height;
        return JSON.stringify({
          fit: fit,
          cells: cells.length,
          gridHeight: Math.round(box.height),
          // MEASURED OFF THE CELLS THEMSELVES, not off \`grid.scrollHeight\`: an element that is not
          // overflowing reports its CLIENT height as its scroll height, so the moment this check
          // passes that number stops describing the content and starts echoing the box.
          cellsNeed: Math.round(last.bottom - first.top),
          // WHAT IS LEFT UNDER THE LAST ROW. Negative is the overshoot; a small positive number is
          // a warning in a PASSING run, which is the point of printing it when it is fine.
          spare: Math.round(box.bottom - last.bottom),
          cellHeight: Math.round(last.height),
          footHeight: Math.round(foot),
          chrome: [].slice.call(dialog.children)
            .filter(function (child) { return child !== grid; })
            .map(function (child) {
              return child.className.split(' ')[0].replace('sasha-', '') +
                ':' + Math.round(child.getBoundingClientRect().height);
            })
            .join(' ')
        });
      })()`,
    });
    check({
      failures,
      what: `all ${COUNT} cells fit without scrolling the grid`,
      ok: readCount({ json: gridFit, field: "fit" }) === COUNT,
      detail: gridFit,
    });

    const columns = await evaluateString({
      client,
      expression: "getComputedStyle(document.querySelector('.sasha-grid')).gridTemplateColumns",
    });
    check({
      failures,
      what: "two columns, rows as needed",
      ok: columns.split(" ").length === 2,
      detail: columns,
    });

    const allLoaded = await pollFor({
      client,
      expression: `document.querySelectorAll('iframe.sasha-frame').length === ${COUNT}`,
    });
    const iframe = await evaluateNumber({ client, expression: "document.querySelectorAll('iframe.sasha-frame').length" });
    check({
      failures,
      what: "every cell renders the candidate's own HTML in an iframe",
      ok: allLoaded,
      detail: `saw ${iframe}`,
    });

    // The scale is MEASURED, not the unmeasured 0.214 fallback -- i.e. the ResizeObserver path ran.
    const scale = await evaluateString({
      client,
      expression:
        "(function(){var f=document.querySelector('iframe.sasha-frame');return f?f.style.transform:'';})()",
    });
    const measured = Number(/scale\(([\d.]+)\)/.exec(scale)?.[1] ?? "0");
    check({
      failures,
      what: "the cell measured itself rather than falling back to the sidebar constant",
      ok: measured > 0.25 && measured < 0.6,
      detail: scale,
    });

    // --- THE TOOLBAR IS THREE INDEPENDENT CHOICES, NOT ONE MODE ----------------------------
    // The window used to hold ONE `surface` enum, so a user had to click a cell to ENTER a screen
    // before annotation became possible. View, tool and showing are now separate fields, and the
    // first thing to prove is that all three are offered side by side rather than as one four-way
    // mode (Picker.tsx).
    const groups = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-toolbar .sasha-toggle')].map(function(group){" +
        "return [(group.querySelector('.sasha-toggle-label')||{}).textContent," +
        "[...group.querySelectorAll('button')].map(function(button){return button.textContent;})];}))",
    });
    check({
      failures,
      what: "the toolbar offers view, tool and showing as three independent choices",
      ok:
        groups ===
        JSON.stringify([
          ["view", ["All candidates", "One slide"]],
          ["tool", ["Edit", "Annotate"]],
          ["showing", ["HTML (authoritative)", "Converted slide"]],
        ]),
      detail: groups,
    });

    const chosen = await choicesOf({ client });
    check({
      failures,
      what: "and the first paint is the grid, with the EDIT tool live and the HTML pane showing",
      ok: chosen === "All candidates/Edit/HTML (authoritative)",
      detail: chosen,
    });

    // --- EXACTLY ONE FRAME IS REACHABLE ----------------------------------------------------
    // `sandbox="allow-same-origin"` goes to the selected candidate's frame and to nothing else,
    // while the edit tool is live and the HTML pane shows (slide-stage.tsx). Staged HTML of unknown
    // provenance is rendered inside the user's logged-in Google session, so this is the one
    // security-relevant attribute on the surface -- and counting it needs real elements.
    const sandboxes = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('iframe.sasha-frame')].map(f=>f.getAttribute('sandbox')))",
    });
    check({
      failures,
      what: "the edited candidate's frame is reachable and the other cells keep the strictest sandbox",
      ok: occurrences({ haystack: sandboxes, needle: "allow-same-origin" }) === 1,
      detail: sandboxes,
    });

    // AND IT FOLLOWS THE SELECTION. The cell's chip selects; the frames are keyed, so React has to
    // remount both of them on the switch. Without the key the grant and the host's frame reference
    // both went stale -- a grid where the editor drew its chrome over one slide and wrote to
    // another, which no reducer test can see.
    await click({ client, selector: '[aria-label="work on candidate 2"]' });
    const followed = await pollFor({
      client,
      expression:
        "(function(){var cells=[...document.querySelectorAll('.sasha-cell')];" +
        "var reachable=cells.map(function(cell){var f=cell.querySelector('iframe.sasha-frame');" +
        "return f !== null && (f.getAttribute('sandbox')||'').indexOf('allow-same-origin') >= 0;});" +
        "return reachable.filter(Boolean).length === 1 && reachable[1] === true;})()",
    });
    const reachable = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-cell iframe.sasha-frame')].map(f=>f.getAttribute('sandbox')))",
    });
    check({
      failures,
      what: "and it FOLLOWS the selection -- still exactly one, now candidate 2's",
      ok: followed,
      detail: reachable,
    });

    // --- THE EDIT TOOL'S OWN PANEL ---------------------------------------------------------
    const slot = await pollFor({ client, expression: "!!document.querySelector('.sasha-editor')" });
    check({ failures, what: "the visual editor's slot is there, from the first paint", ok: slot });

    const slotHead = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-editor strong')||{}).textContent||''",
    });
    check({
      failures,
      what: "and the panel below the slides is the editor's, because the edit tool is the live one",
      ok: slotHead === "Visual edits",
      detail: slotHead,
    });

    // AN ATTACHED EDITOR SAYS NOTHING ABOUT WHY IT IS NOT ATTACHED. `describeEditorReach` is for the
    // arms where clicking the slide does nothing; printing it over a live editor put two sentences
    // of instruction on top of the thing the user is looking at (editor-slot.tsx).
    const liveComplaint = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-editor .sasha-trouble')||{}).textContent||''",
    });
    check({
      failures,
      what: "and it does not explain itself while it is live",
      ok: liveComplaint === "",
      detail: liveComplaint.slice(0, 120),
    });

    await client.Page.captureScreenshot({ format: "png" }).then((shot) =>
      writeFileSync(GRID_SHOT, Buffer.from(shot.data, "base64")),
    );
    process.stdout.write(`      grid screenshot: ${GRID_SHOT}\n`);

    // --- THE ANNOTATE TOOL ARRIVES IN THE GRID, WITH NO SCREEN TO ENTER --------------------
    // This is the whole correction, and it is only visible in a browser: choosing the tool has to
    // put the drag surface on EVERY cell while `.sasha-grid` is still the thing on screen. The old
    // shape -- click a cell, land in `.sasha-annotate`, get one overlay -- would satisfy every
    // reducer test and fail here.
    await chooseIn({ client, group: "tool", label: "Annotate" });
    const allDraggable = await pollFor({
      client,
      expression: `document.querySelectorAll('.sasha-grid .sasha-cell-stage .sasha-overlay').length === ${COUNT}`,
    });
    const overlays = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-overlay').length" });
    check({
      failures,
      what: `choosing the annotate tool puts a drag surface on all ${COUNT} cells`,
      ok: allDraggable,
      detail: `saw ${overlays}`,
    });

    const stillGrid = await choicesOf({ client });
    check({
      failures,
      what: "and it changed nothing else -- the grid is still the grid, the pane still the HTML",
      ok: stillGrid === "All candidates/Annotate/HTML (authoritative)",
      detail: stillGrid,
    });

    // THE TWO TOOLS CANNOT BOTH HAVE THE POINTER. `.sasha-marks` is the edit tool's inert copy of
    // the same boxes, and a transparent overlay above the editor's chrome would swallow every one
    // of its gestures -- so exactly one of the two is on the stages at a time (slide-stage.tsx).
    const inertMarks = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-marks').length" });
    check({
      failures,
      what: "the edit tool's inert marks gave the pointer up to the gesture",
      ok: inertMarks === 0,
      detail: `saw ${inertMarks}`,
    });

    const stillReachable = await evaluateNumber({
      client,
      expression:
        "[...document.querySelectorAll('iframe.sasha-frame')]" +
        ".filter(f=>(f.getAttribute('sandbox')||'').indexOf('allow-same-origin')>=0).length",
    });
    check({
      failures,
      what: "and no frame stays reachable once the editor is not the tool",
      ok: stillReachable === 0,
      detail: `saw ${stillReachable}`,
    });

    const anomalyPanel = await pollFor({ client, expression: "!!document.querySelector('.sasha-anomalies')" });
    check({ failures, what: "the tool panel is the mark-up list now, not the editor's", ok: anomalyPanel });

    await client.Page.captureScreenshot({ format: "png" }).then((shot) =>
      writeFileSync(GRID_ANNOTATE_SHOT, Buffer.from(shot.data, "base64")),
    );
    process.stdout.write(`      annotated grid screenshot: ${GRID_ANNOTATE_SHOT}\n`);

    // --- AND THE GESTURE REALLY WORKS AT GRID ZOOM ------------------------------------------
    // WAIT FOR THE CELL TO HAVE ITS REAL HEIGHT before dragging. While the candidate's HTML is
    // still being fetched the stage holds a one-line placeholder, so the overlay is a few pixels
    // tall and a 20%-to-70% drag collapses to a box `regionOfDrag` refuses as too small -- which
    // reads as "dragging does not work" and is really "there was nothing to drag on yet".
    const cellDragReady = await pollFor({
      client,
      expression:
        "(function(){var o=document.querySelector('.sasha-cell-stage .sasha-overlay');" +
        "return !!o && o.getBoundingClientRect().height > 100;})()",
    });
    check({ failures, what: "a cell has its real height before the gesture", ok: cellDragReady });

    await drag({
      client,
      selector: ".sasha-cell-stage .sasha-overlay",
      until: "document.querySelectorAll('.sasha-mark-user').length > 0",
    });
    const marked = await pollFor({ client, expression: "document.querySelectorAll('.sasha-mark-user').length > 0" });
    check({ failures, what: "dragging on a candidate IN THE GRID reported an anomaly", ok: marked });

    const stayedInGrid = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-grid').length" });
    check({
      failures,
      what: "and the gesture did not navigate anywhere to do it",
      ok: stayedInGrid === 1,
      detail: `saw ${stayedInGrid} grids`,
    });

    // --- THE UNRESOLVED COUNTS, ON THE CELLS -----------------------------------------------
    // The grid and the conversation read the SAME candidate comments. Slide 2 has one open thread
    // in the stub, and slide 3's file is one Drive refuses -- so its badge must say "could not be
    // read" rather than "no open comments" (UI-CONTRACT.md).
    const badges = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-cell-unresolved').length >= 2",
    });
    const hints = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('.sasha-cell-hint')].map(e=>e.textContent))",
    });
    process.stdout.write(`      cell hints: ${hints}\n`);
    check({ failures, what: "the cells carry their unresolved comment counts", ok: badges });

    const readBadges = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-cell-unresolved')].map(e=>[e.className,e.textContent]))",
    });
    check({
      failures,
      what: "an open count is a number, and a candidate Drive refused shows ! rather than zero",
      ok: /sasha-unresolved-known/.test(readBadges) && /sasha-unresolved-unreachable/.test(readBadges),
      detail: readBadges,
    });

    // THE CELL SAYS WHAT IT IS WAITING FOR. A box just dragged on cell 1 is not sent yet, which
    // outranks its load state on the one line the cell has (candidate-grid.tsx `hintFor`).
    const firstHint = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-cell .sasha-cell-hint')||{}).textContent||''",
    });
    check({
      failures,
      what: "and the marked cell says its mark-up has not been sent",
      ok: /marked, not sent/.test(firstHint),
      detail: firstHint,
    });

    // --- REVIEW IS PRE-INSERT: A MARK-UP GOES TO THE CANDIDATE -------------------------------
    const blockedSend = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-send-anomaly[disabled]').length",
    });
    check({
      failures,
      what: "a mark-up with no words cannot be sent -- an empty comment says nothing",
      ok: blockedSend > 0,
      detail: `${blockedSend} disabled`,
    });

    await typeInto({ client, selector: ".sasha-anomaly .sasha-note", text: "the gridlines are gone" });
    await click({ client, selector: ".sasha-send-anomaly" });
    const onCandidate = await pollFor({ client, expression: "!!(window.__SASHA_FILE_COMMENTS__||{}).html_1" });
    check({ failures, what: "Send to Sasha posted the comment on the CANDIDATE, not on the deck", ok: onCandidate });

    // The comment's BODY, not a JSON wrapper around it: stringifying the record escapes every
    // quote, so `"region":{"x"` would not appear in it and the assertion would be vacuous.
    const candidateComment = await evaluateString({
      client,
      expression: "(((window.__SASHA_FILE_COMMENTS__||{}).html_1||[{}])[0]||{}).content||''",
    });
    check({
      failures,
      what: "and it carries the words and the 0-1 region",
      ok: /the gridlines are gone/.test(candidateComment) && /"region":\{"x":0\./.test(candidateComment),
      detail: candidateComment.slice(0, 220),
    });

    const logged = await pollFor({
      client,
      expression: "[...(window.__SASHA_EVENTS__||[])].some(e=>/comment-opened/.test(e.name))",
    });
    check({ failures, what: "and it appended a comment-opened event to the session log", ok: logged });

    // THE COUNT MOVES ON THE CELL THAT WAS MARKED, and on that one specifically: cell 2 carried a
    // `known` badge from the first paint, so "some cell has one" would pass without the send ever
    // having happened.
    const movedCount = await pollFor({
      client,
      expression:
        "!!document.querySelector('.sasha-cell:first-child .sasha-cell-unresolved.sasha-unresolved-known')",
    });
    const movedTo = await evaluateString({
      client,
      expression:
        "(document.querySelector('.sasha-cell:first-child .sasha-cell-unresolved')||{}).className||'no badge'",
    });
    check({
      failures,
      what: "the unresolved count moved ON THE MARKED CELL without waiting for a poll",
      ok: movedCount,
      detail: movedTo,
    });

    // --- ONE SLIDE, LARGE: A ZOOM LEVEL AND NOT A SCREEN ------------------------------------
    // The cell's picture hosts the gesture now, so it cannot also be a navigation target: "Show
    // large" is a NAMED control in the footer (candidate-grid.tsx). It must change the zoom level
    // and nothing else -- in particular not the tool it was holding.
    await click({ client, selector: ".sasha-cell .sasha-zoom" });
    const zoomed = await pollFor({
      client,
      expression: "!!document.querySelector('.sasha-single .sasha-pane.sasha-pane-big')",
    });
    check({ failures, what: '"Show large" zooms to one slide', ok: zoomed });

    const afterZoom = await choicesOf({ client });
    check({
      failures,
      what: "and the tool it was holding is untouched -- a zoom level is not a mode",
      ok: afterZoom === "One slide/Annotate/HTML (authoritative)",
      detail: afterZoom,
    });

    const bigOverlay = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-pane-big .sasha-overlay').length",
    });
    const anyOverlay = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-overlay').length" });
    check({
      failures,
      what: "the shared drag surface is on the big pane",
      ok: bigOverlay === 1 && anyOverlay === 1,
      detail: `${bigOverlay} on the pane, ${anyOverlay} in the window`,
    });

    const paneDragReady = await pollFor({
      client,
      expression:
        "(function(){var o=document.querySelector('.sasha-pane-big .sasha-overlay');" +
        "return !!o && o.getBoundingClientRect().height > 100;})()",
    });
    check({ failures, what: "the mark-up pane has its real height before the gesture", ok: paneDragReady });

    await drag({
      client,
      selector: ".sasha-pane-big .sasha-overlay",
      until: "document.querySelectorAll('.sasha-anomaly').length > 1",
    });
    const markedTwice = await pollFor({ client, expression: "document.querySelectorAll('.sasha-anomaly').length > 1" });
    check({ failures, what: "and the same gesture works on it, at the other zoom level", ok: markedTwice });

    // THE LAST ROW IS FULLY INSIDE ITS SCROLLER. A mark-up row is two lines, and the list's
    // max-height was sized for one -- which sliced the second row's coordinates through the middle
    // of the glyphs with only two mark-ups on screen (seen in the browser smoke screenshot).
    const rowsFit = await evaluateNumber({
      client,
      expression:
        "(function(){var list=document.querySelector('.sasha-anomalies');" +
        "var rows=[].slice.call(document.querySelectorAll('.sasha-anomaly'));" +
        "if(!list||rows.length===0)return -1;var box=list.getBoundingClientRect();" +
        "var last=rows[rows.length-1].getBoundingClientRect();" +
        "return last.bottom <= box.bottom + 1 ? rows.length : 0;})()",
    });
    check({
      failures,
      what: "every mark-up row fits inside its list without being sliced",
      ok: rowsFit > 1,
      detail: `${rowsFit} rows`,
    });

    await client.Page.captureScreenshot({ format: "png" }).then((shot) =>
      writeFileSync(MARKUP_SHOT, Buffer.from(shot.data, "base64")),
    );
    process.stdout.write(`      mark-up screenshot: ${MARKUP_SHOT}\n`);

    await click({ client, selector: ".sasha-backbar .sasha-secondary" });
    const back = await pollFor({ client, expression: "!!document.querySelector('.sasha-grid')" });
    check({ failures, what: "and there is a way back to the grid", ok: back });

    // --- THE CONVERTED PANE -----------------------------------------------------------------
    // The rendered pane only exists once the REAL converter has run in the page: choose it in the
    // SHOWING group and wait for a preview box. This is the end-to-end proof that the extractor
    // survived base64 + HtmlService-shaped inlining and ran under a no-eval CSP.
    //
    // The group matters. "One slide" and "Converted slide" both say "slide", so the old
    // text-matching click took the view button and silently never converted anything.
    await chooseIn({ client, group: "showing", label: "Converted slide" });
    const converted = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-rendered .sasha-el').length > 0",
    });
    check({ failures, what: "the converter produced preview elements", ok: converted });

    const boxes = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-rendered .sasha-el').length" });
    const heading = await evaluateString({ client, expression: "(document.querySelector('.sasha-header')||{}).textContent||''" });
    process.stdout.write(`      header: ${JSON.stringify(heading)}\n      preview boxes: ${boxes}\n`);

    // EVERY CELL IS THE SAME KIND OF THING. The showing choice belongs to the WINDOW, not to a
    // stage: comparing one candidate's HTML against another's conversion would compare two
    // different kinds of thing (slide-stage.tsx), so all N must have switched together.
    const allConverted = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-cell-stage .sasha-rendered').length",
    });
    const leftoverFrames = await evaluateNumber({ client, expression: "document.querySelectorAll('iframe.sasha-frame').length" });
    check({
      failures,
      what: `all ${COUNT} cells show the conversion, and none is still showing HTML`,
      ok: allConverted === COUNT && leftoverFrames === 0,
      detail: `${allConverted} converted, ${leftoverFrames} frames left`,
    });

    // --- THE FOURTH COMBINATION: THE EDIT TOOL OVER THE CONVERTED PANE ----------------------
    // All four tool/showing pairs are legal and reachable, which is the point of two independent
    // choosers -- and this is the one where the editor CANNOT work: an edit edits the HTML, never
    // the conversion. So the slot has to say so rather than sit there as a grey box.
    await chooseIn({ client, group: "tool", label: "Edit" });
    const refusedReach = await pollFor({
      client,
      expression: "!!document.querySelector('.sasha-editor .sasha-trouble')",
    });
    const reachSaid = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-editor .sasha-trouble')||{}).textContent||''",
    });
    check({
      failures,
      what: "the editor over the CONVERTED pane says why it cannot work, instead of sitting empty",
      ok: refusedReach && /HTML/.test(reachSaid),
      detail: reachSaid.slice(0, 140),
    });

    const noneReachable = await evaluateNumber({
      client,
      expression:
        "[...document.querySelectorAll('iframe.sasha-frame')]" +
        ".filter(f=>(f.getAttribute('sandbox')||'').indexOf('allow-same-origin')>=0).length",
    });
    check({
      failures,
      what: "and nothing is granted same-origin for an editor that is not attached",
      ok: noneReachable === 0,
      detail: `saw ${noneReachable}`,
    });

    await chooseIn({ client, group: "showing", label: "HTML (authoritative)" });
    await pollFor({ client, expression: `document.querySelectorAll('iframe.sasha-frame').length === ${COUNT}` });

    // --- THE DEFECT REPORT IS A WINDOW OF ITS OWN -------------------------------------------
    // THE ENTRY LIVES IN THE FOOTER ROW, and it is the ONLY route to the defect window from this
    // surface -- so it must not be possible to lose it silently. It used to be a `.sasha-reportbar`
    // of its own, which cost a 22px row plus its gap out of the grid's budget; the sentence it
    // carried is on the button's `title` now (Picker.tsx `ReportButton`).
    //
    // BY TEXT AND NOT BY CLASS: `.sasha-actions` holds three `.sasha-secondary`-ish buttons
    // (report, Dismiss, Insert), so a class selector here would press whichever came first.
    const reportEntry = await evaluateNumber({
      client,
      expression:
        "[...document.querySelectorAll('.sasha-actions button')]" +
        ".filter(b=>(b.textContent||'').indexOf('Report a defect in option') === 0).length",
    });
    check({
      failures,
      what: "the footer row carries the one route to the defect window, at either zoom level",
      ok: reportEntry === 1,
      detail: `${reportEntry} report buttons in the footer`,
    });

    await clickLabelled({ client, within: ".sasha-actions", startsWith: "Report a defect in option" });
    const askedForReport = await pollFor({ client, expression: "!!window.__SASHA_REPORT_TARGET__" });
    check({ failures, what: "it asks the HOST for the report window, naming the candidate", ok: askedForReport });

    const recorded = await evaluateString({
      client,
      expression: "JSON.stringify(window.__SASHA_REPORT_TARGET__||{})",
    });
    check({
      failures,
      what: "the target is RECORDED on the server, because the documents share nothing",
      ok: /"slideIndex":1/.test(recorded) && recorded.includes(PROPOSAL_ID),
      detail: recorded,
    });

    // AND THE REPORT IS NOT A MODE OF THIS WINDOW. `.sasha-pair` is the defect report's two slides
    // (Defect.tsx); the run table it replaced is gone from both surfaces, so the thing worth
    // asserting here is that the SURFACE THAT EXISTS does not render in this document.
    const noReportHere = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-pair, .sasha-report, .sasha-runs').length",
    });
    check({
      failures,
      what: "and the report does NOT render inside the slides window any more",
      ok: noReportHere === 0,
      detail: `saw ${noReportHere} report surfaces`,
    });

    for (const error of errors) failures.push(`dialog uncaught: ${error}`);
  } finally {
    if (client !== null) await client.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
  }
}

/**
 * SURFACE 1: ASK SASHA -- the conversation, in its OWN tab with its own stub, which is the honest
 * model of production where it is a different document with a different bundle. It can see the
 * staged proposal only because `sashaScanInbox` tells it so; there is no channel to the others.
 */
async function driveSidebar({ failures }: { failures: string[] }): Promise<void> {
  const tab = await CDP.New({ port: CDP_PORT, url: `http://127.0.0.1:${PORT}/sidebar.html` });
  let client: CdpClient | null = null;
  try {
    client = await CDP({ target: tab, port: CDP_PORT });
    const { Runtime, Page } = client;
    await Page.enable();
    await Runtime.enable();
    const errors: string[] = [];
    client.on("Runtime.exceptionThrown", (params: unknown) => {
      const described = JSON.stringify(params).slice(0, 400);
      errors.push(described);
      process.stdout.write(`      uncaught: ${described}\n`);
    });
    await client.Emulation.setDeviceMetricsOverride({
      width: SIDEBAR_WIDTH,
      height: 1400,
      deviceScaleFactor: 2,
      mobile: false,
    });

    const chat = await pollFor({ client, expression: "!!document.querySelector('.sasha-chat')" });
    check({ failures, what: "Ask Sasha mounted in the sidebar", ok: chat });

    const noCandidates = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-cell').length" });
    check({
      failures,
      what: "and the candidate grid is NOT in it",
      ok: noCandidates === 0,
      detail: `saw ${noCandidates} cells`,
    });

    // THE DIALOG OPENS BY ITSELF WHEN SLIDES ARRIVE. No click: the scan finds the staged proposal
    // and the conversation asks the host for the window once.
    const autoOpened = await pollFor({ client, expression: "window.__SASHA_OPENED__ === true" });
    check({ failures, what: "the slides window opens by itself when slides arrive", ok: autoOpened });

    const openedOnce = await evaluateNumber({ client, expression: "window.__SASHA_OPEN_COUNT__ || 0" });
    check({
      failures,
      what: "exactly once -- a user who closes it is not dragged back in on the next poll",
      ok: openedOnce === 1,
      detail: `asked ${openedOnce} times`,
    });

    const button = await pollFor({
      client,
      expression:
        "[...document.querySelectorAll('button')].some(e=>/See the slides/.test(e.textContent||'')&&!e.disabled)",
    });
    check({ failures, what: "and the button to reopen them stays live -- the only way back", ok: button });

    // --- THE LOG ---------------------------------------------------------------------------
    const log = await pollFor({ client, expression: "document.querySelectorAll('.sasha-msgs .sasha-msg').length >= 6" });
    check({ failures, what: "the session log rendered, in order", ok: log });

    // THE HEADER AND THE "See the slides" BOX ARE STILL THERE. The inline slide is an absolutely
    // positioned 1280x720 frame, and without its 16:9 stage it escapes to the top of the document
    // and covers them -- which is exactly what the first smoke screenshot showed.
    const header = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-chat .sasha-header')||{}).textContent||''",
    });
    check({
      failures,
      what: "the header survives the inline slide (which is absolutely positioned)",
      ok: /Ask Sasha/.test(header),
      detail: header.slice(0, 80),
    });
    const inlineContained = await evaluateNumber({
      client,
      expression:
        "(function(){var f=document.querySelector('.sasha-inline-slide iframe');var s=document.querySelector('.sasha-chat');" +
        "if(!f||!s)return -1;var a=f.getBoundingClientRect(),b=s.getBoundingClientRect();" +
        "return (a.top >= b.top - 1 && a.left >= b.left - 1) ? 1 : 0;})()",
    });
    check({
      failures,
      what: "and the inline slide stays inside the conversation rather than escaping to the page",
      ok: inlineContained === 1,
      detail: `${inlineContained}`,
    });

    const lines = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('.sasha-msgs .sasha-msg')].map(e=>e.className))",
    });
    check({
      failures,
      what: "a comment you opened is part of YOUR turn, Sasha's answer is hers, the deck's is its own",
      ok: /sasha-msg-user/.test(lines) && /sasha-msg-sasha/.test(lines) && /sasha-msg-deck/.test(lines),
      detail: lines,
    });

    const opaque = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-msg-opaque')||{}).textContent||''",
    });
    check({
      failures,
      what: "AN UNKNOWN EVENT KIND IS AN OPAQUE LINE, never a dropped one",
      ok: /cannot read/.test(opaque) && /teleported-slide/.test(opaque),
      detail: opaque.slice(0, 160),
    });

    // --- THE REVISED SLIDE, INLINE ---------------------------------------------------------
    const inline = await pollFor({ client, expression: "!!document.querySelector('.sasha-inline-slide iframe')" });
    check({ failures, what: "a revised slide renders INLINE at the point in the log where it happened", ok: inline });

    const inlineCaption = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-inline-slide figcaption')||{}).textContent||''",
    });
    check({
      failures,
      what: "and it says which slide it is, as it is NOW",
      ok: /slide 2 as it is now/.test(inlineCaption),
      detail: inlineCaption,
    });

    // --- THE UNRESOLVED COUNTS, AND THE PINNED OPEN COMMENTS -------------------------------
    const counted = await pollFor({ client, expression: "!!document.querySelector('.sasha-unresolved-known')" });
    check({ failures, what: "the unresolved count is beside the slide's events", ok: counted });

    // Slide 3's own comments are the ones Drive refuses, so its line must say so rather than 0.
    const cannotCount = await pollFor({
      client,
      expression: "/open comments could not be read/.test(document.body.textContent||'')",
    });
    check({ failures, what: "and a count it cannot reach says so, never zero", ok: cannotCount });

    const unreachable = await pollFor({ client, expression: "!!document.querySelector('.sasha-open-comments')" });
    check({ failures, what: "open comments are PINNED out of the scrolling log", ok: unreachable });

    const pinned = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-open-comments')||{}).textContent||''",
    });
    check({
      failures,
      what: "and each one names its slide and quotes what was said",
      ok: /slide 2/.test(pinned) && /the gridlines are gone/.test(pinned),
      detail: pinned.slice(0, 200),
    });

    // --- THE WAIT IS LIVE, AND HONEST ABOUT WHAT IT CANNOT KNOW ----------------------------
    // The pinned section is no longer a static list: it is the waiting panel (waiting.ts). Three
    // of its four parts can only be seen in a browser -- a CSS animation that keeps running when a
    // poll stalls, an elapsed time computed against a real clock, and the whole sentence being on
    // screen rather than clipped.
    const pulse = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-open-comments .sasha-pulse:not(.sasha-pulse-off)').length",
    });
    check({
      failures,
      what: "the wait carries a LIVE indicator, not a static line",
      ok: pulse === 1,
      detail: `saw ${pulse}`,
    });

    // A CSS ANIMATION AND NOT A CHARACTER THAT CHANGES. A spinner built out of re-renders stops the
    // moment a poll stalls -- exactly when the user most needs to see the wait is still running --
    // so the keyframes running in the real cascade is the thing worth asserting.
    const breathing = await evaluateString({
      client,
      expression:
        "(function(){var p=document.querySelector('.sasha-pulse');return p?getComputedStyle(p).animationName:'';})()",
    });
    check({
      failures,
      what: "and it breathes from the stylesheet, so a stalled poll cannot stop it",
      ok: breathing === "sasha-breathe",
      detail: breathing,
    });

    const headline = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-waiting-head')||{}).textContent||''",
    });
    check({
      failures,
      what: "the headline counts what is waiting and how long the oldest has been",
      ok: /waiting for Sasha/.test(headline) && /the oldest for /.test(headline),
      detail: headline,
    });

    const clocks = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('.sasha-wait-clock')].map(e=>e.textContent))",
    });
    check({
      failures,
      what: "and every row carries its own elapsed clock",
      ok: /waiting \d/.test(clocks),
      detail: clocks,
    });

    // THE PRECONDITION, IN FULL AND NOT CLIPPED. The panel's whole reason for existing: Sasha
    // answers only while a session is attached, this add-on cannot see whether one is, and a user
    // with none attached is waiting on nobody.
    const precondition = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-precondition')||{}).textContent||''",
    });
    check({
      failures,
      what: "the precondition is stated, because an unattached session means no answer is coming",
      ok: precondition.startsWith(
        "Sasha answers only while a Claude session has the sasha-slides connector attached",
      ),
      detail: precondition.slice(0, 110),
    });

    const presence = await evaluateNumber({
      client,
      expression: "/Sasha last did something here |Sasha has never answered/.test(document.body.textContent||'')?1:0",
    });
    check({
      failures,
      what: "and so is the last moment Sasha provably did anything",
      ok: presence === 1,
    });

    // THE OLD LIE, GONE. "no answer yet" implies one is on its way; for a user with no session
    // attached, none ever is. It must not exist anywhere on this surface.
    const promised = await evaluateNumber({
      client,
      expression: "/no answer yet/.test(document.body.textContent||'')?1:0",
    });
    check({
      failures,
      what: 'nothing says "no answer yet" -- no answer may ever come',
      ok: promised === 0,
    });

    // --- THE COMPOSER ----------------------------------------------------------------------
    await typeInto({ client, selector: ".sasha-comment-text", text: "make the agenda slide bluer" });
    await click({ client, selector: ".sasha-composer .sasha-primary" });
    const sent = await pollFor({ client, expression: "!!window.__SASHA_FEEDBACK__" });
    check({ failures, what: "Send posted the message as a comment on the DECK", ok: sent });

    const comment = await evaluateString({
      client,
      expression: "((window.__SASHA_FEEDBACK__||{}).comments||[{}])[0].content||''",
    });
    check({
      failures,
      what: "the comment carries the message and says it is about no one slide",
      ok: /make the agenda slide bluer/.test(comment) && /"pageObjectId":null/.test(comment),
      detail: JSON.stringify(comment).slice(0, 220),
    });

    const answered = await pollFor({ client, expression: "/redrawing/.test(document.body.textContent||'')" });
    check({ failures, what: "the reply came back as Sasha's turn in the same log", ok: answered });

    // THE WHOLE COLUMN, not the first viewport of it: the log, the pinned comments, the composer
    // and the report entry are all below one another in a 300 px column.
    const tall = await evaluateNumber({
      client,
      expression: "Math.min(4000, Math.ceil(document.documentElement.scrollHeight + 20))",
    });
    await client.Emulation.setDeviceMetricsOverride({
      width: SIDEBAR_WIDTH,
      height: Math.max(1000, tall),
      deviceScaleFactor: 2,
      mobile: false,
    });
    const chatShot = await client.Page.captureScreenshot({ format: "png", captureBeyondViewport: true });
    writeFileSync(CHAT_SHOT, Buffer.from(chatShot.data, "base64"));
    process.stdout.write(`      conversation screenshot: ${CHAT_SHOT} (${tall}px tall)\n`);

    for (const error of errors) failures.push(`sidebar uncaught: ${error}`);
  } finally {
    if (client !== null) await client.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
  }
}

/**
 * SURFACE 3: the DEFECT-REPORT window, in its own tab. It finds its candidate through the server
 * (`sashaTakeReportTarget`, which the slides window recorded), reads that slide, anonymises it,
 * and shows THE SAME EDITOR ON TWO SLIDES -- the slide as it is and the slide as it will be sent
 * (Defect.tsx). Then it has a hand-typed title replacement refused, PREPARES -- which runs the REAL
 * converter over the anonymised HTML -- and sends to an endpoint nothing is listening on.
 *
 * THERE IS NO RUN TABLE AND NO MODEL ANY MORE. What the before/after table of text runs was
 * protecting is checked here on the surface that replaced it: the two slides really render, the
 * right-hand one is an anonymisation rather than a copy, every verdict is a numbered note pinned to
 * the slide it is about, and a replacement that hands the original back is still refused.
 */
async function driveReport({ failures }: { failures: string[] }): Promise<void> {
  const tab = await CDP.New({ port: CDP_PORT, url: `http://127.0.0.1:${PORT}/report.html` });
  let client: CdpClient | null = null;
  try {
    client = await CDP({ target: tab, port: CDP_PORT });
    const { Runtime, Page } = client;
    await Page.enable();
    await Runtime.enable();
    const errors: string[] = [];
    client.on("Runtime.exceptionThrown", (params: unknown) => {
      const described = JSON.stringify(params).slice(0, 400);
      errors.push(described);
      process.stdout.write(`      uncaught: ${described}\n`);
    });
    await client.Emulation.setDeviceMetricsOverride({
      width: REPORT_WIDTH,
      height: REPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // --- THE PAIR IS THE SURFACE ------------------------------------------------------------
    const pair = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-pair .sasha-pane-side').length === 2",
    });
    const panes = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('.sasha-pane-side')].map(e=>e.className))",
    });
    check({
      failures,
      what: "the report window found its slide and shows the two slides side by side",
      ok: pair,
      detail: panes,
    });

    const captions = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-pane-side .sasha-pane-cap strong')].map(e=>e.textContent))",
    });
    check({
      failures,
      what: "one is the slide as it is, the other is the slide as it will be sent",
      ok: captions === JSON.stringify(["As it is", "As it will be sent"]),
      detail: captions,
    });

    // BOTH PANES REALLY RENDER, which is the claim the table could not make: "a reader judges an
    // anonymisation by looking at it". Two `EditorPane`s mean two live iframes with two different
    // documents, and nothing short of a browser can say whether the second one arrived.
    const bothFramed = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-pane-side .sasha-pane-stage iframe.sasha-frame').length === 2",
    });
    const framed = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-pane-side')].map(function(pane){" +
        "var frame = pane.querySelector('.sasha-pane-stage iframe.sasha-frame');" +
        "return [pane.className.replace('sasha-pane-side ',''), frame === null ? 0 : (frame.getAttribute('srcdoc')||'').length];}))",
    });
    check({
      failures,
      what: "and BOTH of them really render a slide in an iframe",
      ok: bothFramed,
      detail: framed,
    });

    // THE RIGHT-HAND SLIDE IS AN ANONYMISATION, NOT A COPY -- compared on the bytes that actually
    // reached `srcdoc`, which is the same function the payload is built from (`sentHtmlOf`).
    const sentDiffers = await pollFor({
      client,
      expression:
        "(function(){var a=document.querySelector('.sasha-pane-source iframe.sasha-frame');" +
        "var b=document.querySelector('.sasha-pane-sent iframe.sasha-frame');if(!a||!b)return false;" +
        "var x=a.getAttribute('srcdoc')||'',y=b.getAttribute('srcdoc')||'';" +
        "return x.length>0&&y.length>0&&x!==y;})()",
    });
    check({ failures, what: "the slide on the right is an anonymisation of the one on the left", ok: sentDiffers });

    const survived = await evaluateString({
      client,
      expression:
        "(function(){var b=document.querySelector('.sasha-pane-sent iframe.sasha-frame');if(!b)return 'no frame';" +
        "var y=b.getAttribute('srcdoc')||'';return JSON.stringify(" +
        `[${JSON.stringify(PROPOSAL_ID)}, ${JSON.stringify(ORIGINAL_TITLE)}].filter(function(word){` +
        "return y.indexOf(word) >= 0;}));})()",
    });
    check({
      failures,
      what: "and none of the original slide's own words is in the bytes it renders",
      ok: survived === "[]",
      detail: survived,
    });

    // --- THE VIEW CHOOSER IS A ZOOM LEVEL, exactly like the slides window's -----------------
    await chooseIn({ client, group: "view", label: "As it is" });
    const onePane = await pollFor({
      client,
      expression:
        "document.querySelectorAll('.sasha-pair .sasha-pane-side').length === 1 && " +
        "document.querySelectorAll('.sasha-pane-source').length === 1",
    });
    check({ failures, what: "choosing one of the two shows that one full width, and only it", ok: onePane });

    await chooseIn({ client, group: "view", label: "Both slides" });
    const bothBack = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-pair .sasha-pane-side').length === 2",
    });
    check({ failures, what: "and both come back, because nothing about what is sent changed", ok: bothBack });

    // --- THE TITLE, THE ONE RUN NO GESTURE ON THE SLIDE CAN REACH ---------------------------
    // BY ID, and the two inputs no longer share a class. This test typed a report endpoint into the
    // slide's title when both were `.sasha-endpoint` and the selector took the first one -- so the
    // thing worth asserting first is that they are two different selectors at all.
    const titled = await pollFor({ client, expression: `!!document.querySelector('#${TITLE_FIELD_ID}')` });
    check({ failures, what: "the document's own title is editable, because it is not drawn on the slide", ok: titled });

    const sharedSelector = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-endpoint').length" });
    check({
      failures,
      what: "and the title and the endpoint are not reachable by the same selector",
      ok: sharedSelector === 1,
      detail: `${sharedSelector} elements answer to .sasha-endpoint`,
    });

    const titleValue = await evaluateString({
      client,
      expression: `(document.querySelector('#${TITLE_FIELD_ID}')||{value:''}).value`,
    });
    check({
      failures,
      what: "the title shows a replacement of the same length, not the original",
      ok:
        titleValue !== "" && titleValue !== ORIGINAL_TITLE && titleValue.length === ORIGINAL_TITLE.length,
      detail: JSON.stringify([ORIGINAL_TITLE, titleValue]),
    });

    // --- EVERY VERDICT IS A NUMBERED NOTE, PINNED TO THE SLIDE IT IS ABOUT ------------------
    // `rejectedReplacements`, `shapeRisks` and `residualRisks` all still have to be on screen; what
    // changed is that they are annotations on the pair rather than columns of a spreadsheet, and
    // the old "Only the N refused" filter is gone -- nothing is hidden.
    const annotated = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-annots .sasha-annot-list .sasha-annot').length > 0",
    });
    const annotations = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-annot')].map(e=>[e.className.replace('sasha-annot ',''),(e.querySelector('strong')||{}).textContent]))",
    });
    check({
      failures,
      what: "the anonymiser's verdicts are numbered notes about the slides, not a table",
      ok: annotated,
      detail: annotations.slice(0, 300),
    });

    // A CLEAN PASS PUTS NOTHING IN THE SLIDE'S GUTTER. A pin means "this one is about this slide
    // and needs a decision", so pinning every residual-risk sentence stacked a column of grey dots
    // down the slide (seen in this test's own screenshot) and said nothing. The tally and the
    // standing notes are cards; only a leak or a risk earns a pin.
    const cleanGutter = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-pins .sasha-pin').length" });
    check({
      failures,
      what: "a clean anonymisation pins nothing to either slide -- a pin means a decision is needed",
      ok: cleanGutter === 0,
      detail: `saw ${cleanGutter} pins`,
    });

    // THE CARRIER TALLY IS A TALLY, NOT A WARNING, and the two were read as one thing while they
    // shared the annotation list.
    const tally = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-carriers li').length" });
    check({
      failures,
      what: "what happened to each carrier is its own list, beside the notes rather than among them",
      ok: tally > 0,
      detail: `${tally} carriers`,
    });

    // THE STANDING CAVEAT. The anonymiser's sentences are rendered word for word, including the
    // ones about asking a model to rewrite the text -- a mode this window does not use. Saying so
    // once, above them, is what replaced the old "what asking a model SENDS" disclosure, and the
    // stub's `__SASHA_REWRITE__` tripwire below is what proves the claim is true.
    const caveat = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-annots')||{}).textContent||''",
    });
    check({
      failures,
      what: "and the surface says in words that nothing here goes to a model",
      ok: /nothing here goes to a model/.test(caveat) && /the only replacements are the ones you typed/.test(caveat),
      detail: caveat.slice(0, 160),
    });

    // WHAT SEND WOULD SEND, AND EVERY NOTE ABOUT IT, IS ABOVE THE BUTTON THAT SENDS IT. The model
    // disclosure this replaces made the same claim about the model round trip; the round trip is
    // gone, and the slide whose bytes leave is what has to be read first now.
    const aboveSend = await evaluateString({
      client,
      expression: `(function(){
        var notes = document.querySelector('.sasha-annots');
        var sent = document.querySelector('.sasha-pane-sent');
        var bar = document.querySelector('.sasha-sendbar');
        if (!notes || !sent || !bar) return '';
        var top = bar.getBoundingClientRect().top;
        return JSON.stringify({
          notes: Math.round(top - notes.getBoundingClientRect().bottom),
          slide: Math.round(top - sent.getBoundingClientRect().bottom)
        });
      })()`,
    });
    check({
      failures,
      what: "what Send would send, and every note about it, is ABOVE the button that sends it",
      ok: readCount({ json: aboveSend, field: "notes" }) >= 0 && readCount({ json: aboveSend, field: "slide" }) >= 0,
      detail: aboveSend,
    });

    const sentBlurb = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-pane-sent .sasha-pane-cap .sasha-dim')||{}).textContent||''",
    });
    check({
      failures,
      what: "and the slide on the right says, on itself, that its bytes are the ones that leave",
      ok: /exactly these bytes leave the browser when you press Send/.test(sentBlurb),
      detail: sentBlurb,
    });

    // --- A REPLACEMENT THAT HANDS THE ORIGINAL BACK IS STILL REFUSED ------------------------
    // `judgeReplacement` has no "the user said so" exemption (defect-state.ts `replacementsFor`),
    // so the title is gibberished and the refusal comes back as a note on the slide it is about.
    // This is the old "a replacement that is the original is refused ON ITS ROW", on the surface
    // that replaced the row.
    await typeInto({ client, selector: `#${TITLE_FIELD_ID}`, text: ORIGINAL_TITLE });
    const refused = await pollFor({
      client,
      expression: "[...document.querySelectorAll('.sasha-annot-risk')].some(e=>/refused/.test(e.textContent||''))",
    });
    check({ failures, what: "a replacement that is the original is refused, as a note on the slide", ok: refused });

    const refusal = await evaluateString({
      client,
      expression:
        "([...document.querySelectorAll('.sasha-annot-risk')].find(e=>/refused/.test(e.textContent||''))||{}).textContent||''",
    });
    check({
      failures,
      what: "and the note says which rule refused it",
      ok: /refused/.test(refusal) && /echo|original|same|too close|identical/i.test(refusal),
      detail: refusal.slice(0, 240),
    });

    // AND NOW IT IS PINNED. A refusal is the one kind of note that needs a decision on a particular
    // slide, so it earns a pin in that slide's gutter -- under the SAME NUMBER as its card, which
    // is computed once so the two can never disagree.
    const numbering = await evaluateString({
      client,
      expression: `(function(){
        function toneOf(element) {
          var matched = /sasha-(?:pin|annot)-(leak|risk|note)/.exec(element.className);
          return matched === null ? '?' : matched[1];
        }
        var pins = [...document.querySelectorAll('.sasha-pane-sent .sasha-pins .sasha-pin')]
          .map(function (pin) { return pin.textContent + ':' + toneOf(pin); });
        var cards = [...document.querySelectorAll('.sasha-annot-list .sasha-annot > .sasha-pin')]
          .map(function (pin) { return pin.textContent + ':' + toneOf(pin); })
          .filter(function (entry) { return entry.indexOf(':note') < 0; });
        return JSON.stringify({
          same: pins.length > 0 && pins.join('|') === cards.join('|') ? 1 : 0,
          pins: pins.join('|'),
          cards: cards.join('|')
        });
      })()`,
    });
    check({
      failures,
      what: "the refusal is PINNED to the slide it is about, under the same number as its card",
      ok: readCount({ json: numbering, field: "same" }) === 1,
      detail: numbering,
    });

    // THE FIELD STILL HOLDS WHAT THE USER TYPED, which is NOT what the slide says -- so the note
    // has to say what the slide really says instead.
    const keptTyping = await evaluateString({
      client,
      expression: `(document.querySelector('#${TITLE_FIELD_ID}')||{value:''}).value`,
    });
    const reallySent = /The slide says "([^"]*)"/.exec(refusal)?.[1] ?? "";
    check({
      failures,
      what: "a refused note shows what the slide actually says, not only what was typed",
      ok: keptTyping === ORIGINAL_TITLE && reallySent !== "" && reallySent !== ORIGINAL_TITLE,
      detail: JSON.stringify([keptTyping, reallySent]),
    });

    // AND NOTHING WAS ASKED OF A MODEL TO GET HERE. The comment-pane round trip that used to fill
    // the table is the only reason this window ever sent the slide's own words anywhere, and the
    // stub's `__SASHA_REWRITE__` tripwire is still armed for it.
    const askedAModel = await evaluateString({
      client,
      expression:
        "JSON.stringify({sent:(window.__SASHA_SENT__||[]).length,rewrite:window.__SASHA_REWRITE__===undefined?0:1})",
    });
    check({
      failures,
      what: "and no model was asked -- nothing left this window over the comment channel",
      ok: askedAModel === JSON.stringify({ sent: 0, rewrite: 0 }),
      detail: askedAModel,
    });

    const sendBlocked = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-send[disabled]').length",
    });
    check({ failures, what: "Send is unavailable until the report is prepared", ok: sendBlocked === 1 });

    await click({ client, selector: ".sasha-prepare" });
    const prepared = await pollFor({ client, expression: "document.querySelectorAll('.sasha-send[disabled]').length === 0" });
    check({ failures, what: "preparing converted the anonymised slide and unlocked Send", ok: prepared });

    // THE ENDPOINT, BY ID. Typing it into `.sasha-endpoint` is what put it in the slide's title
    // before the two fields were separated, and the title it overwrote was then refused as a
    // replacement -- so this one selector is why the whole refusal check used to "pass".
    await typeInto({ client, selector: `#${ENDPOINT_FIELD_ID}`, text: "http://127.0.0.1:1/v1/reports" });
    const endpointLanded = await evaluateString({
      client,
      expression: `(document.querySelector('#${ENDPOINT_FIELD_ID}')||{value:''}).value`,
    });
    const titleUntouched = await evaluateString({
      client,
      expression: `(document.querySelector('#${TITLE_FIELD_ID}')||{value:''}).value`,
    });
    check({
      failures,
      what: "the endpoint went into the endpoint and left the slide's title alone",
      ok: endpointLanded === "http://127.0.0.1:1/v1/reports" && titleUntouched === ORIGINAL_TITLE,
      detail: JSON.stringify([endpointLanded, titleUntouched]),
    });

    await click({ client, selector: ".sasha-prepare" });
    await pollFor({ client, expression: "document.querySelectorAll('.sasha-send[disabled]').length === 0" });
    await click({ client, selector: ".sasha-send" });
    const unreachable = await pollFor({
      client,
      expression: "/nothing answered at/.test(document.body.textContent||'')",
    });
    check({ failures, what: "a send nobody answers is a visible failure, not a spinner", ok: unreachable });

    // THE WHOLE SURFACE, not the first 800 px of it -- INCLUDING BOTH SLIDES OF THE PAIR. The
    // REPORT PANEL's own scroll height, not the document's: the panel is the scroller here
    // (picker-styles.ts), so the document stays exactly one viewport tall however long the notes
    // are. A taller viewport makes the panel taller, which is what puts the two slides, the notes,
    // the note box, the endpoint field and the send verdict in one picture.
    const reportHeight = await evaluateNumber({
      client,
      expression:
        "(function(){var p=document.querySelector('.sasha-report');" +
        "return Math.min(4000, Math.ceil(p ? p.scrollHeight + 40 : 0));})()",
    });
    await client.Emulation.setDeviceMetricsOverride({
      width: REPORT_WIDTH,
      height: Math.max(REPORT_HEIGHT, reportHeight),
      deviceScaleFactor: 1,
      mobile: false,
    });
    const reportShot = await client.Page.captureScreenshot({ format: "png", captureBeyondViewport: true });
    writeFileSync(REPORT_SHOT, Buffer.from(reportShot.data, "base64"));
    process.stdout.write(`      defect report screenshot: ${REPORT_SHOT} (${reportHeight}px tall)\n`);

    for (const error of errors) failures.push(`report uncaught: ${error}`);
  } finally {
    if (client !== null) await client.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
  }
}

/** One emitted page with the stub injected ahead of its bundle. */
function stubbed(file: string): string {
  const page = readFileSync(file, "utf-8");
  if (!page.includes("<script>")) throw new Error(`${file} has no inline bundle -- run build-addon.ts first`);
  return page.replace("</head>", `${STUB_SCRIPT}\n</head>`);
}

/**
 * The stub. It is injected ahead of each bundle and defines exactly the twelve functions Code.gs
 * exposes, answering from one staged proposal with a canned event log and canned candidate
 * comments. The manifest, READY and event bodies are the real protocol bytes, so src/protocol.ts's
 * and src/session-log.ts's parsers are exercised rather than bypassed.
 */
const STUB_SCRIPT = `<script>
(function () {
  // The observer PERSISTS answered proposals in localStorage (seen-store.ts), and this page is
  // always served from the same origin -- so once a run has dismissed the canned proposal, every
  // later run would ignore it and sit in \`dormant\`. Measured: the picker half silently stopped
  // mounting the moment the review half started by dismissing. The run must start from empty.
  try { localStorage.clear(); } catch (storageError) { /* private window: nothing to clear */ }
  var PROPOSAL = ${JSON.stringify(PROPOSAL_ID)};
  var DECK = 'deck_smoke_0123456789';
  var COUNT = ${COUNT};
  // THE CANNED SESSION LOG. Real file names (<millis>-<6 base36>-<kind>.json), real bodies, and a
  // final event whose kind this build has never heard of -- which must render as an opaque line.
  var EVENTS = [
    event(1791115140000, 'aaaaaa', 'slides-staged', { count: COUNT }),
    event(1791115560000, 'bbbbbb', 'comment-opened', {
      commentId: 'cc_open', slideIndex: 2, text: 'the gridlines are gone',
      region: { x: 0.12, y: 0.4, w: 0.5, h: 0.3 }
    }),
    event(1791115620000, 'cccccc', 'comment-answered', {
      commentId: 'cc_open', slideIndex: 2, text: 'redrawn with the gridlines back'
    }),
    event(1791115680000, 'dddddd', 'slide-revised', { slideIndex: 2, answers: ['cc_open'], revision: 2 }),
    // Slide 3 is the candidate Drive refuses, so this line also exercises the "!" badge; and it is
    // the DECK's own voice, which is the fourth tint.
    event(1791115740000, 'eeeeee', 'slide-inserted', { slideIndex: 3, pageObjectId: 'g_new' }),
    event(1791115800000, 'ffffff', 'teleported-slide', { slideIndex: 2 })
  ];

  function event(millis, suffix, kind, fields) {
    var body = { protocolVersion: 1, at: new Date(millis).toISOString(), kind: kind };
    for (var key in fields) if (Object.prototype.hasOwnProperty.call(fields, key)) body[key] = fields[key];
    return {
      fileId: 'drive_' + suffix,
      name: millis + '-' + suffix + '-' + kind + '.json',
      text: JSON.stringify(body)
    };
  }
  var slides = [];
  var html = {};
  for (var index = 1; index <= COUNT; index++) {
    var name = (index < 10 ? '0' : '') + index + '.html';
    var fileId = 'html_' + index;
    slides.push({ index: index, fileId: fileId, name: name, label: 'option ' + index });
    html[fileId] = ${JSON.stringify(slideHtml({ index: 1, proposalId: PROPOSAL_ID }))}
      .split('option 1').join('option ' + index);
  }
  var texts = {
    ready: JSON.stringify({ protocolVersion: 1, proposalId: PROPOSAL, count: COUNT, manifestFileId: 'manifest' }),
    manifest: JSON.stringify({
      protocolVersion: 1, proposalId: PROPOSAL, createdAt: '2026-10-03T12:00:00.000Z',
      presentationId: 'deck_smoke_0123456789', count: COUNT, slides: slides, revision: 2
    })
  };
  var answers = {
    sashaHello: function () {
      return { protocolVersion: 1, presentationUrl: 'https://docs.google.com/presentation/d/deck_smoke_0123456789/edit' };
    },
    sashaScanInbox: function () {
      return { marks: [{ proposalId: PROPOSAL, folderId: 'folder_1', readyFileId: 'ready',
                         pickFileId: null, createdTime: '2026-10-03T12:00:00.000Z' }] };
    },
    sashaReadText: function (spec) {
      var text = spec.fileId === 'ready' ? texts.ready : spec.fileId === 'manifest' ? texts.manifest : html[spec.fileId];
      if (text === undefined) throw new Error('no such file ' + spec.fileId);
      return { text: text };
    },
    sashaInsert: function () { return { batchResponse: { replies: [{ createSlide: { objectId: 'sasha_smoke' } }] }, renderArtifact: null }; },
    sashaWritePick: function (spec) { window.__SASHA_PICK__ = spec; return { fileId: 'pick_1' }; },
    // THE SESSION LOG. One file per event, the real name grammar, and one kind this build has never
    // heard of -- which must render as an opaque line rather than vanish.
    sashaReadEvents: function () {
      return { events: EVENTS.concat(window.__SASHA_EVENTS__ || []) };
    },
    sashaWriteEvent: function (spec) {
      window.__SASHA_EVENTS__ = (window.__SASHA_EVENTS__ || [])
        .concat([{ fileId: 'ev_' + spec.name, name: spec.name, text: spec.body }]);
      return { fileId: 'ev_' + spec.name };
    },
    // THE UNRESOLVED COUNTS' one source: the comments on each CANDIDATE file. html_3 is the one
    // Drive refuses, which is what proves a badge says "could not be read" instead of zero.
    sashaCandidateComments: function (spec) {
      var files = [];
      for (var at = 0; at < spec.fileIds.length; at++) {
        var fileId = spec.fileIds[at];
        if (fileId === 'html_3') {
          files.push({ fileId: fileId, comments: [], error: 'Drive HTTP 404' });
          continue;
        }
        files.push({ fileId: fileId, comments: threadsOn(fileId), error: null });
      }
      return { files: files };
    },
    // TWO KINDS OF COMMENT GO THROUGH HERE and they are kept apart on purpose: a review note is
    // what __SASHA_FEEDBACK__ means to the checks below, and the anonymiser's REWRITE REQUEST is
    // also a comment on this deck. Stashing both in one global made the review assertion read the
    // rewrite prompt. __SASHA_SENT__ accumulates everything, which is what a real comment pane
    // does -- sashaReadFeedback lists them all, so both long polls find their own thread.
    sashaSendFeedback: function (spec) {
      // PER FILE, because that is the whole point: a conversation message goes on the DECK and a
      // mark-up goes on the CANDIDATE, through this one function, told apart only by the file id.
      var byFile = window.__SASHA_FILE_COMMENTS__ || {};
      byFile[spec.fileId] = (byFile[spec.fileId] || []).concat(spec.comments);
      window.__SASHA_FILE_COMMENTS__ = byFile;
      if (spec.fileId === DECK) {
        window.__SASHA_SENT__ = (window.__SASHA_SENT__ || []).concat(spec.comments);
        if (isRewriteRequest(spec.comments)) window.__SASHA_REWRITE__ = spec;
        else window.__SASHA_FEEDBACK__ = spec;
      }
      var results = [];
      for (var at = 0; at < spec.comments.length; at++) results.push({ commentId: 'c_' + spec.fileId + '_' + at, error: null });
      return { results: results };
    },
    sashaReadFeedback: function () {
      return { comments: sentThreads(window.__SASHA_SENT__ || []) };
    },
    // The surface split's three. In production these call showModelessDialog; here they only have
    // to answer the way Code.gs does, because what is under test is that the caller READS the
    // answer rather than assuming the window appeared -- and that the report target is RECORDED,
    // which is the only channel between two documents that share nothing.
    sashaOpenPicker: function () {
      window.__SASHA_OPENED__ = true;
      window.__SASHA_OPEN_COUNT__ = (window.__SASHA_OPEN_COUNT__ || 0) + 1;
      return { opened: true };
    },
    sashaOpenDefectReport: function (spec) {
      window.__SASHA_REPORT_TARGET__ = { proposalId: spec.proposalId, slideIndex: spec.slideIndex };
      return { opened: true };
    },
    // A fixed answer rather than a read of __SASHA_REPORT_TARGET__: the report window is a
    // SEPARATE DOCUMENT with its own window object, so in production it could never see what the slides
    // window wrote -- only what the server recorded. The stub models the server, not the page.
    sashaTakeReportTarget: function () {
      if (window.__SASHA_TARGET_TAKEN__) return { proposalId: null, slideIndex: null };
      window.__SASHA_TARGET_TAKEN__ = true;
      return { proposalId: PROPOSAL, slideIndex: ${REPORTED_SLIDE} };
    }
  };

  /** The comments already on a candidate, plus whatever this page has posted onto it. */
  function threadsOn(fileId) {
    var seeded = fileId === 'html_2' ? [{
      id: 'cc_open',
      content: 'the gridlines are gone\\n\\nsasha-slides-feedback=' + JSON.stringify({
        protocolVersion: 1, noteId: 'box_seed', pageObjectId: null,
        region: { x: 0.12, y: 0.4, w: 0.5, h: 0.3 }, createdAt: '2026-10-04T12:06:00.000Z'
      }),
      createdTime: '2026-10-04T12:06:00.000Z',
      resolved: false,
      author: { displayName: 'Krunoslav' },
      replies: []
    }] : [];
    var posted = ((window.__SASHA_FILE_COMMENTS__ || {})[fileId] || []).map(function (comment, at) {
      return {
        id: 'cc_' + fileId + '_' + at,
        content: comment.content,
        createdTime: '2026-10-04T12:20:0' + at + 'Z',
        resolved: false,
        author: { displayName: 'Krunoslav' },
        replies: []
      };
    });
    return seeded.concat(posted);
  }

  function isRewriteRequest(comments) {
    for (var at = 0; at < comments.length; at++) {
      if (comments[at].content.indexOf('helping anonymise one slide') >= 0) return true;
    }
    return false;
  }

  /** The comments the stub "created", echoed back with one canned answer, as Drive would list them. */
  function sentThreads(comments) {
    return comments.map(function (comment, at) {
      return {
        id: 'c_' + at,
        content: comment.content,
        createdTime: '2026-10-04T12:00:0' + at + 'Z',
        resolved: false,
        author: { displayName: 'Krunoslav' },
        replies: [{ id: 'r_' + at, content: answerFor(comment.content), createdTime: '2026-10-04T12:01:00Z', author: { displayName: 'Claude' } }]
      };
    });
  }

  /**
   * What "Claude" replies to a REVIEW note. There is only one kind of reply left: the anonymiser's
   * model-assisted mode is withdrawn, so nothing asks this stub to rewrite a slide's text any more.
   *
   * The rewrite branch is deliberately NOT restored as a no-op -- isRewriteRequest above is kept
   * as a TRIPWIRE instead. If the report window ever sends the slide's own words down the comment
   * channel again, __SASHA_REWRITE__ is set and the report surface's "nothing here goes to a
   * model" check fails, which is the only way a test can hold a privacy claim to account.
   * (No backticks anywhere below this line: the whole stub IS a template literal, and one closes
   * it mid-comment -- which is three parse errors in a file that was otherwise finished.)
   */
  function answerFor(content) {
    if (isRewriteRequest([{ content: content }])) return 'nothing here asks a model to rewrite anything';
    return 'looked at it, redrawing';
  }
  // COPY-ON-WRITE, like the real google.script.run: withSuccessHandler returns a NEW runner with
  // that handler set, it does not mutate the one it was called on. The earlier stub mutated shared
  // state, so two calls in flight at once (review mode fetches the page and the comment threads
  // together) clobbered each other's handlers and the first call never settled.
  function runner(onSuccess, onFailure) {
    var self = {
      withSuccessHandler: function (handler) { return runner(handler, onFailure); },
      withFailureHandler: function (handler) { return runner(onSuccess, handler); }
    };
    Object.keys(answers).forEach(function (name) {
      self[name] = function (spec) {
        setTimeout(function () {
          try { if (onSuccess) onSuccess(answers[name](spec)); }
          catch (error) { if (onFailure) onFailure(error); }
        }, 0);
      };
    });
    return self;
  }
  window.google = { script: { get run() { return runner(null, null); } } };
})();
</script>`;

/** One origin, two documents -- the same shape Apps Script serves them in. */
function listen(pages: Readonly<Record<string, string>>): Promise<Server> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const page = pages[request.url ?? ""];
    if (page === undefined) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`no such page: ${request.url ?? ""}`);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
  });
  return new Promise<Server>((done) => server.listen(PORT, "127.0.0.1", () => done(server)));
}

/**
 * One NUMBER out of a JSON object the page measured, or -1 when it is not there.
 *
 * The measuring expressions return a whole record rather than a single number so the FAIL line can
 * carry the geometry that explains it -- "2 of 3" says nothing about whether the grid is short or
 * the cells are tall. This is the typed way back out of it.
 */
function readCount({ json, field }: { json: string; field: string }): number {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return -1;
    const value: unknown = (parsed as Record<string, unknown>)[field];
    return typeof value === "number" ? value : -1;
  } catch {
    return -1;
  }
}

/** How many times `needle` occurs in `haystack`. For counting one attribute across N elements. */
function occurrences({ haystack, needle }: { haystack: string; needle: string }): number {
  return haystack.split(needle).length - 1;
}

/**
 * WHICH BUTTON IS PRESSED IN EVERY TOOLBAR GROUP, as `view/tool/showing`. The whole point of the
 * rework is that the three are independent, so the way to assert it is to read all three after
 * touching one of them -- a per-group assertion would pass on a toolbar where choosing a tool
 * silently reset the zoom level.
 */
async function choicesOf({ client }: { client: CdpClient }): Promise<string> {
  return evaluateString({
    client,
    expression:
      "[...document.querySelectorAll('.sasha-toolbar .sasha-toggle')].map(function(group){" +
      "var on = [...group.querySelectorAll('button')].find(function(button){" +
      "return button.getAttribute('aria-pressed') === 'true';});" +
      "return on === undefined ? '-' : on.textContent;}).join('/')",
  });
}

/**
 * Press one button in ONE NAMED toolbar group.
 *
 * By group and not by text, because the labels collide: "One slide" and "Converted slide" both say
 * "slide", and a test that matched text alone took the view button and silently never converted
 * anything -- which looked like "the converter is broken" for a whole run.
 */
async function chooseIn({
  client,
  group,
  label,
}: {
  client: CdpClient;
  group: string;
  label: string;
}): Promise<void> {
  await client.Runtime.evaluate({
    expression: `(function(){
      var groups = [...document.querySelectorAll('.sasha-toolbar .sasha-toggle')];
      var mine = groups.find(function (candidate) {
        var named = candidate.querySelector('.sasha-toggle-label');
        return named !== null && named.textContent === ${JSON.stringify(group)};
      });
      if (mine === undefined) return false;
      var button = [...mine.querySelectorAll('button')].find(function (candidate) {
        return (candidate.textContent || '').indexOf(${JSON.stringify(label)}) === 0;
      });
      if (button === undefined) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: false,
  });
}

async function pollFor({
  client,
  expression,
  budgetMs = READY_BUDGET_MS,
}: {
  client: CdpClient;
  expression: string;
  budgetMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const { result } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
    if (result.value === true) return true;
    await new Promise<void>((done) => setTimeout(done, POLL_MS));
  }
  return false;
}

/** A click through the DOM, which is what React listens to in this bundle. */
async function click({ client, selector }: { client: CdpClient; selector: string }): Promise<void> {
  await client.Runtime.evaluate({
    expression: `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(el)el.click();return !!el;})()`,
    returnByValue: true,
    awaitPromise: false,
  });
}

/**
 * Press the button inside `within` whose text STARTS WITH `startsWith`.
 *
 * By text, because the row it is in holds several buttons of the same class: `.sasha-actions` has
 * the report entry, Dismiss and Insert, and a class selector there would press whichever came
 * first. The report button's own label carries the candidate number, so it is a prefix match.
 */
async function clickLabelled({
  client,
  within,
  startsWith,
}: {
  client: CdpClient;
  within: string;
  startsWith: string;
}): Promise<void> {
  await client.Runtime.evaluate({
    expression: `(function(){
      var row = document.querySelector(${JSON.stringify(within)});
      if (row === null) return false;
      var button = [...row.querySelectorAll('button')].find(function (candidate) {
        return (candidate.textContent || '').indexOf(${JSON.stringify(startsWith)}) === 0;
      });
      if (button === undefined) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: false,
  });
}

/**
 * The real gesture, through the BROWSER's input pipeline rather than synthetic DOM events: CDP's
 * `Input.dispatchMouseEvent` produces a genuine pointer, so `setPointerCapture` inside the handler
 * succeeds the way it does for a user with a mouse. (A synthetic `new PointerEvent(...)` has no
 * active pointer and that call throws, which is the thing worth NOT papering over in the test.)
 */
/**
 * A box dragged with real mouse events, RETRIED until the page shows it landed.
 *
 * Three `Input.dispatchMouseEvent` calls race React: the gesture is held in `RegionOverlay`'s own
 * state, and a re-render arriving between pointerdown and pointerup (the candidate's HTML landing,
 * the measured scale changing, the comment read returning) can drop it. Measured: the same drag
 * succeeded and failed across runs with no code change. So `until` is an expression that proves the
 * box landed, and the gesture is repeated against it rather than against a sleep -- which is also
 * why this cannot pass by accident: an overlay that never takes a drag fails every attempt.
 */
async function drag({
  client,
  selector,
  until,
}: {
  client: CdpClient;
  selector: string;
  /** Proof the drag landed. Without it the gesture is dispatched once and not checked. */
  until?: string;
}): Promise<void> {
  for (let attempt = 0; attempt < DRAG_ATTEMPTS; attempt++) {
    await dispatchDrag({ client, selector });
    if (until === undefined) return;
    if (await pollFor({ client, expression: until, budgetMs: DRAG_SETTLE_MS })) return;
  }
}

const DRAG_ATTEMPTS = 4;
const DRAG_SETTLE_MS = 2_000;

async function dispatchDrag({ client, selector }: { client: CdpClient; selector: string }): Promise<void> {
  const box = await evaluateString({
    client,
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return '';
      var r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].join(',');
    })()`,
  });
  const sides = box.split(",").map((side) => Number(side));
  const [left, top, width, height] = [sides[0] ?? 0, sides[1] ?? 0, sides[2] ?? 0, sides[3] ?? 0];
  const from = { x: Math.round(left + width * 0.2), y: Math.round(top + height * 0.2) };
  const to = { x: Math.round(left + width * 0.6), y: Math.round(top + height * 0.7) };
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: to.x, y: to.y, button: "left" });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
}

/** React reads `value` off the native setter, so setting `.value` alone would be ignored. */
async function typeInto({ client, selector, text }: { client: CdpClient; selector: string; text: string }): Promise<void> {
  await client.Runtime.evaluate({
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      var prototype = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: false,
  });
}

async function evaluateNumber({ client, expression }: { client: CdpClient; expression: string }): Promise<number> {
  const { result } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  return typeof result.value === "number" ? result.value : -1;
}

async function evaluateString({ client, expression }: { client: CdpClient; expression: string }): Promise<string> {
  const { result } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  return typeof result.value === "string" ? result.value : "";
}

function check({
  failures,
  what,
  ok,
  detail = "",
}: {
  failures: string[];
  what: string;
  ok: boolean;
  detail?: string;
}): void {
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${what}${detail === "" ? "" : ` (${detail})`}\n`);
  if (!ok) failures.push(`${what}${detail === "" ? "" : ` (${detail})`}`);
}

main().catch((cause: unknown) => {
  process.stderr.write(`smoke failed: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});

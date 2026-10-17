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
// files Apps Script would serve, answers every server function from a canned proposal with a
// canned event log and canned candidate comments, and reports what rendered: Ask Sasha first (it
// is the one surface the menu opens), then the slides grid and its mark-up view, then the report
// window.
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
import { AGENT_REPLY_MARKER } from "../../agent-marker.ts";

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
const COMPOSER_SHOT = join(tmpdir(), "sasha-spot-smoke.png");
const MARKUP_SHOT = join(tmpdir(), "sasha-markup-smoke.png");
const SIDEBAR_SHOT = join(tmpdir(), "sasha-ask-sasha-smoke.png");
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
    "/sidebar-seeded.html": seededSidebar(),
    "/report.html": stubbed(REPORT_FILE),
  });
  const failures: string[] = [];
  try {
    // ASK SASHA FIRST, because it is the one thing the menu opens.
    await driveSidebar({ failures });
    await driveSeededSidebar({ failures });
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

    // THE BACKGROUND CONVERSION FINISHES BY ITSELF. Measured live 2026-10-11: each conversion
    // dispatched its result while its index was still marked in flight, so the pump that dispatch
    // ran declined to start the next one and nothing re-ran it -- the chain stalled after one
    // candidate until some unrelated event happened along, and "Converted" waited on it. No input
    // is given here on purpose: every conversion lands in the conversion cache on its own.
    const conversionsStored = "Object.keys(localStorage).filter(k => k.startsWith('sashaSlides.conversion.')).length";
    const allConvertedUnprompted = await pollFor({ client, expression: `${conversionsStored} >= ${COUNT}`, budgetMs: 5_000 });
    check({
      failures,
      what: `all ${COUNT} candidates convert in the background with no input`,
      ok: allConvertedUnprompted,
      detail: `${await evaluateNumber({ client, expression: conversionsStored })} stored`,
    });

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

    // --- THE GRID IS A CHOOSER, AND ITS CHROME IS ONE TOGGLE -------------------------------
    // It used to carry three groups -- view, tool and showing -- over four thumbnails. Two of
    // those are decisions about ONE candidate, and they moved into the editor window that opens
    // when a candidate is picked. What is left is the one question the grid asks.
    const groups = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-toolbar .sasha-toggle')].map(function(group){" +
        "return [(group.querySelector('.sasha-toggle-label')||{}).textContent," +
        "[...group.querySelectorAll('button')].map(function(button){return button.textContent;})];}))",
    });
    check({
      failures,
      what: "the grid's chrome is ONE toggle -- which rendering you are comparing",
      ok: groups === JSON.stringify([["showing", ["Preview", "Converted"]]]),
      detail: groups,
    });

    const chosen = await choicesOf({ client });
    check({
      failures,
      what: "and the first paint is the preview, because that is the slide the user wrote",
      ok: chosen === "Preview",
      detail: chosen,
    });

    // THE GRID SAYS WHAT THE PICTURES ARE FOR, and not dimly: without it a slide reads as a
    // thumbnail, and nobody clicks a thumbnail (picker-styles.ts `.sasha-toolbar-say`).
    const callToAction = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-toolbar-say')||{}).textContent||''",
    });
    const sayWeight = await evaluateString({
      client,
      expression:
        "(function(){var e=document.querySelector('.sasha-toolbar-say');" +
        "return e===null?'':getComputedStyle(e).fontWeight;})()",
    });
    check({
      failures,
      what: "the grid tells the user the pictures are the control, prominently",
      ok: /click on it/.test(callToAction) && Number(sayWeight) >= 600,
      detail: `${JSON.stringify(callToAction)} weight ${sayWeight}`,
    });

    // --- NOTHING IS REACHABLE IN THE GRID --------------------------------------------------
    // `sandbox="allow-same-origin"` is the one security-relevant attribute on this surface, and
    // the grid grants it to nothing at all: the live editor lives in the editor WINDOW, so the
    // only candidate that can ever be reached into is the one the user opened on purpose.
    const sandboxes = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('iframe.sasha-frame')].map(f=>f.getAttribute('sandbox')))",
    });
    check({
      failures,
      what: "no cell in the grid is reachable -- every candidate keeps the strictest sandbox",
      ok: occurrences({ haystack: sandboxes, needle: "allow-same-origin" }) === 0,
      detail: sandboxes,
    });

    const gridOverlays = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-grid .sasha-overlay').length",
    });
    check({
      failures,
      what: "and no cell takes the pointer: the grid chooses, the editor works",
      ok: gridOverlays === 0,
      detail: `saw ${gridOverlays}`,
    });

    // --- WHAT IS UNDER A CELL, AND WHAT IS NOT ---------------------------------------------
    // The cell used to carry a name chip, a "Show large" button and a line of status. The index
    // is on the PICTURE now, clicking the picture is the zoom, and the status was a sentence
    // nobody could act on -- so what is left is the two decisions a candidate can receive.
    const cellFoot = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-cell:first-child .sasha-cell-foot button')]" +
        ".map(function(b){return [b.textContent, b.className];}))",
    });
    check({
      failures,
      what: "under every slide: Report defect, Insert before, then Insert after last and accented",
      ok:
        cellFoot ===
        JSON.stringify([
          ["Report defect", "sasha-secondary sasha-small"],
          ["Insert before", "sasha-secondary sasha-small"],
          ["Insert after", "sasha-primary sasha-small"],
        ]),
      detail: cellFoot,
    });

    const goneFromCells = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-cell-hint, .sasha-cell-foot .sasha-chip, .sasha-zoom').length",
    });
    check({
      failures,
      what: "and nothing else -- no caption, no name chip, no Show large",
      ok: goneFromCells === 0,
      detail: `saw ${goneFromCells} leftovers`,
    });

    // THE NUMBER IS ON THE PICTURE. It is what the user says out loud ("option 3"), so it belongs
    // to the slide rather than to a caption that no longer exists.
    const numbers = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-cell .sasha-cell-number')].map(e=>e.textContent))",
    });
    check({
      failures,
      what: "every candidate wears its own number, 1..N",
      ok: numbers === JSON.stringify(Array.from({ length: COUNT }, (_unused, at) => String(at + 1))),
      detail: numbers,
    });

    // AND THE WHOLE PICTURE IS THE TARGET, with a pointer cursor over all of it: the slide is an
    // IFRAME, which swallows the pointer, so a handler on the stage would never fire.
    const openCursor = await evaluateString({
      client,
      expression:
        "(function(){var b=document.querySelector('.sasha-cell .sasha-cell-open');" +
        "if(b===null)return 'no button';var box=b.getBoundingClientRect();" +
        "var stage=b.parentElement.getBoundingClientRect();" +
        // Within the stage's 2px border: `inset:0` is the padding box, the rect includes the border.
        "return getComputedStyle(b).cursor + ' ' + (stage.width - box.width <= 6 &&" +
        " stage.height - box.height <= 6);})()",
    });
    check({
      failures,
      what: "the slide itself is clickable, and looks it",
      ok: openCursor === "pointer true",
      detail: openCursor,
    });

    // --- THE HEADER AND THE FOOTER SAY ONLY WHAT IS ACTIONABLE ------------------------------
    // "4 candidate slides p_1791145806407_yig6ws" stood over the grid: the count is the number of
    // pictures below it and the id names a file nobody opens. The footer's tally of mark-ups and
    // its two "option N" buttons went the same way -- those act on ONE candidate, so they are
    // under the candidate they act on.
    const headerText = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-dialog > .sasha-header')||{}).textContent||''",
    });
    check({
      failures,
      what: "the header does not count what the reader can see, nor name the proposal's folder",
      ok: headerText === "" && !headerText.includes(PROPOSAL_ID),
      detail: JSON.stringify(headerText),
    });

    // THERE IS NO FOOTER BAR. It held one button, under a title bar that already has an X, and
    // two ways out stacked ten pixels apart read as the same control twice.
    const footerBars = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-actions').length" });
    check({
      failures,
      what: "there is no second bar at the bottom of the window",
      ok: footerBars === 0,
      detail: `saw ${footerBars}`,
    });

    // BUT THE ANSWER IT CARRIED SURVIVES, on the chrome row. The window's X is Apps Script's own
    // `showModelessDialog` chrome: it closes the window and writes nothing, while this writes
    // `PICK {picked: null}` -- the only thing that answers a waiting `await_pick` with "none of
    // these" (dialog.tsx `submit`). Losing it would leave the agent waiting for its timeout.
    const noneOfThese = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-toolbar .sasha-none')||{}).textContent||''",
    });
    check({
      failures,
      what: "and the answer it carried is on the chrome row, worded as an answer",
      ok: noneOfThese === "None of these",
      detail: JSON.stringify(noneOfThese),
    });


    await client.Page.captureScreenshot({ format: "png" }).then((shot) =>
      writeFileSync(GRID_SHOT, Buffer.from(shot.data, "base64")),
    );
    process.stdout.write(`      grid screenshot: ${GRID_SHOT}\n`);

    // --- THE UNRESOLVED COUNTS, ON THE CELLS -----------------------------------------------
    // The grid and the conversation read the SAME candidate comments. Slide 2 has one open thread
    // in the stub, and slide 3's file is one Drive refuses -- so its badge must say "could not be
    // read" rather than "no open comments" (UI-CONTRACT.md).
    const badges = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-cell-unresolved').length >= 2",
    });
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

    // --- PICKING A CANDIDATE OPENS THE EDITOR OVER THE GRID ---------------------------------
    const openedAt = Date.now();
    await click({ client, selector: '[aria-label="Open option 1 to request changes"]' });
    const opened = await pollFor({ client, expression: "!!document.querySelector('.sasha-editor-scrim .sasha-editor')" });
    const scrimMs = Date.now() - openedAt;
    await pollFor({
      client,
      expression:
        "(function(){var f=document.querySelector('.sasha-editor-stage iframe.sasha-frame');" +
        "return !!f && !!f.contentDocument && f.contentDocument.body && f.contentDocument.body.childNodes.length>0;})()",
    });
    const frameMs = Date.now() - openedAt;
    process.stdout.write(`      open timing: scrim ${String(scrimMs)}ms, frame ready ${String(frameMs)}ms\n`);
    check({ failures, what: "clicking a slide opens the editor on that candidate", ok: opened });
    check({
      failures,
      what: "and it is on screen in well under a second -- opening is a zoom, not a load",
      ok: frameMs < 1000,
      detail: `scrim ${String(scrimMs)}ms, frame ${String(frameMs)}ms`,
    });

    const gridStillThere = await evaluateNumber({ client, expression: "document.querySelectorAll('.sasha-grid').length" });
    check({
      failures,
      what: "and the grid stays mounted underneath, so closing comes back where the user was",
      ok: gridStillThere === 1,
      detail: `saw ${gridStillThere} grids`,
    });

    // THE TOOLBAR IS DOWN THE LEFT EDGE of the editor, and it is the ONLY place a tool is chosen.
    const rail = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-toolrail .sasha-toolbtn-name')].map(e=>e.textContent))",
    });
    check({
      failures,
      what: "the editor's tools are a rail down its left edge: Select, then Annotate",
      ok: rail === JSON.stringify(["Select", "Annotate"]),
      detail: rail,
    });

    // AND THE THREADS ARE DOWN THE RIGHT EDGE, reading the same comments the conversation shows.
    const threads = await pollFor({ client, expression: "!!document.querySelector('.sasha-threads')" });
    check({ failures, what: "and the comment threads are a rail down its right edge", ok: threads });

    // EXACTLY ONE FRAME IS REACHABLE, and it is the candidate the user opened on purpose.
    const editorReach = await pollFor({
      client,
      expression:
        "[...document.querySelectorAll('iframe.sasha-frame')]" +
        ".filter(f=>(f.getAttribute('sandbox')||'').indexOf('allow-same-origin')>=0).length === 1",
    });
    const reachDetail = await evaluateString({
      client,
      expression: "JSON.stringify([...document.querySelectorAll('iframe.sasha-frame')].map(f=>f.getAttribute('sandbox')))",
    });
    check({
      failures,
      what: "the open candidate's frame is reachable and nothing else is",
      ok: editorReach,
      detail: reachDetail,
    });

    // --- THE SELECT TOOL ACTUALLY SELECTS ---------------------------------------------------
    // GRANTING THE FRAME IS NOT THE SAME AS EDITING IT. The sandbox check above proves the editor
    // CAN reach the candidate's document; it proves nothing about whether a click on a paragraph
    // selects that paragraph, and "I can't select anything and move it" is a complaint no
    // attribute assertion can catch. `slide-editor.ts` `attach` refuses with a reason when it
    // cannot reach in, so a failure here is either that refusal or a dead pointer handler.
    const attachWarning = await evaluateString({
      client,
      expression: "JSON.stringify(window.__SASHA_EDITOR_WARNINGS__ || [])",
    });
    check({
      failures,
      what: "the visual editor attached to the open candidate without refusing",
      ok: !/cannot attach/.test(attachWarning),
      detail: attachWarning.slice(0, 220),
    });

    // CLICK A REAL ELEMENT INSIDE THE STAGED DOCUMENT. The editor listens on the candidate's own
    // document, so the gesture has to be dispatched there, at the element's own coordinates.
    const picked = await evaluateString({
      client,
      expression:
        "(function(){" +
        "var f=document.querySelector('.sasha-editor-stage iframe.sasha-frame');" +
        "if(!f||!f.contentDocument)return 'no reachable frame';" +
        "var el=f.contentDocument.querySelector('h1,h2,p,div');" +
        "if(!el)return 'nothing to select';" +
        "var box=el.getBoundingClientRect();" +
        "var opts={bubbles:true,cancelable:true,composed:true,clientX:box.left+box.width/2," +
        "clientY:box.top+box.height/2,pointerType:'mouse',button:0,pointerId:1,isPrimary:true};" +
        "el.dispatchEvent(new PointerEvent('pointerdown',opts));" +
        "el.dispatchEvent(new PointerEvent('pointerup',opts));" +
        "el.dispatchEvent(new PointerEvent('pointermove',opts));" +
        "return el.tagName;})()",
    });

    // The selection box is the editor's OWN chrome, drawn in the HOST document over the frame
    // (slide-editor.ts `mountChrome`), class `sasha-ed-select`.
    const selectionShown = await pollFor({
      client,
      expression:
        "(function(){var box=document.querySelector('.sasha-ed-select');" +
        "return !!box && box.style.display !== 'none';})()",
    });
    const selectionState = await evaluateString({
      client,
      expression:
        "(function(){var box=document.querySelector('.sasha-ed-select');" +
        "if(!box)return 'no .sasha-ed-select in the host document';" +
        "return 'display=' + (box.style.display||'<unset>') + ' rect=' + JSON.stringify(box.getBoundingClientRect());})()",
    });
    check({
      failures,
      what: "clicking an element on the candidate selects it",
      ok: selectionShown,
      detail: `clicked ${picked}; ${selectionState}`,
    });

    // AND THE SELECTION IS DRAGGABLE, which is the half the user actually asked for: the chrome
    // appearing proves the listener fires, not that the thing can be moved. A drag on the
    // selection box records a `moved` edit, which is what travels to Sasha.
    const dragged = await evaluateString({
      client,
      expression:
        "(function(){" +
        "var box=document.querySelector('.sasha-ed-select');" +
        "if(!box)return 'nothing selected';" +
        "var r=box.getBoundingClientRect();" +
        "var at=function(x,y){return {bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y," +
        "pointerType:'mouse',button:0,pointerId:7,isPrimary:true};};" +
        "box.dispatchEvent(new PointerEvent('pointerdown',at(r.left+r.width/2,r.top+r.height/2)));" +
        "document.dispatchEvent(new PointerEvent('pointermove',at(r.left+r.width/2+40,r.top+r.height/2+25)));" +
        "document.dispatchEvent(new PointerEvent('pointerup',at(r.left+r.width/2+40,r.top+r.height/2+25)));" +
        "return 'dragged from ' + Math.round(r.left) + ',' + Math.round(r.top);})()",
    });
    const movedRecorded = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-edits li, .sasha-edit').length > 0",
    });
    const editsListed = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-edits li, .sasha-edit')].map(e=>e.textContent).slice(0,3))",
    });
    check({
      failures,
      what: "and dragging the selection records a visual edit",
      ok: movedRecorded,
      detail: `${dragged}; edits ${editsListed}`,
    });

    // --- THE ANNOTATE TOOL POINTS AT ELEMENTS -----------------------------------------------
    // It used to be a rectangle dragged over the slide, with the note typed into a row in a list
    // somewhere below. It now behaves like Claude's own artifact comments: the same hover and
    // click the select tool uses, and a composer that opens ON the thing that was clicked.
    await click({ client, selector: ".sasha-toolrail button:nth-of-type(2)" });
    const noDragSurface = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-editor-stage .sasha-overlay').length === 0",
    });
    check({
      failures,
      what: "annotate does NOT put a drag surface over a live document",
      ok: noDragSurface,
      detail: "a transparent overlay would swallow every click the selection needs",
    });

    // CLICK A REAL ELEMENT and the composer opens on it.
    const annotated = await evaluateString({
      client,
      expression:
        "(function(){" +
        "var f=document.querySelector('.sasha-editor-stage iframe.sasha-frame');" +
        "if(!f||!f.contentDocument)return 'no reachable frame';" +
        "var el=f.contentDocument.querySelector('h1,h2,p,div');" +
        "if(!el)return 'nothing to select';" +
        "var box=el.getBoundingClientRect();" +
        "var opts={bubbles:true,cancelable:true,composed:true,clientX:box.left+box.width/2," +
        "clientY:box.top+box.height/2,pointerType:'mouse',button:0,pointerId:1,isPrimary:true};" +
        "el.dispatchEvent(new PointerEvent('pointerdown',opts));" +
        "el.dispatchEvent(new PointerEvent('pointerup',opts));" +
        "return el.tagName;})()",
    });
    const composerOpen = await pollFor({ client, expression: "!!document.querySelector('.sasha-spot')" });
    const composerWhere = await evaluateString({
      client,
      expression:
        "(function(){var c=document.querySelector('.sasha-spot');" +
        "if(!c)return 'no composer';var stage=c.parentElement.getBoundingClientRect();" +
        "var box=c.getBoundingClientRect();" +
        "return 'side=' + c.dataset.side + ' insideStage=' + (box.left >= stage.left - 1 &&" +
        " box.right <= stage.right + 1 && box.top >= stage.top - 1 && box.bottom <= stage.bottom + 1);})()",
    });
    check({
      failures,
      what: "clicking an element with annotate opens a composer anchored to it",
      ok: composerOpen && /insideStage=true/.test(composerWhere),
      detail: `clicked ${annotated}; ${composerWhere}`,
    });

    // AND THE EDIT CHROME IS NOT THERE. Comment mode selects, it does not resize or recolour.
    // NOT IN THE DOCUMENT, not merely `hidden`: `.sasha-ed-bar` sets `display: flex`, which beats
    // the user agent's `[hidden] { display: none }` -- measured, with the bar plainly on screen
    // while reporting `hidden === true`.
    const editChrome = await evaluateNumber({
      client,
      expression:
        "document.querySelectorAll('.sasha-ed-handle').length" +
        " + document.querySelectorAll('.sasha-ed-bar').length",
    });
    check({
      failures,
      what: "and comment mode puts no resize handles or edit bar in the document",
      ok: editChrome === 0,
      detail: `${editChrome} edit controls still in the tree`,
    });

    // --- REVIEW IS PRE-INSERT: A COMMENT GOES TO THE CANDIDATE -------------------------------
    const blockedSend = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-spot-acts .sasha-primary[disabled]').length",
    });
    check({
      failures,
      what: "a comment with no words cannot be sent -- an empty comment says nothing",
      ok: blockedSend > 0,
      detail: `${blockedSend} disabled`,
    });

    // ESCAPE GIVES THE SLIDE BACK, which is the other half of a composer that opens on a click.
    await typeInto({ client, selector: ".sasha-spot-note", text: "x" });
    await client.Runtime.evaluate({
      expression:
        "document.querySelector('.sasha-spot-note')" +
        ".dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
      returnByValue: true,
      awaitPromise: false,
    });
    const escaped = await pollFor({ client, expression: "!document.querySelector('.sasha-spot')" });
    check({ failures, what: "Escape dismisses the composer without commenting", ok: escaped });
    const nothingSent = await evaluateNumber({
      client,
      expression: "Object.keys(window.__SASHA_FILE_COMMENTS__||{}).length",
    });
    check({
      failures,
      what: "and a dismissed composer writes nothing",
      ok: nothingSent === 0,
      detail: `${nothingSent} comment targets`,
    });

    const chromeState = await evaluateString({
      client,
      expression:
        "JSON.stringify({roots: document.querySelectorAll('.sasha-ed-root').length," +
        " bars: [...document.querySelectorAll('.sasha-ed-bar')].map(b=>b.hidden)," +
        " handles: [...document.querySelectorAll('.sasha-ed-handle')].map(h=>h.hidden)})",
    });
    process.stdout.write(`      editor chrome: ${chromeState}\n`);

    // SELECT AGAIN AND ACTUALLY COMMENT.
    await evaluateString({
      client,
      expression:
        "(function(){" +
        "var f=document.querySelector('.sasha-editor-stage iframe.sasha-frame');" +
        "var el=f.contentDocument.querySelector('h1,h2,p,div');" +
        "var box=el.getBoundingClientRect();" +
        "var opts={bubbles:true,cancelable:true,composed:true,clientX:box.left+box.width/2," +
        "clientY:box.top+box.height/2,pointerType:'mouse',button:0,pointerId:1,isPrimary:true};" +
        "el.dispatchEvent(new PointerEvent('pointerdown',opts));" +
        "el.dispatchEvent(new PointerEvent('pointerup',opts));" +
        "return el.tagName;})()",
    });
    const reselect = await evaluateString({
      client,
      expression:
        "(function(){var c=document.querySelector('.sasha-spot');" +
        "var sel=document.querySelector('.sasha-ed-select');" +
        "var hint=document.querySelector('.sasha-editor-say');" +
        "return JSON.stringify({composer: !!c," +
        " selBox: sel? sel.style.display : 'none in dom'," +
        " hint: hint? (hint.textContent||'').slice(0,46) : '-'});})()",
    });
    process.stdout.write(`      after re-click: ${reselect}\n`);
    await pollFor({ client, expression: "!!document.querySelector('.sasha-spot')" });
    await typeInto({ client, selector: ".sasha-spot-note", text: "the gridlines are gone" });
    await client.Page.captureScreenshot({ format: "png" }).then((shot) =>
      writeFileSync(COMPOSER_SHOT, Buffer.from(shot.data, "base64")),
    );
    process.stdout.write(`      composer screenshot: ${COMPOSER_SHOT}\n`);
    const beforeComment = await evaluateString({
      client,
      expression:
        "(function(){var n=document.querySelector('.sasha-spot-note');" +
        "var b=[...document.querySelectorAll('.sasha-spot-acts button')].map(x=>x.textContent+':'+(x.disabled?'off':'on'));" +
        "return JSON.stringify({note:n?n.value:'<none>', buttons:b});})()",
    });
    process.stdout.write(`      composer before Comment: ${beforeComment}\n`);
    await clickLabelled({ client, within: ".sasha-spot-acts", startsWith: "Comment" });
    const afterComment = await evaluateString({
      client,
      expression:
        "JSON.stringify({targets:Object.keys(window.__SASHA_FILE_COMMENTS__||{})," +
        " rows:[...document.querySelectorAll('.sasha-anomaly')].map(r=>(r.textContent||'').slice(0,90))," +
        " trouble:[...document.querySelectorAll('.sasha-trouble')].map(t=>(t.textContent||'').slice(0,90))})",
    });
    process.stdout.write(`      after Comment: ${afterComment}\n`);
    const onCandidate = await pollFor({ client, expression: "!!(window.__SASHA_FILE_COMMENTS__||{}).html_1" });
    check({ failures, what: "Comment posted it on the CANDIDATE, not on the deck", ok: onCandidate });

    // COMMENTING CLOSES THE COMPOSER: the thought is finished and the slide comes back.
    const closedAfter = await pollFor({ client, expression: "!document.querySelector('.sasha-spot')" });
    check({ failures, what: "and the composer closes once the comment is away", ok: closedAfter });

    // The comment's BODY, not a JSON wrapper around it: stringifying the record escapes every
    // quote, so `"region":{"x"` would not appear in it and the assertion would be vacuous.
    const candidateComment = await evaluateString({
      client,
      expression: "(((window.__SASHA_FILE_COMMENTS__||{}).html_1||[{}])[0]||{}).content||''",
    });
    check({
      failures,
      what: "and it carries the words and the clicked element own 0-1 region",
      ok: /the gridlines are gone/.test(candidateComment) && /"region":\{"x":/.test(candidateComment),
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
      ok: rowsFit > 0,
      detail: `${rowsFit} rows`,
    });

    await client.Page.captureScreenshot({ format: "png" }).then((shot) =>
      writeFileSync(MARKUP_SHOT, Buffer.from(shot.data, "base64")),
    );
    process.stdout.write(`      mark-up screenshot: ${MARKUP_SHOT}\n`);

    // A SENT MARK-UP IS NOT UNSENT WORK, so closing over it asks nothing.
    await click({ client, selector: ".sasha-editor-close" });
    const back = await pollFor({ client, expression: "!document.querySelector('.sasha-editor-scrim')" });
    check({ failures, what: "and a sent mark-up closes the editor without a question", ok: back });

    // --- THE CONVERTED PANE -----------------------------------------------------------------
    // The rendered pane only exists once the REAL converter has run in the page: choose it in the
    // SHOWING group and wait for a preview box. This is the end-to-end proof that the extractor
    // survived base64 + HtmlService-shaped inlining and ran under a no-eval CSP.
    //
    // The group matters. "One slide" and "Converted slide" both say "slide", so the old
    // text-matching click took the view button and silently never converted anything.
    await chooseIn({ client, group: "showing", label: "Converted" });
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
    // EITHER SHAPE COUNTS: Google's picture, or the labelled projection for one it refused. What
    // must NOT be left is an HTML iframe -- the choice belongs to the window, so all N switch
    // together or the user is comparing two different kinds of thing (slide-stage.tsx).
    const allConverted = await evaluateNumber({
      client,
      expression:
        "document.querySelectorAll('.sasha-cell-stage img.sasha-render, .sasha-cell-stage .sasha-rendered').length",
    });
    const leftoverFrames = await evaluateNumber({ client, expression: "document.querySelectorAll('iframe.sasha-frame').length" });
    check({
      failures,
      what: `all ${COUNT} cells show the conversion, and none is still showing HTML`,
      ok: allConverted === COUNT && leftoverFrames === 0,
      detail: `${allConverted} converted, ${leftoverFrames} frames left`,
    });

    // --- AND "CONVERTED" IS A PICTURE, NOT A DIAGRAM ----------------------------------------
    // The pane used to draw labelled rectangles -- the geometry the converter ASKED for -- and
    // call that "Converted". It was read as "the converter is broken" because a diagram of boxes
    // is not a rendering. It now shows Google's own PNG of a throwaway deck.
    const rendered = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-cell-stage img.sasha-render').length > 0",
    });
    const renderCalls = await evaluateNumber({ client, expression: "window.__SASHA_RENDER_CALLS__ || 0" });
    const renderedIndices = await evaluateString({
      client,
      expression: "JSON.stringify(window.__SASHA_RENDERED__ || [])",
    });
    check({
      failures,
      what: "the converted pane shows Google's own picture of the candidate",
      ok: rendered,
      detail: `${renderCalls} call(s), asked for ${renderedIndices}`,
    });

    // ONE CALL FOR THE WHOLE SET. The server builds one throwaway deck for all the candidates, so
    // a call per candidate would be N decks, N deletes and N round trips for the same pictures.
    check({
      failures,
      what: "and it asked once, for every candidate at once",
      ok: renderCalls === 1 && renderedIndices === JSON.stringify([1, 2, 3]),
      detail: `${renderCalls} call(s), asked for ${renderedIndices}`,
    });

    // A CANDIDATE GOOGLE REFUSED falls back to the projection WITH THE REASON ON IT, never to an
    // empty box and never to a diagram the user could mistake for the rendering.
    const refusedNote = await evaluateString({
      client,
      expression:
        "((document.querySelectorAll('.sasha-cell')[1]||{}).querySelector? " +
        "(document.querySelectorAll('.sasha-cell')[1].querySelector('.sasha-projection-note')||{}).textContent||'' : '')",
    });
    check({
      failures,
      what: "a candidate Google refused says so, over the geometry projection",
      ok: /Slides refused this one/.test(refusedNote),
      detail: JSON.stringify(refusedNote.slice(0, 160)),
    });

    // --- THE EDITOR OVER THE CONVERTED RENDERING -------------------------------------------
    // The rendering is the WINDOW's choice and the editor opens on top of it, so this pair is
    // reachable -- and it is the one where the editor CANNOT work: an edit edits the HTML, never
    // the conversion. The slot has to say so rather than sit there as a grey box.
    await click({ client, selector: '[aria-label="Open option 1 to request changes"]' });
    const refusedReach = await pollFor({
      client,
      expression: "!!document.querySelector('.sasha-editslot .sasha-trouble')",
    });
    const reachSaid = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-editslot .sasha-trouble')||{}).textContent||''",
    });
    check({
      failures,
      what: "the editor over the CONVERTED rendering says why it cannot work, instead of sitting empty",
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

    // --- AND THE RECTANGLE IS STILL THERE WHERE THERE IS NOTHING TO CLICK -------------------
    // The converted rendering is a picture, so "this part" can only be said with a box. Annotate
    // falls back to the drag surface there, and it must still produce a real mark-up.
    await click({ client, selector: ".sasha-toolrail button:nth-of-type(2)" });
    const fallbackSurface = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-editor-stage .sasha-overlay').length === 1",
    });
    check({
      failures,
      what: "over a picture, annotate falls back to the drag rectangle",
      ok: fallbackSurface,
      detail: "nothing to point at, so a box is the only way to say 'this part'",
    });
    const fallbackReady = await pollFor({
      client,
      expression:
        "(function(){var o=document.querySelector('.sasha-editor-stage .sasha-overlay');" +
        "return !!o && o.getBoundingClientRect().height > 100;})()",
    });
    check({ failures, what: "and the stage has its real height before the gesture", ok: fallbackReady });
    await drag({
      client,
      selector: ".sasha-editor-stage .sasha-overlay",
      until: "document.querySelectorAll('.sasha-mark-user').length > 0",
    });
    const fallbackMarked = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-mark-user').length > 0",
    });
    check({ failures, what: "dragging over the picture still records a mark-up", ok: fallbackMarked });
    await click({ client, selector: ".sasha-toolrail button:nth-of-type(1)" });

    await click({ client, selector: ".sasha-editor-close" });
    await pollFor({ client, expression: "!document.querySelector('.sasha-editor-scrim')" });
    await chooseIn({ client, group: "showing", label: "Preview" });
    await pollFor({ client, expression: `document.querySelectorAll('iframe.sasha-frame').length === ${COUNT}` });

    // --- THE DEFECT REPORT IS A WINDOW OF ITS OWN -------------------------------------------
    // THE ENTRY IS UNDER EVERY SLIDE, which is what removed the last "option N" button from the
    // window's footer: a defect is reported about ONE candidate, and the one being pointed at is
    // the one under the cursor. It must not be possible to lose the route silently.
    const reportEntries = await evaluateNumber({
      client,
      expression:
        "[...document.querySelectorAll('.sasha-cell-foot button')]" +
        ".filter(b=>(b.textContent||'') === 'Report defect').length",
    });
    check({
      failures,
      what: `every candidate carries its own route to the defect window (${COUNT} of them)`,
      ok: reportEntries === COUNT,
      detail: `${reportEntries} report buttons`,
    });

    await clickLabelled({ client, within: ".sasha-cell:first-child .sasha-cell-foot", startsWith: "Report defect" });
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

    // --- "NONE OF THESE" REALLY ANSWERS THE SERVER ------------------------------------------
    // LAST, because it SETTLES the picker: the grid is replaced by the settled panel, so every
    // check above has to have run already. Rendering the button proves nothing -- what matters is
    // that it writes `PICK {picked: null}`, which is the value a waiting `await_pick` is blocked
    // on (dialog.tsx `submit`, pick-writer.ts).
    await click({ client, selector: ".sasha-toolbar .sasha-none" });
    // THE STUB RECORDS THE FILE SPEC, not the decision: `picked` lives inside the JSON `body`
    // string that pick-writer.ts composed, which is the thing the server actually reads.
    const dismissed = await pollFor({
      client,
      expression:
        "(function(){var spec=window.__SASHA_PICK__;if(!spec||typeof spec.body!=='string')return false;" +
        "try{return JSON.parse(spec.body).picked === null;}catch(_){return false;}})()",
    });
    const pickWritten = await evaluateString({
      client,
      expression: "((window.__SASHA_PICK__||{}).body)||'<nothing written>'",
    });
    check({
      failures,
      what: "\"None of these\" writes PICK with picked: null, so the agent is not left waiting",
      ok: dismissed,
      detail: pickWritten.slice(0, 200),
    });

    const settled = await pollFor({ client, expression: "!document.querySelector('.sasha-grid')" });
    check({ failures, what: "and the window says what Sasha was told", ok: settled });

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

    // THE WAY BACK IS THE CANDIDATES CARD, not a header button: it names what it will show, and
    // the header is the title and nothing else now.
    const button = await pollFor({
      client,
      expression:
        "[...document.querySelectorAll('button')].some(e=>(e.textContent||'')==='Open artifacts'&&!e.disabled)",
    });
    check({ failures, what: "and the way back to the slides stays live -- the candidates card", ok: button });
    const noHeaderButtons = await evaluateNumber({
      client,
      expression: "document.querySelectorAll('.sasha-header button').length",
    });
    check({
      failures,
      what: "the header carries no buttons, so the spinner cannot push one to a second row",
      ok: noHeaderButtons === 0,
      detail: `${noHeaderButtons} buttons in the header`,
    });

    // --- ONLY THE CONNECTION AND THE ASSETS ---------------------------------------------------
    // The conversation moved to the deck's own comments, which the comment bot answers. The side
    // panel is the header, the connection with the assistant, and the candidates -- and none of
    // the old conversation UI may come back in the real cascade either.
    const header = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-chat .sasha-header')||{}).textContent||''",
    });
    check({ failures, what: "the header is Ask Sasha", ok: /Ask Sasha/.test(header), detail: header.slice(0, 80) });

    // The canned log is dated 2026-10-04, so its evidence is stale and the setup guide shows; a
    // fresher fixture would show the status line instead. Exactly one of the two, never both.
    const connection = await evaluateString({
      client,
      expression:
        "JSON.stringify({guide:!!document.querySelector('.sasha-nobody-listening')," +
        "line:!!document.querySelector('.sasha-connection')})",
    });
    check({
      failures,
      what: "the connection is ONE thing: the setup guide or the status line",
      ok: connection === JSON.stringify({ guide: true, line: false }) || connection === JSON.stringify({ guide: false, line: true }),
      detail: connection,
    });

    const leftovers = await evaluateString({
      client,
      expression:
        "JSON.stringify({containers:document.querySelectorAll('.sasha-comments, .sasha-msgs, .sasha-ask, .sasha-activity, .sasha-reportentry, textarea').length," +
        "words:['Activity','Report a defect','Not done','Marked as done'].filter(function(w){" +
        // THE PANEL'S text, not the body's: the bundle ships in a script element, and React's own
        // source says 'Activity'.
        "return ((document.getElementById('sasha-slides-root')||{}).textContent||'').indexOf(w)>=0;})," +
        "send:[...document.querySelectorAll('button')].some(function(b){return (b.textContent||'')==='Send';})})",
    });
    check({
      failures,
      what: "no comments panel, activity log, composer or defect-report entry",
      ok: leftovers === JSON.stringify({ containers: 0, words: [], send: false }),
      detail: leftovers,
    });

    // --- THE SET ----------------------------------------------------------------------------
    const artifact = await pollFor({ client, expression: "!!document.querySelector('.sasha-artifact')" });
    check({ failures, what: "the candidate set has a card of its own", ok: artifact });

    const stacked = await evaluateString({
      client,
      expression:
        "JSON.stringify([...document.querySelectorAll('.sasha-stack-slide')]" +
        ".map(function(li){var b=li.getBoundingClientRect();return [Math.round(b.top), Math.round(b.left)];}))",
    });
    const rows = JSON.parse(stacked) as readonly (readonly number[])[];
    check({
      failures,
      what: "and the candidates are stacked VERTICALLY, one under the other",
      ok:
        rows.length > 1 &&
        rows.every((row, at) => at === 0 || (row[0] ?? 0) > (rows[at - 1]?.[0] ?? 0)) &&
        new Set(rows.map((row) => row[1])).size === 1,
      detail: stacked,
    });

    const openAll = await evaluateNumber({
      client,
      expression:
        "[...document.querySelectorAll('.sasha-artifact button')]" +
        ".filter(function(b){return (b.textContent||'')==='Open artifacts';}).length",
    });
    check({
      failures,
      what: "with one button that opens the whole set",
      ok: openAll === 1,
      detail: `${openAll} buttons`,
    });

    // A CANDIDATE'S OWN OPEN names the proposal AND the slide, so the window lands on it.
    await click({ client, selector: ".sasha-stack-slide:nth-child(2) .sasha-stack-actions button" });
    const target = await pollFor({
      client,
      expression:
        "!!window.__SASHA_PICKER_TARGET__ && window.__SASHA_PICKER_TARGET__.slideIndex === 2",
    });
    const targetSaid = await evaluateString({
      client,
      expression: "JSON.stringify(window.__SASHA_PICKER_TARGET__ || null)",
    });
    check({
      failures,
      what: "opening a candidate names the proposal AND the slide",
      ok: target,
      detail: targetSaid,
    });

    // THE WHOLE COLUMN, not the first viewport of it.
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
    const sidebarShot = await client.Page.captureScreenshot({ format: "png", captureBeyondViewport: true });
    writeFileSync(SIDEBAR_SHOT, Buffer.from(sidebarShot.data, "base64"));
    process.stdout.write(`      Ask Sasha screenshot: ${SIDEBAR_SHOT} (${tall}px tall)\n`);

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

    // NO NOTE CLAIMS THE TEXT WENT TO A MODEL. The anonymiser's sentences are rendered word for
    // word, and none of them may say a slide's text was sent anywhere -- nothing was; the stub's
    // `__SASHA_REWRITE__` tripwire below is what proves that.
    const caveat = await evaluateString({
      client,
      expression: "(document.querySelector('.sasha-annots')||{}).textContent||''",
    });
    check({
      failures,
      what: "and no note claims the slide's text was sent to a model",
      ok: caveat !== "" && !/asking a model|sends this slide|was sent to/i.test(caveat),
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
/** How long the seeded sidebar's server takes to answer anything: long enough to see the seed alone. */
const SEEDED_ANSWER_DELAY_MS = 3_000;

/**
 * ASK SASHA AS showSidebar SERVES IT WITH A SEED (sidebar-seed.ts): the same stubbed page, a slow
 * server, and the inert seed element appended after the document exactly as HtmlOutput.append
 * puts it. The remembered reads are for the stub's own deck and proposal.
 */
function seededSidebar(): string {
  const remembered = (value: unknown): unknown => ({
    presentationId: "deck_smoke_0123456789",
    readAt: new Date().toISOString(),
    value,
  });
  const slides = Array.from({ length: COUNT }, (_, at) => ({
    index: at + 1,
    fileId: `html_${at + 1}`,
    name: `0${at + 1}.html`,
    label: `option ${at + 1}`,
  }));
  const manifest = {
    protocolVersion: 1,
    proposalId: PROPOSAL_ID,
    createdAt: "2026-10-03T12:00:00.000Z",
    presentationId: "deck_smoke_0123456789",
    count: COUNT,
    slides,
    revision: 2,
  };
  const boot = {
    hello: { protocolVersion: 1, presentationUrl: "https://docs.google.com/presentation/d/deck_smoke_0123456789/edit" },
    remembered: {
      scan: remembered({
        marks: [
          {
            proposalId: PROPOSAL_ID,
            folderId: "folder_1",
            readyFileId: "ready",
            pickFileId: null,
            manifestFileId: "manifest",
            createdTime: "2026-10-03T12:00:00.000Z",
          },
        ],
      }),
      manifest: remembered({ forEventId: null, texts: [{ fileId: "manifest", text: JSON.stringify(manifest) }] }),
      log: remembered({ folderId: "folder_1", events: [] }),
    },
  };
  const element =
    `<script type="text/plain" id="sasha-sidebar-seed">` + JSON.stringify(boot).replace(/</g, "\\u003c") + `</script>`;
  // After the page's OWN <head>, the first one: the stub that follows carries candidate documents
  // with heads of their own inside a string.
  return stubbed(SIDEBAR_FILE).replace(
    "<head>",
    `<head>\n<script>window.__SASHA_ANSWER_DELAY_MS__ = ${SEEDED_ANSWER_DELAY_MS};</script>`,
  ) + element;
}

/**
 * THE SEEDED BOOT IN A REAL PAGE: the candidates are drawn before any server call has answered,
 * no sashaHello is sent, the scan and the log read go out together, and "Updating" goes away once
 * the fresh reads land.
 */
async function driveSeededSidebar({ failures }: { failures: string[] }): Promise<void> {
  const tab = await CDP.New({ port: CDP_PORT, url: `http://127.0.0.1:${PORT}/sidebar-seeded.html` });
  let client: CdpClient | null = null;
  try {
    client = await CDP({ target: tab, port: CDP_PORT });
    const { Runtime, Page } = client;
    await Page.enable();
    await Runtime.enable();
    const errors: string[] = [];
    client.on("Runtime.exceptionThrown", (params: unknown) => errors.push(JSON.stringify(params).slice(0, 400)));
    const drawn = await pollFor({
      client,
      expression: "document.querySelectorAll('.sasha-stack-slide').length === " + String(COUNT),
    });
    const early = await evaluateString({
      client,
      expression:
        "JSON.stringify({calls:window.__SASHA_CALLS__||[],answered:window.__SASHA_ANSWERED__||0," +
        "updating:!!document.querySelector('.sasha-header-refreshing'),spinner:!!document.querySelector('.sasha-opening')})",
    });
    const seen = JSON.parse(early) as Readonly<{ calls: readonly string[]; answered: number; updating: boolean; spinner: boolean }>;
    check({
      failures,
      what: "SEEDED: the candidates are drawn before any server call has answered",
      ok: drawn && seen.answered === 0,
      detail: early,
    });
    check({
      failures,
      what: "SEEDED: no sashaHello, the scan and the log read already out, marked Updating, no spinner",
      ok:
        !seen.calls.includes("sashaHello") &&
        seen.calls.includes("sashaScanInbox") &&
        seen.calls.includes("sashaReadEvents") &&
        seen.updating &&
        !seen.spinner,
      detail: early,
    });
    check({
      failures,
      what: "SEEDED: the comment access check is out with the other boot reads, before any answer",
      ok: seen.calls.includes("sashaCommentAccess") && seen.answered === 0,
      detail: early,
    });
    const settled = await pollFor({ client, expression: "!document.querySelector('.sasha-header-refreshing')" });
    check({ failures, what: "SEEDED: Updating goes away once the fresh reads land", ok: settled });
    const allow = await pollFor({
      client,
      expression:
        "(function(){var link=document.querySelector('.sasha-comment-access-allow');" +
        "return !!link&&link.target==='_blank'&&link.href.indexOf('/comments/allow?deck=deck_smoke_0123456789')>0&&link.textContent==='Allow';})()",
    });
    check({ failures, what: "the needsAllow answer draws the card with an Allow link that opens a new tab", ok: allow });
    for (const error of errors) failures.push(`seeded sidebar uncaught: ${error}`);
  } finally {
    if (client !== null) await client.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
  }
}

function stubbed(file: string): string {
  const page = readFileSync(file, "utf-8");
  if (!page.includes("<script>")) throw new Error(`${file} has no inline bundle -- run build-addon.ts first`);
  return page.replace("</head>", `${STUB_SCRIPT}\n</head>`);
}

/**
 * The stub. It is injected ahead of each bundle and defines exactly the functions Code.gs
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
  // THE SEEDED COMMENT IS A MINUTE OLD, NOT A FIXED DATE: anything judged against the delivery
  // threshold (waiting.ts) must not pass in the morning and fail every evening.
  var SEEDED_AT = new Date(Date.now() - 60000).toISOString();
  // How the connector signs its posts (agent-marker.ts), so Sasha's answers render as Sasha's.
  var AGENT = ${JSON.stringify(AGENT_REPLY_MARKER)};
  var DECK = 'deck_smoke_0123456789';
  var COUNT = ${COUNT};
  // THE CANNED SESSION LOG. Real file names (<millis>-<6 base36>-<kind>.json), real bodies, and a
  // final event whose kind this build has never heard of -- which must render as an opaque line.
  // A 1x1 transparent PNG: a real picture, so the stage renders an <img> rather than a broken one.
  var SMOKE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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
    // The connector's answer for a deck the user has not chosen in the picker yet.
    sashaCommentAccess: function () {
      return { access: 'needsAllow', allowUrl: 'https://sashaslides.com/comments/allow?deck=deck_smoke_0123456789' };
    },
    sashaScanInbox: function () {
      return { marks: [{ proposalId: PROPOSAL, folderId: 'folder_1', readyFileId: 'ready',
                         pickFileId: null, manifestFileId: 'manifest', createdTime: '2026-10-03T12:00:00.000Z' }] };
    },
    sashaReadText: function (spec) {
      var text = spec.fileId === 'ready' ? texts.ready : spec.fileId === 'manifest' ? texts.manifest : html[spec.fileId];
      if (text === undefined) throw new Error('no such file ' + spec.fileId);
      return { text: text };
    },
    // The batch: each file answers on its own, exactly as Code.gs's fetchAll does.
    sashaReadTexts: function (spec) {
      window.__SASHA_BATCH_READS__ = (window.__SASHA_BATCH_READS__ || 0) + 1;
      return { texts: spec.fileIds.map(function (fileId) {
        var text = fileId === 'ready' ? texts.ready : fileId === 'manifest' ? texts.manifest : html[fileId];
        return text === undefined ? { fileId: fileId, error: 'HTTP 404' } : { fileId: fileId, text: text };
      }) };
    },
    sashaInsert: function () { return { batchResponse: { replies: [{ createSlide: { objectId: 'sasha_smoke' } }] }, insertionIndex: null }; },
    sashaWriteRender: function (spec) { return { renderArtifact: spec.render.fileName }; },
    // THE THROWAWAY-DECK RENDER, stubbed. A real one creates a presentation, photographs each
    // page and deletes it; what this surface has to prove is that the picture REACHES the stage
    // and replaces the geometry projection. Candidate 2 answers with a reason instead of a
    // picture, so the fallback path is exercised in the same run.
    sashaRenderPreviews: function (spec) {
      window.__SASHA_RENDER_CALLS__ = (window.__SASHA_RENDER_CALLS__ || 0) + 1;
      window.__SASHA_RENDERED__ = spec.slides.map(function (slide) { return slide.index; });
      return {
        previews: spec.slides.map(function (slide) {
          return slide.index === 2
            ? { index: slide.index, dataUri: null, message: 'Slides refused this one' }
            : { index: slide.index, dataUri: SMOKE_PNG, message: null };
        }),
      };
    },
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
    // what __SASHA_FEEDBACK__ means to the checks below, and the anonymiser's REWRITE REQUEST would
    // also be a comment on this deck. Stashing both in one global made the review assertion read
    // the rewrite prompt. __SASHA_SENT__ accumulates everything a real comment pane would hold.
    sashaSendFeedback: function (spec) {
      // PER FILE, because that is the whole point: a mark-up goes on the CANDIDATE, through this
      // one function, told apart from anything else only by the file id.
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
    // ANSWERING A THREAD FROM THE THREAD RAIL. Both are a reply on whichever file the thread lives
    // on, recorded per file and comment so the next read brings the post back into the same card.
    sashaReplyToComment: function (spec) { return postReply(spec, null); },
    sashaResolveComment: function (spec) { return postReply(spec, 'resolve'); },
    // The surface split's three. In production these call showModelessDialog; here they only have
    // to answer the way Code.gs does, because what is under test is that the caller READS the
    // answer rather than assuming the window appeared -- and that the report target is RECORDED,
    // which is the only channel between two documents that share nothing.
    sashaOpenPicker: function (spec) {
      window.__SASHA_OPENED__ = true;
      window.__SASHA_OPEN_COUNT__ = (window.__SASHA_OPEN_COUNT__ || 0) + 1;
      // What the sidebar asked the window to come up on, which is the whole point of the target.
      window.__SASHA_PICKER_TARGET__ = spec || null;
      return { opened: true };
    },
    sashaTakePickerTarget: function () { return { proposalId: null, slideIndex: null }; },
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

  /** One post into an existing thread, as Drive would keep it. A resolve is a reply too. */
  function postReply(spec, action) {
    var key = spec.fileId + '/' + spec.commentId;
    var store = window.__SASHA_REPLIES__ = window.__SASHA_REPLIES__ || {};
    var list = store[key] = store[key] || [];
    var reply = {
      id: 'ur_' + list.length + '_' + spec.commentId,
      content: action === 'resolve' && !spec.text ? 'Resolved.' : spec.text,
      createdTime: new Date().toISOString(),
      author: { displayName: 'Krunoslav' }
    };
    list.push(reply);
    window.__SASHA_REPLY_CALLS__ = (window.__SASHA_REPLY_CALLS__ || [])
      .concat([{ fileId: spec.fileId, commentId: spec.commentId, text: spec.text, action: action }]);
    if (action === 'resolve') {
      window.__SASHA_RESOLVED__ = window.__SASHA_RESOLVED__ || {};
      window.__SASHA_RESOLVED__[key] = true;
    }
    return { replyId: reply.id };
  }
  function repliesOn(fileId, commentId) { return (window.__SASHA_REPLIES__ || {})[fileId + '/' + commentId] || []; }
  function isResolved(fileId, commentId) { return !!(window.__SASHA_RESOLVED__ || {})[fileId + '/' + commentId]; }

  /** The comments already on a candidate, plus whatever this page has posted onto it. */
  function threadsOn(fileId) {
    var seeded = fileId === 'html_2' ? [{
      id: 'cc_open',
      content: 'the gridlines are gone\\n\\nsasha-slides-feedback=' + JSON.stringify({
        protocolVersion: 1, noteId: 'box_seed', pageObjectId: null,
        region: { x: 0.12, y: 0.4, w: 0.5, h: 0.3 }, createdAt: SEEDED_AT
      }),
      createdTime: SEEDED_AT,
      resolved: isResolved(fileId, 'cc_open'),
      author: { displayName: 'Krunoslav' },
      // Sasha has answered but not resolved, so the thread is open WITH a nested reply -- the
      // shape of the user's reference card.
      replies: [{
        id: 'cc_open_r1', content: 'redrawn with the gridlines back\\n\\n' + AGENT,
        createdTime: SEEDED_AT, author: { displayName: 'Krunoslav' }
      }].concat(repliesOn(fileId, 'cc_open'))
    }] : [];
    var posted = ((window.__SASHA_FILE_COMMENTS__ || {})[fileId] || []).map(function (comment, at) {
      return {
        id: 'cc_' + fileId + '_' + at,
        content: comment.content,
        createdTime: '2026-10-04T12:20:0' + at + 'Z',
        resolved: isResolved(fileId, 'cc_' + fileId + '_' + at),
        author: { displayName: 'Krunoslav' },
        replies: repliesOn(fileId, 'cc_' + fileId + '_' + at)
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

  // isRewriteRequest above is a TRIPWIRE: the anonymiser's model-assisted mode is withdrawn, so if
  // the report window ever sends the slide's own words down the comment channel again,
  // __SASHA_REWRITE__ is set and the report surface's "nothing here goes to a model" check fails --
  // the only way a test can hold a privacy claim to account. (No backticks anywhere in this stub:
  // the whole stub IS a template literal, and one closes it mid-comment.)
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
        // RECORDED, and optionally SLOW: the seeded sidebar page sets a delay so its first paint
        // can be checked before any answer has landed, and the record is what proves which calls
        // the boot made at all.
        (window.__SASHA_CALLS__ = window.__SASHA_CALLS__ || []).push(name);
        setTimeout(function () {
          window.__SASHA_ANSWERED__ = (window.__SASHA_ANSWERED__ || 0) + 1;
          try { if (onSuccess) onSuccess(answers[name](spec)); }
          catch (error) { if (onFailure) onFailure(error); }
        }, window.__SASHA_ANSWER_DELAY_MS__ || 0);
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
 * By text, because the row it is in holds several buttons of the same class: a cell's footer has
 * Report defect, Insert before and Insert after, and a class selector there would press whichever came
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

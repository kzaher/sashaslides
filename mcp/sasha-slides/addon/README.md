# sasha-slides — Google Slides add-on

The candidate-slide product from `mcp/sasha-slides/PROTOCOL.md`, as an Apps Script add-on — see
`../UI-CONTRACT.md`, which is the contract and is changed before any component is.

**The Slides menu has exactly ONE item: Ask Sasha.** A menu that lists surfaces makes the user
assemble the product themselves; "open the conversation" and "candidate slides" were two halves of
one thing. Everything else is opened *by* the conversation.

| surface | opened by | file | what it is for |
| --- | --- | --- | --- |
| **Ask Sasha** (sidebar) | the one menu item, `showSidebar` | `Sidebar.html` ← `src/sidebar.tsx` | the **spine**: the session as a serialized event log — slides staged, a comment you opened, Sasha's answer, a **revised slide rendered inline**, a resolution, a clear, an insertion — plus the composer. It is the only surface that is always there. |
| **the slides** | a button in Ask Sasha, and **automatically when slides arrive** | `Dialog.html` ← `src/dialog.tsx` | **the editor.** Two independent axes: a **view** (*all candidates* in a two-column grid, or *one slide* large) and a **tool** (*edit*, the default, or *annotate*). All four combinations are legal — annotate from the grid, edit one slide large — because a view is a zoom level and a tool is a choice, and neither is a screen. Each cell carries its **unresolved comment count**; a note sent from the annotate tool becomes a Drive comment on that candidate. |
| **the defect report** | a button in either of the others | `Report.html` ← `src/report.tsx` | **the same editor, showing two slides**: the candidate as it is and as it will be sent, both rendered, with the anonymiser's verdicts as numbered annotations pinned to the slide they are about. Edit the title, edit either slide, send. **Its own document, for the size** — see Known limits. |

MODELESS, not modal: a modal dialog freezes the deck behind it, and the whole point is comparing a
candidate against the deck it is going into. It also leaves the sidebar usable while it is open.

The slides window watches the user's Drive for `READY` markers the MCP server wrote, shows the
candidates (HTML first, rendered slide second), converts the chosen one to native Slides elements
client-side, inserts it, writes `PICK` and appends a `slide-inserted` event. Ask Sasha reads the
`events/` folder and the candidates' own comment threads, and sends what the user types as a native
Slides comment.

**Review happens BEFORE inserting, on the candidates.** A mark-up Sent from the slides window
becomes a native Drive comment on that candidate's `NN.html` — not on a deck page — which is what
lets Sasha answer it, resolve it and revise the slide. The old post-insert "review this deck" mode
was **removed outright**, not demoted: marking up a slide already in the deck is a bug report, not
art direction, and it was the only thing `Review.tsx`, `review-state.ts` and `sashaCurrentPage`
existed for. All three are gone.

**The three surfaces share nothing.** Separate HtmlService documents, separate frames, separate
origins — no state, no storage, no `postMessage`, no window handle. Everything that crosses goes
through the server:

- *"what is staged"* — all three call `sashaScanInbox` (the `READY`/`PICK` name walk).
- *"what has happened"* — Ask Sasha lists the proposal's `events/` folder (`sashaReadEvents`). That
  is the "has anything happened" signal; `manifest.revision` is the separate "have the candidates
  changed" one. They are deliberately not the same: the add-on APPENDS events, so an event that
  bumped `revision` would make the add-on a writer of `manifest.json` and put both writers back
  into the read-modify-write that one file per event exists to prevent. **Nothing here ever writes
  the manifest**, and `needsManifest` re-reads it when the LOG shows a set-changing event rather
  than on a clock.
- *"how many open comments has slide N"* — both views call `sashaCandidateComments` over the
  candidates' own `NN.html` and derive the number through the SAME `unresolvedCountFor`. That is
  why they cannot disagree, and `UnresolvedCount` is a union with no zero in its "not read" and
  "could not read" arms, so neither view can render a misleading 0.
- *"show the slides"* / *"show the report"* — `sashaOpenPicker` / `sashaOpenDefectReport`, because
  `showModelessDialog` is a server-side `SlidesApp.getUi()` call that no client JavaScript in a
  sandboxed iframe can make. Their `{ opened: true }` is **read back**, so a stale deploy is a line
  on screen rather than a button that silently does nothing.

**The slides window opens by itself when slides arrive**, once per proposal: `proposalToAutoOpen`
decides it from the state — not from a side effect in a fetch handler — so a user who closes the
window is not dragged back into it on the next poll, and it waits for the manifest so it cannot
open onto a set that has been cleared.

## Why an add-on and not a Chrome extension

Four things point the same way, and PROTOCOL.md ("The UI vehicle") settles it:

1. `appProperties` and `drive.file` are both **per-app**, so two OAuth clients cannot see each
   other's files. An add-on runs as the **signed-in user** with the `drive` scope, so it sees
   everything that user sees — including the MCP server's files.
2. `ScriptApp.getOAuthToken()` means **no client file, no consent screen to operate, no refresh
   token in browser storage**. `chrome.identity.getAuthToken` would have forced a second,
   Chrome-Extension-type client — i.e. a second Drive app that silently sees nothing.
3. Measured on Chrome 154: an **offscreen document does not get the extension API surface**
   (`chrome.storage` and `chrome.identity` are `undefined`, `chrome.runtime.getManifest()` throws).
   The pattern the extension needed for a >30 s poll loop therefore could not hold auth or storage.
4. A sidebar lives exactly as long as it is open, so the whole three-context port protocol
   (content script ↔ service worker ↔ offscreen document) collapses into one document.

## Layout

```
addon/
  build-addon.ts        the build: tsc gate (2 projects) -> esbuild -> dist/
  package.json          typecheck / test / build / smoke
  tsconfig.json         the shipped sources (browser types only; no @types/node)
  tsconfig.test.json    the tests (the only project that sees @types/node)
  src/
    bridge.ts           the google.script.run contract + every reply parser  (replaces wire.ts)
    bridge-client.ts    the only file that mentions google.script.run
    apps-script.d.ts    google.script.run + the inlined extractor blob, declared
    dialog.tsx          THE DIALOG's composition root: observer, HTML loads, convert, insert, PICK
    sidebar.tsx         THE SIDEBAR's composition root: the conversation, and nothing else
    observer.ts         the READY observer reducer — now a NAME walk
    observer-runtime.ts the observer actor + effect executor
    drive-api.ts        DriveApi / SlidesApi / PickApi interfaces + createdObjectIdsOf
    pick-writer.ts      PICK: build, validate, write
    render-artifact.ts  render/NN.png: the names and tags, computed here
    converter-contract.ts  the real mcp/sasha-slides/converter/, normalized for the picker
    slide-insert.ts     createSlide + the converter's requests, as one batch
    picker-state.ts     the SLIDES window's state tree and pure reducer (+ `view`/`tool`, edits, counts)
    Picker.tsx          the slides window's React tree: the toolbar, the two zoom levels, the tools
    candidate-grid.tsx  THE GRID: two columns, one cell per candidate, each its own HTML
    slide-stage.tsx     one candidate's picture + whatever the current TOOL puts over it
    scaled-frame.tsx    1280x720 in a box of measured width -- the dialog's size is not fixed
    editor-slot.tsx     the visual editor's slot: attach/detach in a scope, edits into the tree
    slide-editor.ts     the HOST's side of the editor seam: editor/ types re-exported + the stub
    editor/             NOT THIS COMPONENT'S: the visual editor module, consumed via its index.ts
    conversation-state.ts  ASK SASHA's state tree and pure reducer: the merged, ordered log
    Conversation.tsx    Ask Sasha's React tree: the log, the live waiting panel, the composer
    waiting.ts          what is waiting for Sasha, for how long, and the LAST PROOF anything listened
    session-log.ts      THE ONE BOUNDARY against the server's session log + the unresolved counts
    report-state.ts     the REPORT window's three statuses around `Defect`, and target selection
    report.tsx          the REPORT window's composition root (the third bundle)
    editor-pane.tsx     ONE slide in the editor, with its own frame and edits -- the report shows two
    picker-styles.ts    the CSS for all three surfaces; `.sasha-shell-wide` is the wide ones\
    feedback.ts         the feedback WIRE CONTRACT: a note <-> a Slides comment body
    rendered-preview.ts the "rendered slide" projection of a batchUpdate
    html-check.ts       PROTOCOL.md's self-contained-1280x720 check
    protocol.ts         the protocol's values and parsers
    seen-store.ts       the `seen` cache (localStorage, guarded, memory fallback)
    fake-drive.ts       TEST-ONLY: a real folder tree, so the name walk is testable
    inert-actions.ts    TEST-ONLY: do-nothing action objects, so the tree renders with no ports
    *.test.ts           466 unit tests
    smoke.e2e.ts        ALL THREE emitted pages in Chrome, one tab each, google.script.run stubbed
```

Emitted (gitignored, regenerable):

```
dist/mcp/sasha-slides/addon/{appsscript.json, Code.gs, Sidebar.html, Dialog.html, Report.html}
```

## The eleven `google.script.run` functions

The picker's five: `wire.ts`'s `Upstream` union had five variants and they map one-for-one, with two
substitutions the vehicle forces. Request and reply shapes are declared and parsed in
`src/bridge.ts`.

| function | replaces | takes | returns |
| --- | --- | --- | --- |
| `sashaHello` | `hello` | — | `{ protocolVersion, presentationUrl }` |
| `sashaScanInbox` | the observer's Drive poll (`listByRoles`) | `{ pageSize }` | `{ marks: ProposalMark[] }` |
| `sashaReadText` | `request-slide-html` | `{ fileId }` | `{ text }` |
| `sashaInsert` | `insert` | `{ presentationId, requests, render }` | `{ batchResponse, renderArtifact }` |
| `sashaWritePick` | `decide` | `{ folderId, name, mimeType, body, appProperties }` | `{ fileId }` |

Review mode's three:

| function | takes | returns |
| --- | --- | --- |
| `sashaReadEvents` | `{ folderId, pageSize }` | `{ events: [{ fileId, name, text }] }` |
| `sashaWriteEvent` | `{ folderId, name, mimeType, body }` | `{ fileId }` |
| `sashaCandidateComments` | `{ fileIds, pageSize }` | `{ files: [{ fileId, comments, error }] }` |
| `sashaSendFeedback` | `{ fileId, comments: [{ content }] }` | `{ results: [{ commentId, error }] }` |
| `sashaReadFeedback` | `{ fileId, pageSize }` | `{ comments: [Drive comment with replies] }` |

`sashaSendFeedback` / `sashaReadFeedback` take any Drive **file id**, which is what lets one pair
serve two jobs: a conversation message is a comment on the PRESENTATION and a mark-up is a comment
on the CANDIDATE's own `NN.html`. Nothing in `Code.gs` knows which; the caller decides.

`sashaReadEvents` returns each file's **id** as well as its name because the event sort's last
tie-break is Drive's file id — the millisecond prefix and the six-character suffix are not a total
order (two writers can mint the same pair, and Drive allows duplicate names), so a two-key sort
would render a different order than the server's.

`sashaWriteEvent` **creates**; there is no update and no append. Drive has no append, so a single
`events.jsonl` would mean read-modify-write from two writers that cannot see each other — the MCP
server and this add-on — and the loser's event would vanish. The add-on writes exactly two kinds,
`comment-opened` and `slide-inserted`; `serializeSessionEvent` REFUSES the five that are Sasha's.

`sashaCandidateComments` answers **per file**, errors included, because Drive does: file 3 can fail
after 1 and 2 succeeded, and slide 2's badge saying "could not be read" while slide 1's shows 3 is
the whole point. Collapsing that into one failure — or into an empty list — is the "showing zero
when you cannot reach it" failure the contract forbids.

The surface split's three:

| function | takes | returns |
| --- | --- | --- |
| `sashaOpenPicker` | — | `{ opened }` |
| `sashaOpenDefectReport` | `{ proposalId, slideIndex }` | `{ opened }` |
| `sashaTakeReportTarget` | — | `{ proposalId, slideIndex }` |

`sashaOpenPicker` and `sashaOpenDefectReport` are the only functions whose point is a side effect on
the Slides UI rather than data. `opened` must come back `true`; anything else is a refusal the
caller renders — and in Ask Sasha's case that button is the only way back to the candidates, so it
may never fail silently.

They show DIFFERENT windows, and the report's target has to be recorded before its window appears:
each surface is a separate HtmlService document with no channel back to the others, so
`sashaOpenDefectReport` leaves `{proposalId, slideIndex}` in user properties and the report window
asks for it once with `sashaTakeReportTarget`, which CLEARS it. A report window opened later
therefore comes up on the first staged candidate rather than on a slide the user finished with
yesterday. Recording it is best effort: if it fails the window still opens, picks the first
candidate, and `describeChosenTarget` SAYS that is what happened — `chosenTarget` in
`src/report-state.ts` names every way of not finding the asked-for slide, so the window never shows
slide 1 without explaining why the user pressed the button on slide 3.

`sashaSendFeedback` reports PER COMMENT, because Drive has no batch endpoint for comments and
comment 3 can fail after 1 and 2 landed.

### The feedback comment format (`src/feedback.ts`)

One Drive comment per note: the user's prose, then one sentinel line.

```
the chart lost its gridlines

sasha-slides-feedback={"protocolVersion":1,"noteId":"box_k2h9_1","pageObjectId":"g2d8c1f0a_0_1","region":{"x":0.1,"y":0.2,"w":0.3,"h":0.25},"createdAt":"2026-10-04T12:00:00.000Z"}
```

`pageObjectId` is `null` for a **conversation message** — one about the deck rather than about any
one slide, which is what the sidebar sends. The server half already reads the field as
`string | null` (`feedback/comment-anchor.ts`), so such a comment is reported as unanchored rather
than as one it cannot read. An EMPTY string is still refused: that is a malformed page id, not an
absent one.

`region` is `null` for a note about the slide as a whole, and is otherwise the same fractional (0-1)
box `PROTOCOL.md` specifies for `PICK.anomalies` — relative to the page, so it survives any scaling.
`region` fractions are rounded to 5 decimals. The region travels in the TEXT and not in Drive's
comment `anchor` because that field is an opaque per-application descriptor whose shape is
undocumented for a Slides file. A comment with no sentinel is somebody else's comment on the deck
and is skipped silently; one of ours whose sentinel does not parse is reported, never guessed at.
Both halves of the product should go through `feedbackCommentContent` / `readFeedbackComment`.

`visibility` needs no call at all: there is one sidebar and `document.visibilityState` is readable
locally, so the poll cadence is computed client-side.

`Code.gs` is a **thin adapter**: the name walk is DriveApp calls with no filtering, file bodies come
back as raw text, the batchUpdate reply comes back raw, and every name/tag the render artifact needs
arrives in the request. Every decision is in `src/`, under `node --test`.

## Build and test

```bash
cd mcp/sasha-slides/addon
npm install                    # react, react-dom, @types/*
npm test                       # tsc gate (both projects) + 440 unit tests
npx tsx build-addon.ts         # gate, then emit dist/mcp/sasha-slides/addon/
npm run smoke                  # both emitted pages in Chrome on CDP :9222
```

The typecheck is a **separate failing step** inside `build-addon.ts`, before anything is emitted:
esbuild strips types without checking them, so a green bundle proves nothing.

Emitted files carry a generated-file header and are overwritten wholesale. **Nothing hand-edits
them** — not `dist/Code.gs`, and not the copy in the Apps Script editor.

## Deploying it (clasp)

```bash
# 1. Build. (Emits Sidebar.html, Dialog.html AND Report.html; clasp push uploads all three.)
cd /workspaces/sashaslides/mcp/sasha-slides/addon
npx tsx build-addon.ts

# 2. clasp, once per machine.
npm i -g @google/clasp
clasp login                       # opens a browser; authorizes clasp against your account

# 3. Create the bound script, from the emitted project.
cd /workspaces/sashaslides/dist/mcp/sasha-slides/addon
clasp create --type slides --title "SashaSlides picker"
#   ... or, to push into a script that already exists:
#   clasp clone <scriptId>
clasp push                        # uploads appsscript.json, Code.gs, Sidebar/Dialog/Report.html

# 4. OAuth consent, once. `clasp open` -> the linked Google Cloud project ->
#    "OAuth consent screen": User type = External, publishing status = Testing,
#    and add your own Google account as a test user. (Publishing for other people
#    needs Google's add-on verification, which is a separate review.)
clasp open

# 5. Use it. Open the Slides deck the script is bound to (clasp create --type slides
#    made a new one; `clasp open --addon` reaches it), then:
#       Extensions -> SashaSlides -> Open the conversation   (the sidebar)
#       Extensions -> SashaSlides -> Candidate slides        (the modeless dialog)
#    The first open prompts for the four scopes — approve them.
```

After a source change, rebuild and `clasp push` again; there is no server to redeploy.

### Scopes (`appsscript.json`)

| scope | why |
| --- | --- |
| `presentations` | `batchUpdate` the picked candidate into the active deck |
| `drive` | **not** `drive.file`: the whole point is seeing the files the MCP server created |
| `script.container.ui` | the Extensions menu, `showSidebar()` and `showModelessDialog()` |
| `script.external_request` | `UrlFetchApp` — batchUpdate, the page thumbnail, the appProperties PATCH |

## The session log, and the one boundary against it

`src/session-log.ts` is the ONLY file that knows the Drive shapes of PROTOCOL.md's final section.
Both surfaces read it; neither reaches past it. It is one file on purpose: the server half is built
in parallel against the same document, so reconciling a shape change is one file's diff rather than
a sweep through the UI.

**One file per event**, named `<epochMillis>-<6 base36>-<kind>.json` under `<proposal>/events/`,
ordered by **prefix, then the whole name, then Drive's file id** — the first two are not a total
order, so a two-key sort would render a different order than the server's.

**Nothing is ever dropped.** `parseSessionEventFile` is TOTAL: an unknown `kind`, a body that is not
JSON, and a `protocolVersion` from the future all become an `opaque` event carrying the reason, and
render as a yellow dashed "something happened that this add-on cannot read" line. A reader on an
older build must not silently show an incomplete history, and that is only enforceable if the parser
cannot fail.

The seven kinds it renders specifically: `slides-staged`, `comment-opened`, `comment-answered`,
`slide-revised`, `comment-resolved`, `slides-cleared`, `slide-inserted`. Each carries a **voice**
(`user` / `sasha` / `deck` / `opaque`) from an exhaustive switch, so a new kind has to say whose
turn it is rather than defaulting into someone's column.

**The unresolved counts are a UNION, not a number:**

```ts
type UnresolvedCount =
  | { kind: "known"; count: number }
  | { kind: "unknown" }                          // not read yet        -> "?"
  | { kind: "unreachable"; message: string };    // could not be read   -> "!"
```

There is deliberately no path from "not read" or "could not read" to `0`. The grid cell, the chip
and the conversation row all call the same `unresolvedCountFor` over the same `SlideCommentsLoad`,
so they cannot disagree about the number, and none of them *can* render a zero it cannot vouch for —
the type has none. That is UI-CONTRACT.md's "the two must never disagree; if one cannot reach it, it
says so rather than showing zero", enforced structurally rather than by care. It lines up with the
server's own answer: `read_feedback`'s `unresolved[]` carries `unresolved: null`, never `0`, for a
candidate it could not read.

## Known limits

- **THE SIZE CEILING IS ENFORCED BY THE BUILD, not hoped for.** `build-addon.ts` fails if any page
  exceeds **500 KB**, because `renderer/html2slides/browser/build-addon.ts` records HtmlService
  relaying a ~560 KB inlined minified bundle back CORRUPTED, as `Uncaught SyntaxError: Invalid or
  unexpected token`. There is no base64 escape for the page itself: the sandbox's CSP forbids
  `unsafe-eval`, so the bundle has to be JavaScript the parser reads directly. Raising that number
  needs a measurement, not an opinion.

  Current: **`Sidebar.html` 294 KB, `Dialog.html` 427 KB, `Report.html` 448 KB.** The report grew
  because it now carries the visual editor (~23 KB bundled) for its two panes; merging it back into
  `Dialog.html` would be ~870 KB and is not an option, so the two stay separate documents that share
  components (`editor-pane.tsx`, `scaled-frame.tsx`, `picker-styles.ts`). `Dialog.html` was
  **553 KB** before this work and over the observed threshold. Two decisions brought it back:

  1. **The defect report became its own document.** `src/anonymise/` (~47 KB bundled), `Defect.tsx`,
     `defect-state.ts` and `report-endpoint.ts` are reachable only from `report.tsx` now — about
     **72 KB** off the slides window. Same reasoning that took the sidebar
     from 439 KB to 256 KB when the surfaces were first split, and the report genuinely wants a
     window of its own anyway: two slides side by side is a wide pair of 16:9 stages.
  2. **The extractor is MINIFIED before it is base64'd**, which took it from 93 KB → 125 KB of
     base64 down to 48 KB → 64 KB: **~61 KB** off each of the two bundles that convert. Base64 costs
     33% on top of whatever it wraps, so every byte there costs 1.33 twice. `extract-dom.ts` is a
     self-contained IIFE that never reads a function's `.name` or `toString()`, so renaming is safe
     — and `smoke.e2e.ts` converts a real candidate through this exact base64 path in Chrome, so a
     mangled extractor fails a test rather than a user's slide.

  Deleting review mode (`Review.tsx` + `review-state.ts`) was worth a further ~9 KB; that was not
  why it went.
- **No Google credentials exist yet**, so nothing here has been run against a real Drive or a real
  Slides deck. The unit tests run against `fake-drive.ts` and the smoke test against a stubbed
  `google.script.run`; the first real `clasp push` is still the first real test of `Code.gs`.
- **The candidate HTML pane scales by a MEASURED factor**, not the old 0.214 constant: a sidebar
  is a fixed 300 px wide but a dialog's size is a request the browser window clamps, and the grid
  reflows, so `scaled-frame.tsx` reads the laid-out box and renders `scale(width / 1280)` from
  React state (0.371 at 1000 px wide, measured). The constant survives only as the pre-measurement
  fallback. Review mode's page thumbnail is a PNG, so it scales by its box
  (`object-fit:contain`) instead.
- **The visual editor behind the slot is still a STUB.** `nullSlideEditor` satisfies the
  `SlideEditor` interface, reports zero edits and returns the HTML unchanged. The real module now
  exists at `src/editor/` (another component's work) and the host already depends on its **types** —
  `src/slide-editor.ts` re-exports them from `./editor/index.ts` rather than restating them, so
  there is exactly one declaration of `SlideEdit` and `SlideEditor` and the two halves cannot
  drift. Only its *behaviour* is not wired yet: swapping it in is one line,
  `createSlideEditor(...)` in `dialog.tsx`'s `createEditor`, and the compiler has already proved
  the two are interchangeable. The slot, the edit list, Undo and the state-tree plumbing are real
  and tested. Nothing yet writes the edit record or the edited HTML back to Drive: `PICK`'s shape is
  `PROTOCOL.md`'s and adding a field to it is not this package's call.
- **THE SLIDES WINDOW'S GRID DOES NOT REFRESH ON A REVISION.** `manifest.revision` is the
  protocol's "have the candidates changed" signal, and the conversation acts on it (a revised slide
  renders inline, keyed on the `slide-revised` event so a SECOND revision re-fetches). The grid does
  not: `observer.ts` stops polling once it is `offering` and only resumes after a `PICK`, so a
  window left open across a revision shows the candidate as it was staged. Closing it and pressing
  **See the slides** re-reads everything. Fixing it properly means re-opening the observer's phase
  machine to poll while offering and diff `revision`, which is a change to the component another
  agent owns the tests for — deliberately not done unilaterally.
- **A mark-up's Send is not idempotent on a PARTIAL failure.** Drive has no batch endpoint for
  comments, so a send that created 2 of 3 is reported as a failure naming the count and the notes
  stay on screen — pressing Send again would re-post the two that worked. Per-note bookkeeping in
  the reducer is the fix if that is ever actually seen. (One mark-up is one comment today, so this
  is latent rather than live.)
- **A CLEARED proposal keeps its `READY`.** `clear_slides` deletes the uninserted candidates and
  bumps `revision`; it does not remove the marker, so the name walk still finds the folder and
  `manifest.count` comes back 0. Both surfaces therefore trust `count`, never `READY`, after the
  first staging: `slidesReachability` returns `cleared` (the button goes off and says why) and
  `PickerState` has a `cleared` status rather than rendering a grid of nothing. `parseManifest`
  accepts `count: 0` for exactly this reason — refusing it made a cleared set read as "the manifest
  could not be read", which is the one thing clearing must never look like.
- **The dialog loads and converts every candidate**, not just the selected one, because the grid
  shows them all. They go one at a time (each arrival re-runs the pump), so N candidates are N
  serial round trips rather than N parallel ones — deliberate, but it means the last cell in a
  large proposal fills in last.

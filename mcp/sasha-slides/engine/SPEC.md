# Sasha engine

Sasha Slides' own presentation editor and presentation engine. One package
(`mcp/sasha-slides/engine`, npm name `sasha-engine`) serves two hosts: the standalone web
application at `sashaslides.com/deck/<id>` and the Google Slides add-on, which embeds that web
application.

The contracts in `src/contracts/` are the source of truth for every type named here, and
`src/theme/` for every visual value. This document says why they look the way they do and what each
module must build against them. Revision 2 answers a hostile review of 45 points; section 20 lists
the points not taken as proposed.

## 1. Goals

1. **Full editing**: everything a user expects from Google Slides for the content they make (section
   3): borders, backgrounds, corner radius, shadow, opacity, text styling, position, size, rotation,
   z-order, grouping, alignment and distribution, undo and redo, copy and paste, keyboard nudges.
2. **Our own presentation engine**: Claude can write a full JavaScript and markup transition between
   two slides, while the slides themselves stay structured, editable objects. A transition is a
   separate scripted artefact that receives rendered snapshots of the outgoing and incoming slides
   and animates between them inside a sandbox.
3. **One state architecture**: RxFeedback. State is `reduce(events)`; side effects live only in
   feedback loops; the reducer is pure and replayable.
4. **Collaboration**: Yjs is the stored source of truth for the document. Comments and annotations
   are anchored, threaded and resolvable. Presence shows cursors and selections.
5. **Two hosts, one engine**: web application and add-on share this package.
6. **Google Slides import and export** (milestone 3), reusing `mcp/sasha-slides/converter`.

Not goals: a pixel-for-pixel Slides clone; offline-first sync (milestone 2 is online with an
in-memory replica); charts linked to Sheets; video editing.

## 2. Visual style: Tidepool everywhere

The user asked for "the entire editor in this same style": top bar, toolbar, filmstrip, properties
panel, menus, dialogs, notices, presenter controls, speaker view and comment threads all wear
Tidepool, the look the sidebar (`addon/src/tidepool-styles.ts`), the slides window
(`addon/src/tidepool-calm-styles.ts`) and the website
(`renderer/html2slides/addon-server/public/site.css`) already have.

**One source.** `src/theme/tidepool-theme.ts` holds every token for the light and dark schemes:
colours, typography (family, sizes, weights, line height), spacing, radii, control sizes, focus ring
width, disabled opacity, stacking layers, motion. `tidepoolCustomProperties` emits every one of them
as a `--sasha-*` custom property. `src/theme/tidepool-stylesheet.ts` is the shared stylesheet whose
rules read only those properties, with class names as constants (`TIDEPOOL_CLASS`), and
`src/theme/lively-shapes.tsx` is the drifting-shapes component. The view and the presenter both build
on these; neither repeats a colour literal (a test enforces it for the shared rules, and each module
adds the same check for its own stylesheet).

| Rule | How |
|---|---|
| Pearl ground `#eef1f6` | `body` background; dark scheme `#0e1220` |
| Calm wash behind the canvas | `.sasha-calm-ground::before`: three radial gradients whose `filter: hue-rotate(0 to 70 degrees) saturate(1 to 1.15)` swings over 40 seconds in 120 discrete steps, paused while `data-gesture="active"` is on the engine root. Nothing moves behind a slide being edited, and the wash repaints a few times a second at most |
| Lively shapes only where nothing is edited | `LivelyShapes` on the deck list, an empty deck and the presenter's end screen |
| Chrome is liquid glass, without a backdrop blur | panels: `--sasha-panel-glass` (white at 0.55), a bright 1 pixel top edge, a soft lift shadow. Re-blurring the animated wash behind three full-height panels costs every frame of a drag, which is why the calm slides window already has no blur. `backdrop-filter` appears only on `.sasha-lively-card` over the lively shapes |
| Chrome over the slide is nearly opaque | menus, the context menu, the inline text toolbar and popovers use `--sasha-glass-over-canvas` (0.92): over a black slide the old 0.45 glass gave text 3.31:1 |
| Dialogs never blur the canvas | a `--sasha-scrim` dimming layer, then a dialog in `--sasha-glass-over-canvas` |
| Ink pills | primary `#1c2333` with white text, secondary `rgba(28, 35, 51, 0.07)` with ink text, danger pill, all `border-radius: 999px`; tabs are pills, the active one (`aria-selected="true"`) white with a small lift |
| Type | Manrope from Google Fonts, fallback Roboto, Arial; the script editor uses the system monospace stack |
| Text colours | `#1c2333`, muted `#3d4659`, subtle `#4b5468`, accent `#4338ca` (dark: `#eef1f8`, `#aeb6c9`, `#a5b4fc`) |
| Contrast | `src/theme/tidepool-theme.test.ts`: every text colour at least 4.5:1 on the ground, on panels and cards over each wash colour sampled every 10 degrees of the hue swing (with the matching saturation), on chrome over a black and over a white slide, on dialogs over the scrim; inactive tab text on secondary pills; peer colours 3:1 against ground and panels with label text 4.5:1 on each, per scheme |
| Motion | every animation and transition sits inside `@media (prefers-reduced-motion: no-preference)` (tested); under `reduce` the wash and shapes are still and menus appear at once |
| Slide content is never restyled | chrome styles are scoped under `.sasha-engine`; the slide root (`.sasha-slide-root`) resets inheritance with `all: initial`, and the renderer sets every slide style inline |
| Selection on any slide colour | outline `--sasha-selection` 1.5 pixels plus a 1 pixel `--sasha-selection-halo`; handles are 9 pixel squares filled with `--sasha-handle-fill` |

## 3. Google Slides feature matrix

Milestone 1 is the document model, editor and presenter without a server. "Later" means milestone 2
or 3 or after; "not planned" means we have a reason not to.

| Feature | Status | Notes |
|---|---|---|
| Text box | Milestone 1 | `shape` with preset `textBox`; grows with its text (`resizeShape`) as in Slides |
| Shapes (22 presets: rectangle, rounded rectangle, ellipse, triangles, polygons, five-point star, arrows, callout, cloud, heart, plus, chevron) | Milestone 1 | rectangle family drawn as boxes, the rest as vector paths |
| Other Slides shape presets (about 130) | Later | the `ShapePreset` union grows; an unknown preset from a newer client renders as a placeholder, never overwritten |
| Shape text (any shape holds text) | Milestone 1 | |
| Fill: solid, linear gradient, radial gradient, image | Milestone 1 | export approximates radial |
| Border: width, colour, dash (6 styles) | Milestone 1 | |
| Per-side borders | Milestone 1 | rectangle family only; Slides cannot express it, export composes shapes (converter) |
| Corner radius, uniform and per corner | Milestone 1 | rectangle family |
| Drop shadow | Milestone 1 | offset, blur, spread, colour |
| Opacity | Milestone 1 | |
| Reflection, inner shadow, glow | Not planned | rarely used; Slides offers reflection only |
| Position, size, rotation, flip | Milestone 1 | properties panel fields and handles; rules in `contracts/geometry.ts` |
| Aspect-ratio lock | Milestone 1 | Shift while resizing, and a lock toggle |
| Z-order (front, forward, backward, back) | Milestone 1 | |
| Group, ungroup, enter group, rotate a group | Milestone 1 | a group keeps its own rotation |
| Align (6 edges) and distribute (2 axes) | Milestone 1 | one element aligns to the slide |
| Snapping and smart guides | Milestone 1 | slide edges and centres, other elements' edges and centres, 5 screen pixels |
| Grid, rulers, guides the user places | Later | |
| Text: font family, size (shown in points), weight, italic, underline, strikethrough, colour, highlight, link to a web address or to a slide, superscript and subscript, letter spacing, small capitals | Milestone 1 | |
| Paragraph: alignment, line spacing, space above and below, indents, direction | Milestone 1 | |
| Bulleted and numbered lists, 9 levels, 12 glyph presets | Milestone 1 | Tab and Shift+Tab change level; outside a list Tab types a tab character |
| Automatic slide number text | Milestone 1 | `automaticText` run, Insert > Slide number |
| Text autofit: none, shrink on overflow, resize shape to fit text | Milestone 1 | section 7 "Measured layout" |
| Vertical alignment, padding, wrap | Milestone 1 | |
| Paint format | Milestone 1 | toolbar brush; double click keeps it |
| Paste rich text from Docs or the web | Milestone 1 | reduced to the engine's run and paragraph styles |
| Columns in a text box | Later | |
| Images: insert (file, paste, drop), crop, border, radius, shadow, opacity | Milestone 1 | crop by numbers in the panel; drag-to-crop later |
| Image recolour, adjustments (brightness, contrast, transparency) | Later | |
| Image mask to shape | Later | |
| Lines: straight, arrowheads (7), dash, width, colour | Milestone 1 | |
| Elbow and curved connectors, connection to shapes | Later | routing is rendered in milestone 1, edited later |
| Freeform polyline, scribble | Later | |
| Tables: insert, cell text, cell fill, cell borders per side, insert and delete rows and columns, resize, rows grow with text | Milestone 1 | |
| Table cell merge | Later | `rowSpan`/`columnSpan` already in the model |
| Slide background: solid, gradient, image | Milestone 1 | |
| Themes (colour slots, heading and body fonts, placeholder text styles, default background) | Milestone 1 | changing the theme restyles every reference |
| Layouts with placeholders, change a slide's layout | Milestone 1 | copied into a new slide; a layout change remaps placeholders by role and index; live master inheritance later |
| Editing masters and layouts | Later | |
| Speaker notes | Milestone 1 | collaborative text |
| Skip slide | Milestone 1 | |
| Slide transitions: fade, push, slide, zoom, morph | Milestone 1 | built-ins run in the presenter's page |
| Scripted transitions written by Claude | Milestone 1 | the headline feature; run sandboxed, only once a person approved them |
| Flip, cube, gallery transitions | Later | as further built-ins |
| Object animations (builds) | Later | same sandbox, a per-slide script |
| Present: full screen, keyboard, blank screen, go to number, end screen | Milestone 1 | |
| Speaker view (notes, next slide, timer) | Milestone 1 | same React tree in a second window |
| Audience questions, laser pointer | Not planned / later | laser pointer later |
| Comments: anchored, threaded, resolvable | Milestone 1 (local) | shared in milestone 2 |
| Annotations drawn over the slide | Milestone 1 (local) | pen, rectangle, arrow, highlight |
| Presence (cursors, selections) | Milestone 2 | milestone 1 proves it with an in-memory two-editor demo |
| Real-time collaboration | Milestone 2 | Yjs from day one, so milestone 2 is transport only |
| Undo an agent's edits | Milestone 2 | "Undo Claude's edit" notice action, `deck_revert` |
| Version history | Later | Yjs snapshots per save point |
| Copy and paste, within and across decks | Milestone 1 | plus text and images from outside; cut and paste within a deck keeps ids, so comments follow |
| Find and replace | Later | |
| Spell check | Milestone 1 | the browser's own, including its replacements (`insertReplacementText`) |
| Charts linked to Sheets | Not planned | imported as images |
| Video, audio | Later | |
| Word art | Not planned | a shape with text covers it |
| Import from Google Slides | Milestone 3 | |
| Export to Google Slides | Milestone 3 | |
| Printable document and image export | Later | print stylesheet of the presenter |

## 4. Architecture

```
┌──────────────────────────── host: web application page / add-on dialog frame ──────────────────────┐
│ view (React, Tidepool)          dispatch(EditorEvent) ──►  state: RxFeedback editor system        │
│   canvas, filmstrip, panel,  ◄── state$ (EditorState) ──   pure reducer + feedbacks:               │
│   menus, dialogs, comments                                   apply edits ─► DocumentStore.apply    │
│   (clipboard, full screen,                                   store changes ─► documentChanged      │
│    speaker window: in handlers)                              discussion ─► DiscussionStore.submit  │
│                                                              uploads, anchors, presence, notices   │
│ presenter (React + its own RxFeedback system)                          │                            │
│   built-in transitions in-page                                         ▼                            │
│   │  MessagePort (transition-protocol.ts), scripted only     model: DocumentStore over Y.Doc,       │
│   ▼                                                          DiscussionStore over a request log     │
│ ┌── runner frame: sandbox=allow-scripts, inert, other site ──┐                                     │
│ │ bootstrap + approved transition script                      │                                     │
│ └─────────────────────────────────────────────────────────────┘                                     │
└───────────────────────────────────────────────────────────────────────┬───────────────────────────┘
                                         milestone 2: Yjs sync + awareness + discussion log (WebSocket)
                                                                         ▼
                                       deck server in the connector (persistence, access, repairs, agent tools)
```

Dependencies point one way: `contracts` and `theme` <- `model`, `state`, `view`, `presenter`.
`state` depends on `DocumentStore` only through the contract; `presenter` receives the view's
renderer and the state module's RxFeedback toolkit by injection; the view's application shell is the
composition root and wires the real implementations together. `model` is free of the page so the
deck server and Claude's tools can run it on Node.

Each module's `index.ts` exists from day one as an architect-written stub that satisfies its surface
(`contracts/module-surfaces.ts`) and throws "not built yet"; `src/module-surfaces-check.ts` fails the
typecheck if any module stops exporting its whole surface. So the four modules compose and typecheck
before any of them is built.

## 5. The document (Yjs)

Layout and decisions: `src/contracts/yjs-schema.ts` header. In short:

- Root maps `meta`, `theme`, `layouts`, `slides`, `assets`, `transitionScripts` in one Y.Doc.
  Comments are not in it (section 12).
- **Order** of slides and z-order of elements are fractional index keys (`position`), so a move is one
  field write and concurrent moves never duplicate. Every newly minted key ends in a random suffix of
  about 4 characters from the model's injected random source, so two people inserting runs into the
  same gap get two contiguous runs, never interleaved; asking for a key between two equal neighbours
  re-keys locally. The model implements fractional indexing itself (base-62 midpoint keys, about 80
  lines, no dependency).
- **Slides and elements are keyed maps.**
- **The frame is one value** (`frame`: x, y, width, height, rotation, flips), as Slides stores one
  affine transform; a line stores `lineGeometry` (both end points) as one value; a group stores only
  its `rotation`. A concurrent move and resize resolve to one of the two chosen frames, never a mix,
  and an undo restores a frame whole or not at all. Style groups (`fill`, `border`, `cornerRadius`,
  `shadow`, `textBox`) are one value each.
- **Text** is Y.Text with run attributes on characters and paragraph attributes on each paragraph's
  "\n"; every body ends with "\n"; attribute values are flat. Three rules keep the two namespaces
  apart: every character insert passes the complete attribute set with `null` for every paragraph key
  (otherwise text typed at a paragraph's start inherits the previous mark's alignment and list as
  character formatting); a "\n" insert copies the split paragraph's paragraph attributes; the
  projection strips cross-namespace keys. "None" is a stored value, never `null`, because Yjs removes
  an attribute set to `null` (`highlight: { kind: "none" }`, `link: { kind: "none" }`,
  `list: { kind: "none" }`). The automatic slide number is an embed.
- **Groups** are a `groupId` pointer; children keep absolute coordinates. Ungrouping re-keys the
  children, in order, into the group's place in the top-level order.
- **Tables**: row and column id arrays, widths and heights maps, cells keyed `rowId|columnId`. A cell
  where a concurrently inserted row and column meet is an empty default cell until its first edit.
  Accepted loss: two people making the very first edit to that same cell at the same moment lose one
  of the two first edits.
- **Transition scripts** are plain strings (last writer wins), saved whole with the `updatedAt` they
  were based on; never shared text (section 11).
- **Assets**: `AssetRecord` is metadata, add-only and outside undo; bytes go through `AssetStore`.
- **Undo scope**: `theme`, `layouts`, `slides`, `transitionScripts`; never `meta` or `assets`.
- **Versions**: `meta.schemaVersion` is `DOCUMENT_SCHEMA_VERSION` (1). A replica seeing a newer
  version opens the deck read-only with a notice. A value a client does not understand (a newer
  preset or fill kind) is listed in the element's `unsupportedKeys`, rendered with a placeholder
  treatment, never repaired and never written unless the user explicitly changes it; an element of
  an unknown kind becomes an `UnsupportedElement`.

`DocumentSnapshot` (`document.ts`) is the immutable projection. The model rebuilds it after each
transaction, only for touched slides; untouched slides and elements keep their identity (`===`),
which React memoisation and the filmstrip cache depend on. It walks groups with a visited set, so a
cycle from two concurrent "group" commands never recurses forever: the member with the larger id
shows at the top level. Empty groups are not shown.

## 6. State and the document

**Decision: the Y.Doc is an input stream into the reducer, and edits are commands applied to the
Y.Doc by one feedback.** (`document-store.ts` header has the diagram.)

```
view intent ─► reduce ─► state.pendingEdits ─► apply feedback ─► DocumentStore.apply (one Y.Doc transaction)
                 ▲                                                          │
                 └── documentChanged { snapshot, origin, textChanges } ◄─────┘ (also remote and undo)
```

Why this and not the alternatives:

- **Reducer mutates a Y.Doc**: impure; the reducer could no longer be replayed or tested with values,
  and a reducer that throws would leave a half-written transaction that cannot be rolled back.
- **Editor state is the truth, Yjs a persistence mirror**: two sources of truth; every remote update
  has to be diffed back into state and conflicts resolved twice.
- **Chosen**: one writer to the shared document (the feedback), one reader path back (the change
  stream), local and remote edits enter the state the same way, and the reducer stays pure. The
  state also holds `pendingEdits` and `inFlightCommandIds`, so "what the user asked for but the
  document has not reflected yet" is visible and testable.

**Ordering, so fast typing never scrambles.** Four rules together:

1. The mailbox has two queues (`rxfeedback.ts`): `dispatch` feeds the external one, feedback
   emissions the internal one, and the drain always empties the internal queue first. The store is
   synchronous, so the `documentChanged` and `editSettled` of keystroke one are reduced before
   keystroke two.
2. When the reducer queues a text edit it moves `selection` to the envelope's `selectionAfter` at
   once.
3. Every `documentChanged` carries `textChanges`, one delta per changed body; the reducer moves the
   caret, the range, the composition start and the indices of every still-queued text edit through
   them with `transformIndex` (`text-delta.ts`), and updates the queued edits' `basedOnRevision`.
4. Tie-break at an insertion point: a remote insert at my caret goes after my caret
   (`bias: "before"`); my own consecutive inserts go after each other (`bias: "after"`).

So an `editText` is always computed against the revision the model holds, and `staleText` is a guard
that turns a broken invariant into a visible rejection rather than a scrambled word.

**Purity.** The reducer never reads a clock or a random source. Ids come from `EditorState.idSeed`
(`ids.ts` `mintId`: a session prefix of 8 random characters drawn once by the composition root, plus
a counter), so replaying the event log reproduces the same ids. Times are stamped by the stores that
record them: the model's `updatedAt` and typing merge window, the discussion authority's `at`.
Timers (notice expiry, upload retry and timeout, presence throttling) are feedbacks on the injected
`scheduler`.

**Gestures preview locally** (`EditorState.gesture.preview`) and commit one `setFrames` envelope on
pointer up: one gesture, one undo step, one shared update. `setFrames` carries the final geometry of
every leaf it changes, plus a group's own rotation, computed with the pure rules in
`contracts/geometry.ts`; the model writes them and never re-derives a child from a group's box, so
what the user saw during the drag is what is stored.

**Undo** (`document-store.ts` header):

- One `Y.UndoManager` over the undo scope, tracking only `LOCAL_EDIT_ORIGIN`, created with
  `captureTimeout: Number.POSITIVE_INFINITY` because Yjs's own merge window reads Yjs's own clock.
  The model calls `stopCapturing()` before every envelope except a `mergeWithPrevious` one whose
  previous step edited the same body less than `typingMergeWindowMilliseconds` (500) ago by the
  injected clock.
- Each step's metadata stores `selectionBefore` and `selectionAfter` with text positions as Yjs
  relative positions, resolved back when the step is undone or redone; if the text is gone, the
  element is selected instead.
- A step whose undo changes nothing (collaborators overwrote everything in it since) is skipped and
  the next one tried; `HistoryOutcome.skippedSteps` reports it and the editor shows "a collaborator
  changed this since" rather than silently undoing something older.
- Assets and `meta` are outside the scope, so undoing a paste never removes an asset record a
  collaborator's later paste uses.

**Validation and repair.** `validate()` reports structural damage (missing required key, wrong type,
dangling `groupId`, group cycle, empty or single-child group, duplicate order key) and unsupported
values. Only the repairing replica writes repairs: the single replica in milestone 1, the deck server
in milestone 2 (clients run `reportOnly`). Repairs are scheduled on the injected scheduler after the
transaction that revealed them, never inside an `observeDeep` callback, and never touch an unsupported
value, so two client versions can never fight.

**Selection survival.** After a change the reducer drops selected ids that no longer exist and leaves
text mode if its body vanished; a rejected local envelope drops its `selectionAfter` and raises a
notice.

## 7. The editor state machine (state module)

State shape: `editor-state.ts`; events: `editor-events.ts`; composition: `editor-system.ts`.

**Pointer.** The view converts client coordinates to slide units and reports `{ sample, target }`.

| Gesture | Starts when | Preview | Commits |
|---|---|---|---|
| click select | pointer up within 3 client pixels of down | none | selection (Shift toggles; a click on a group child selects the group unless `enteredGroupId` is that group; double click enters the group, or starts text editing on a text-bearing element) |
| move | pressed on an element, then 3 pixels | frames translated; Shift locks to the dominant axis; snapping to slide edges and centres and other elements' edges and centres within 5 client pixels, with guides | `setFrames` |
| resize | pressed on a resize handle | `resizeFrame` in the element's own axes from the opposite handle (Alt: from the centre); Shift or the lock keeps the aspect ratio; dragging past the opposite edge flips; several elements or a group scale about the selection bounds with `scaleFrameBetweenBoxes` (approximate for rotated children, tested), lines map their end points with `mapPointBetweenBoxes` (a zero-size axis only translates) | `setFrames` |
| rotate | pressed on the rotation handle | `rotateFrameAbout` the selection centre; Shift snaps to 15 degrees; a group's own rotation previews too | `setFrames` with `groupRotation` |
| marquee | pressed on background with `select` | box | elements whose rotated bounds intersect it (Shift adds) |
| create | pressed with an insert tool (`InsertTool`) | the new element's box; Shift keeps 1:1 | `insertElements`, selection = new element, tool back to `select`; a click without drag inserts a default size (text box 400 x 80 growing with its text, shape 240 x 240, line 240 long) |
| line end | pressed on a line end | the end follows, snaps to 15 degrees with Shift | `setFrames` with a `line` update |
| table line | pressed on a column or row boundary | moved boundary | `setTableColumnWidths` / `setTableRowHeights` |
| slide drag | filmstrip drag | drop indicator | `moveSlides` |
| marking | pressed with `annotate` | the marking | appended to the comment composer |
| paint format | click with `formatPainter` | none | `updateElements` and text formatting from the captured format |

Escape during any gesture cancels it with no command; so does pointer cancel.

**Geometry rules** (`contracts/geometry.ts`, table-tested): rotation is normalised to `[0, 360)`;
flipping a rotated element mirrors its centre, negates its rotation and toggles its flip; flipping a
selection or group mirrors each member about the selection's centre; sizes never fall below 1 unit.

**Keyboard** (`primary` is Ctrl, Cmd on macOS; shortcuts follow Google Slides where it has one):

| Keys | Action |
|---|---|
| primary+Z, primary+Shift+Z, primary+Y | undo, redo, redo |
| primary+C / X / V, primary+D | copy, cut, paste, duplicate |
| Delete, Backspace | delete selected elements or slides |
| primary+A | select all elements on the slide (in the filmstrip: all slides) |
| Arrow, Shift+Arrow | nudge 1 unit, 10 units |
| primary+G, primary+Shift+G | group, ungroup |
| primary+Up/Down, primary+Shift+Up/Down | forward/backward, to front/to back |
| Enter | start editing text of the single selected element; in a group, enter it |
| Escape | leave text editing (selects the element), leave the group, clear selection, close menu |
| Tab, Shift+Tab | select next/previous element in z-order; in text: list level, or a tab character outside lists |
| primary+B / I / U, primary+Shift+X | bold, italic, underline, strikethrough |
| primary+Shift+L / E / R / J | align start / centre / end / justify |
| primary+Shift+7 / 8 | numbered / bulleted list |
| primary+K | link editor (web address or slide) |
| primary+M | new slide |
| primary+Alt+M | comment on the selection |
| primary+Enter | present from the current slide |
| primary+/ | keyboard shortcuts dialog |
| Page Up / Page Down | previous / next slide |

Key mapping is a pure function `chordToIntent(chord, state)` in the state module, tested as a table.

**Text editing.** Entering text mode sets `selection.kind = "text"`. The view's inline editor
renders the body as `contenteditable` but calls `preventDefault()` on every `beforeinput` and reports
a `TextInput`, so React owns the page. Every input type a browser sends has a variant: typing,
`insertReplacementText` (spell check, autocorrect; the range from `getTargetRanges()`), paragraph and
line breaks, tab, deletes by character, word and line, cut, paste and drop (plain or rich), the
browser's own undo and redo (routed to the editor's history) and the formatting commands. Paragraph
commands act on every paragraph overlapping the selection. `typingStyle` carries "bold at the caret".

**Input method composition.** Composition cannot be prevented; the browser writes provisional text
into the page. `compositionStarted { anchor, focus }` records the start (a selected range is deleted
first) and freezes that body: the view renders `textEditing.composition.frozenBody`, never a newer
snapshot, so a remote edit to the same body cannot make React reconcile text the browser wrote
(the `removeChild` crash). Remote changes only move `startIndex`. `compositionEnded { text }` inserts
at the moved index and bumps `renderGeneration`, which the view puts into the paragraphs' keys so
React remounts them.

**Clipboard.** The browser only allows clipboard writes inside the user's event, and Safari refuses
them after an asynchronous hop, so the view does it: its `copy` and `cut` handlers call
`clipboardContentFor(currentState())` synchronously and fill the DataTransfer with
`application/x-sasha-engine+json`, the rendered markup and plain text, then dispatch `copied` or
`cutRequested`. Menu copy uses `BrowserCapabilities.writeClipboard` inside the click handler; in the
add-on dialog, where the frame chain does not delegate the asynchronous clipboard, the menu items say
to use the keyboard shortcuts. Paste parses the DataTransfer into `PastedContent`. A `cut` payload
pasted into the same deck keeps element and slide ids that are free (a move keeps its comments);
anything else is re-identified with morph keys kept, offset by 10 units per consecutive paste, and
scripts pasted into another deck arrive unapproved. Images go through `uploads` and `AssetStore.put`.

**Measured layout.** Two things the document cannot know without rendering:

- *Table row heights*: Slides grows rows to fit their text, so the visible height is not the stored
  one. The view measures after layout and dispatches `layoutMeasured { kind: "table", rowHeights }`;
  the reducer keeps it in `measuredLayouts`, and selection bounds, hit tests, alignment and snapping
  use the measured height. Never written to the document by itself.
- *Text boxes that grow* (`autofit: "resizeShape"`, the default for new text boxes and common on
  import): the view reports `layoutMeasured { kind: "text", contentHeight }`; when the element is
  being edited by THIS editor and the needed height differs from the frame by more than half a unit,
  the reducer queues a `setFrames` with `mergeWithPrevious`, so the growth joins the typing undo
  step. Only the typing editor writes, so two collaborators never fight over a box's height.

**Alignment and distribution** are pure functions over rotated bounds (measured where present); one
element aligns to the slide; distribution needs three or more and keeps the outermost two fixed.

**Layout change.** `slideLayoutChosen` becomes one envelope from the pure `remapSlideToLayout`:
placeholders matched by `(role, index)` keep their text and take the layout's frame; unmatched ones
stay; layout placeholders without a match are added empty.

**Errors.** The reducer reports and keeps the last good state. Feedbacks catch per effect, report via
`reportError`, and emit a notice event; the upload feedback retries with exponential backoff (3
attempts, 0.5 seconds doubling) and a 20 second timeout per attempt, all on the injected scheduler.

## 8. Rendering (view module)

- One renderer, three outputs (`render.ts`): `StaticSlide` (presenter, thumbnails), the editable
  canvas (adds the gesture preview, the inline text editor, the handles overlay), and
  `renderSlideMarkup` (a markup string through `renderToStaticMarkup`, for the transition sandbox).
- Slide root: `.sasha-slide-root`, `position: relative; width: 1280px; height: <pageHeight>px;
  overflow: hidden`, the deck background, scaled by one `transform: scale(k)` on a wrapper with
  `transform-origin: 0 0`.
- Leaf element: `position: absolute; left: x; top: y; width; height; transform: rotate(rdeg)
  scale(flipX, flipY)`; `opacity`. A group is a `position: absolute; inset: 0` wrapper with the data
  attributes and its children inside in slide coordinates; nothing is transformed twice.
- Rectangle family: a box with `border-*-width/style/color` per side (dash mapping: dot to dotted,
  dash and long dash to dashed, dash-dot variants to dashed; exact patterns via a vector overlay
  later), `border-radius` per corner, `background` for fills, `box-shadow`. Other presets: one
  vector `<path>` scaled to the box with `fill`, `stroke`, `stroke-dasharray` and
  `filter: drop-shadow`; text sits in a layer above the path inset by the preset's text box.
- Text: a flex column for vertical alignment; each paragraph a `<div>` with alignment, line height
  (`lineSpacing` x 1.2 of the font size), spacing and indents; list markers as an absolutely
  positioned span (numbering by `listId` and level); runs as `<span>` with inline styles; a link to a
  slide navigates in the presenter; the automatic slide number prints `slideNumber`. Font sizes are
  slide units; the properties panel shows points (`pointsFromSlideUnits`).
- Shrink on overflow: a layout effect measures `scrollHeight` against the box and scales the text
  layer (steps of 2.5 %, minimum 25 %). Resize to fit: measured and reported (section 7).
- An unsupported element or value draws a hatched placeholder in the element's frame with "made with
  a newer version" on hover.
- Fonts: the page loads the deck's families from Google Fonts on demand.
- Memoisation: `React.memo` on slide and element components, keyed by snapshot identity.
- Thumbnails: the same `StaticSlide` at filmstrip scale; a virtualised list beyond 40 slides.

## 9. The editor chrome (view module)

Layout (desktop, at least 1024 pixels wide; narrower, the panel collapses into a sheet):

```
┌ top bar (panel): logo · deck title · menus File Edit View Insert Slide Arrange Help · peers · Comment · Present ┐
├ toolbar (panel): undo redo · select · text box · shape ▾ · line ▾ · image · table ▾ · paint format · comment · zoom ┐
├ filmstrip (panel, 200 wide) ┬ canvas (calm ground, slide centred) ┬ properties panel (panel, 300 wide) ┤
│ thumbnails, numbers,      │ selection overlay, guides, pins     │ pill tabs: Arrange Fill Border     │
│ skip/transition/comment   ├─────────────────────────────────────┤ Effects Text Slide Transition       │
│ badges, drag to reorder   │ speaker notes (panel, collapsible)  │ (comment rail replaces it)          │
└───────────────────────────┴─────────────────────────────────────┴────────────────────────────────────┘
```

Properties panel controls (each dispatches one event): Arrange (x, y, width, height, rotation,
aspect lock, flip, order, align, distribute, group); Fill (none, solid, linear and radial gradient
with stops and angle, image with fit; colour picker in a popover: theme swatches, recent, hexadecimal
entry, alpha); Border (none, uniform or per side with a four-side toggle diagram, width, colour,
dash, corner radius uniform or per corner); Effects (shadow on or off, offset, blur, spread, colour;
opacity); Text (family from a curated Google Fonts list plus the theme's two, size in points, weight,
italic, underline, strikethrough, colour, highlight, link, baseline, letter spacing, case;
alignment, line spacing, spacing above and below, indents, list type and glyph; vertical alignment,
padding, autofit); Slide (background, layout, skip); Transition (none, five built-ins with duration,
easing and direction, or a scripted transition; "Preview" mounts the presenter's
`TransitionPreview`; "Edit script" opens the script dialog). Mixed values show an empty field with
a "mixed" placeholder; controls for an element's `unsupportedKeys` are disabled with an explanation.

The script dialog is a plain-text code editor (system monospace, Tab inserts spaces) over
`TransitionScriptEditor` state, with the authoring reference, "Run" (`TransitionPreview`), "Save"
(a person's save approves the text), and the conflict choice "reload theirs" or "overwrite" on
`staleScript`. An unapproved script shows who wrote it, the full text, and "Approve".

Menus and the context menu are `.sasha-popover`s with keyboard navigation (arrow keys, Enter,
Escape, type-ahead). Dialogs are `.sasha-dialog`s on a `.sasha-scrim`. Notices stack bottom-left as
`.sasha-notice`s with an optional action. Every control has an accessible name; focus rings use
`--sasha-focus-ring` at `--sasha-control-focus-ring-width`.

## 10. The presenter (presenter module)

State and events: `presenter.ts`. Behaviour:

- **Entering**: the view's Present handler calls `requestFullScreen` on the presentation host
  element and, for the speaker view, `openSpeakerWindow`, synchronously inside the click or key
  event; then it dispatches `presentRequested` and mounts `Presentation` with the window it got.
  The presenter never calls either itself. In the add-on dialog, Present opens the deck in a
  top-level tab instead (section 14).
- The slide is letterboxed on black and scaled to fit.
- Keys: Right, Down, Space, Page Down, Enter, N -> next; Left, Up, Page Up, Backspace, P -> previous;
  Home / End -> first / last; digits then Enter -> that slide; B / W -> black / white screen (any key
  resumes); S -> speaker view (the key handler opens the window); Escape -> exit (to the slide being
  shown). Click -> next; right click -> previous.
- The playlist omits skipped slides; after the last slide an "end of presentation" screen with the
  lively shapes, then exit.
- Controls (previous, number, next, speaker view, exit) are a `.sasha-card` pill bar at the bottom
  that fades out after 2.5 seconds without pointer movement.
- Speaker view: rendered by portal into the caller's window from the same state: current slide,
  next slide, speaker notes (read only), elapsed timer, clock, slide n of m, the same controls.
- Pressing next during a transition cancels it and shows the incoming slide; the next press
  navigates.
- The presenter's RxFeedback system is built with the injected `RxFeedbackToolkit` (the state
  module's implementation), so the presenter never imports the state module.

## 11. Transitions

Protocol, limits and authoring interface: `src/contracts/transition-protocol.ts`.

**Two hosts, one interface.** Built-ins (`fade`, `push`, `slide`, `zoom`, `morph`) are our own
TypeScript `TransitionDefinition`s under `src/presenter/builtin/` and run in the presenter's own page
with Web Animations on two `StaticSlide`s: nothing serialised, no second site, nothing to wait for on
each Next press. Only scripted transitions run in the sandboxed runner. Both hosts give a
transition the same `TransitionContext`; one integration test runs a built-in through the runner to
exercise the protocol. Under reduced motion, unapproved or missing scripts, the host plays its own
150 millisecond fade (`substitutedFade`) instead and records why. A spare runner is warmed only while
the playlist contains a scripted transition.

**Morph** pairs leaves by morph key (`pairs()`); each pair interpolates the UNROTATED frame (x, y,
width, height) and the rotation separately and cross-fades content; unpaired outgoing leaves fade
out, unpaired incoming leaves fade in. Groups are wrappers and are never animated themselves.

**Sandboxed lifecycle** (one `TransitionRun` at a time, its frame owned by a `reactSet` feedback;
deadlines count only while the page is visible):

| Phase | Host does | Runner does | Deadline (`TRANSITION_LIMITS`) | On miss |
|---|---|---|---|---|
| awaitingRunner | uses the warm spare runner, or creates one | bootstrap loads, posts `runnerReady` via `window.postMessage`; host transfers a `MessagePort` in `connect` | 3000 milliseconds | cut, `runnerNotReady` |
| preparing | renders both slides with `renderSlideMarkup`, gathers fresh copies of asset bytes and font bytes, checks every size limit, posts `prepare` with the bytes transferred | substitutes asset tokens with its own blob addresses, loads fonts with `FontFace`, builds the stage, evaluates the script (it must call `sashaTransition.define`), waits for image decoding; posts `prepared` | 2000 milliseconds, host gathering included | cut, `prepareTimedOut`; too big: `scriptTooLarge` / `transferTooLarge` before posting |
| prepared | posts `start` | posts `started`, calls `run(context)` | - | - |
| running | sends `ping` every 250 milliseconds on the port | the bootstrap answers each `ping` with `pong` and progress; `finished` when `run` resolves, `failed` on a throw | a ping unanswered for 2000 visible milliseconds: stalled; duration + 1000 milliseconds: overran | cut, `stalled` / `overran`; `failed` -> cut, `scriptFailed` |
| done | swaps in the real incoming `StaticSlide`, removes the frame, warms the next spare if needed | - | - | - |

The host shows the runner frame only from `started` to done; until then the outgoing slide stays on
screen, so a slow prepare looks like a short pause, never a blank frame. Heartbeats are answers to
host pings, not animation frames: browsers stop animation frames for hidden and occluded windows
(the speaker view covering the audience window), and a background tab throttles the host's own
timers to about one a second, which is why deadlines pause while the page is hidden.

**Security** (protocol header): `sandbox="allow-scripts"` only (opaque origin), `inert` (no focus,
no pointer input, so no captured keystrokes and no clickable fake sign-in page), `allow=""`,
`referrerpolicy="no-referrer"`, a runner page whose content security policy allows no network, the
channel established by checking `event.source` and the "null" origin and then a private
`MessagePort`, every message parsed and its `runId` checked, sizes capped (script 256 kilobytes,
stylesheet and overlay markup 64 kilobytes each, slide markup 2 megabytes, transferred bytes 32
megabytes, logs 50 per run of at most 500 characters). Only approved scripts run (`TransitionApproval`:
a person's save or explicit approval covers one `scriptFingerprint`; an agent's write and a paste
from another deck are unapproved). **Residual leak, documented**: a sandboxed frame can still navigate
itself and carry slide text in the address; no content security policy directive can forbid that any
more. The channel reaches only the script's author, whom an approval vouched for, and the host ends
the run with `runnerNavigated` on the frame's second `load`. The runner is served from a different
site than the editor so a `while (true) {}` runs in another process and the host's deadlines still
fire; milestone 1 proves it with a busy-loop script. A host that cannot serve a second site (a local
file) falls back to `srcdoc` and says so in diagnostics.

**Writing a transition** (what Claude does). The repository keeps this example as a string constant
in `src/presenter/examples/ink-wipe.ts`, because the engine ships no hand-written JavaScript files; a
script is data the runner evaluates:

```js
sashaTransition.define({
  name: "Ink wipe",
  async run(context) {
    const { outgoing, incoming, overlay, durationMilliseconds, direction } = context;
    if (outgoing === null || context.reducedMotion) {
      await context.animate(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 }).finished;
      return;
    }
    const sweep = direction === "forward" ? ["inset(0 0 0 100%)", "inset(0 0 0 0)"] : ["inset(0 100% 0 0)", "inset(0 0 0 0)"];
    // The incoming slide is beneath; put it on top and reveal it with a moving clip.
    incoming.style.zIndex = "2";
    overlay.style.background = "radial-gradient(circle at 50% 50%, rgba(28,35,51,.18), transparent 70%)";
    const reveal = context.animate(incoming, [{ clipPath: sweep[0] }, { clipPath: sweep[1] }],
      { duration: durationMilliseconds, easing: "cubic-bezier(.6,0,.2,1)" });
    for (const element of context.elements("incoming")) {
      context.animate(element.node, [{ transform: "translateY(12px)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: durationMilliseconds * 0.6, delay: durationMilliseconds * 0.4, easing: "ease-out", fill: "both" });
    }
    await reveal.finished; // rejects on abort, which ends the run as the presenter asked
    overlay.style.background = "";
  },
});
```

The agent writes a script with the connector (milestone 2 tool `deck_write_transition`, which issues
`upsertTransitionScript` as an agent, so it lands unapproved) and assigns it with
`setSlideProperties { transition: { kind: "scripted", scriptId, durationMilliseconds, parameters } }`.
The user sees a notice "Claude wrote a transition: review it", approves it in the script dialog, and
keeps editing the slides normally; the transition only ever sees rendered snapshots.

## 12. Comments, annotations, presence

Types: `discussion.ts`, `presence.ts`.

- **A server-authoritative append-only log, not a shared document.** "Only the author may edit a
  message" cannot be enforced on a shared Yjs document (any commenter's client can rewrite any item,
  and a server cannot partially accept a Yjs update), and comments need no automatic merging. A
  client submits `DiscussionRequest`s; the authority (the in-memory store in milestone 1, the deck
  server in milestone 2) checks them against the requester, stamps `actor` and `at`, appends a
  `DiscussionLogEntry`, and every replica folds the log with the pure `reduceDiscussionLog`. Thread
  status is one folded value, so a concurrent resolve and reopen cannot leave a half-resolved
  thread. The editor queues requests in `pendingDiscussion`, shows them as "Sending..." from
  `inFlightDiscussion`, and settles them with `discussionSettled`.
- **Anchors**: a slide, an element, or a text range (Yjs relative positions via
  `DocumentStore.encodeTextAnchor`, resolved after each change by a feedback into
  `resolvedTextAnchors`). For an element or text target, `region` and every marking are fractions of
  the element's frame, so they move with the element; for a slide target, fractions of the slide.
  Markings (pen, rectangle, arrow, highlight) all use that one unit.
- **Degrading, not disappearing**: the pure selector `arrangeThreads` places each thread: on its
  element; at `elementFrameAtCreation` with "the element was removed"; on its slide; or under "on
  deleted slides". Cut and paste within a deck keeps ids, so it does not orphan comments.
- Creating a comment: the comment tool or primary+Alt+M; drag to set a region, optionally draw
  markings, type, submit. The rail (cards, newest activity first, filter open or resolved) shows
  threads for the current slide first; pins on the canvas are numbered glass dots.
- Resolve and reopen never enter the undo history.
- Claude is a `Person` with `kind: "agent"`: it reads and answers threads through the connector, as
  the comment bot already does for Google Slides comments.
- **Presence**: the editor publishes `LocalPresence` (current slide, selection, pointer, activity)
  throttled on the scheduler to one update per 50 milliseconds; peers render as cursors in their
  scheme's peer colour with name labels, selection outlines, and avatars on the filmstrip thumbnail
  they are on. Peers older than 30 seconds show as away and drop after 2 minutes.

## 13. Persistence and sync (milestone 2)

- **Where**: in the connector (`mcp/sasha-slides/http/`), because it already owns accounts,
  sessions, per-account encryption keys and the brokered Google grants. New files: `deck-server.ts`
  (routes), `deck-store.ts` (persistence), `deck-access.ts` (access list). nginx routes `/deck`,
  `/deck/*`, `/deck-api/*` and `/deck-sync/*` to the connector (`nginx-routing.test.ts` grows).
- **Transport**: one WebSocket per open deck, `wss://sashaslides.com/deck-sync/<deckId>`, carrying
  Yjs sync (step 1, step 2, update), awareness, and discussion requests and log entries as a third
  message type. Dependencies added then: `y-protocols` (engine and server) and `ws` (server). The
  engine side is a sync feedback that applies remote updates under `REMOTE_SYNC_ORIGIN`, maps
  awareness to `PresenceChannel`, and implements `DiscussionStore` over the log.
- **Storage**: per deck, `data/decks/<deckId>/document.log` (length-prefixed Yjs updates, appended,
  flushed every 250 milliseconds) plus `document.snapshot` (`Y.encodeStateAsUpdate`), compacted past
  1 megabyte or 500 updates, and `discussion.log` (the append-only entries). All sealed with the
  owning account's data key (`account-vault.ts`), so erasing an account erases its decks. Assets:
  `data/decks/<deckId>/assets/<sha256>`, sealed the same way, served at
  `/deck-api/<deckId>/assets/<sha256>` with immutable caching; unreferenced ones are collected only
  here.
- **Access**: owner, editors, commenters, viewers, plus link sharing off, view or comment. Commenters
  may send discussion requests only; viewers send nothing. Updates over 1 megabyte are refused; 20
  messages per second per connection, burst 100.
- **Repairs**: the server's replica runs `repairPolicy: "repairAfterTransaction"`; clients run
  `"reportOnly"`.
- **Authentication**: the web application uses a deck session cookie (`Path=/deck`, HttpOnly,
  Secure, SameSite=Lax, 15 minutes, renewed while active) minted by the existing `/account` sign-in.
  Embedded in the add-on it uses the handoff in section 14.
- **Agent tools** (connector): `deck_read` (snapshot of a deck or slide), `deck_apply` (a list of
  `DocumentCommand`s with `author: { kind: "agent", agentSessionId }`, run server-side through the
  same `DocumentStore` on Node), `deck_write_transition`, `deck_revert`, and the discussion tools.
  **Undoing Claude**: the server keeps one `Y.UndoManager` per agent session, tracking that
  session's transaction origin; `deck_revert { agentSessionId }` undoes its steps with the same
  collaborator rules as a local undo. Clients learn of agent edits from a side message and dispatch
  `agentEditObserved`, which raises a notice with the action "Undo Claude's edit".

## 14. Add-on embedding

**Confirmed: the add-on embeds the web application; it does not bundle the engine.** HtmlService pages
must stay under 500 kilobytes (`SURFACE_BUDGET_BYTES` in `addon/build-addon.ts`) and `Dialog.html`
already uses 482. The engine is estimated at 350 to 450 kilobytes minified (React 19 about 190, Yjs
about 85, the RxJS operators used about 30, the engine about 150), so it cannot share a page with
anything, and HtmlService's comment stripper has already corrupted a large inline bundle once.

**Gated until milestone 3.** Until export exists, edits made in an embedded editor would never
appear in the Slides document behind it, which users would read as data loss. So the embedded dialog
ships with milestone 3's "Export to this presentation"; in milestone 2 the sidebar only offers
"Open in Sasha (separate deck)", which opens a top-level tab with that label.

Plan (milestone 3):

1. `Code.gs` gains `sashaOpenEditor()`: a 3 kilobyte HtmlService shell, `showModalDialog` at the
   largest size Slides allows, holding one `<iframe src="https://sashaslides.com/deck/<deckId>?embed=addon">`.
2. **Which presentation, and who.** `sashaEditorHandoff()` returns three things: the presentation id,
   `ScriptApp.getIdentityToken()` (needs the `openid` and `email` scopes, one re-consent), and a
   DECK BINDING SECRET: 32 random bytes kept in `PropertiesService.getDocumentProperties()`, created
   on first use. Only people who can run the bound script in that presentation (its editors) can read
   it, so possession proves access to this presentation -- the client-supplied presentation id alone
   proves nothing, and a Drive check with a brokered grant would fail for Slides users who never
   signed in to sashaslides.com. The shell posts the three to the frame; `POST /deck-api/handoff`
   verifies the token's signature, expiry and issuer, and that its audience equals the value PINNED
   after decoding one real token (it is the auto-created script project's client, project
   `342987503423`, which this team cannot configure), maps the email to an account (creating one),
   binds the secret's hash to a deck on first use, and returns a 15-minute bearer token kept in
   memory and sent as the WebSocket subprotocol.
3. `/deck/*` answers with `Content-Security-Policy: frame-ancestors` listing exactly the origins
   measured from inside the embedded page with `location.ancestorOrigins` (expected
   `https://docs.google.com` and the HtmlService sandbox host under `*.googleusercontent.com`), never
   a guess.
4. **What the frame chain cannot do.** Full screen and the asynchronous clipboard need
   `allow="fullscreen; clipboard-write"` on every ancestor frame, and the HtmlService frames do not
   delegate them. So `EditorEmbedding.kind === "addonDialog"`: Present opens the deck in a top-level
   tab (`BrowserCapabilities.openTab`, from the click), and menu copy and paste say to use the
   keyboard shortcuts (the `copy` and `paste` events work inside frames). A notice offers "Open in a
   new tab" for anything else the dialog limits.

## 15. Google Slides import and export (milestone 3)

- **Import** (server side, with the user's brokered grant): `presentations.get` -> commands on a
  fresh Y.Doc. Mapping: page size in English metric units / 7143.75 -> slide units; `shape` ->
  `ShapeElement` (Slides `ShapeType` -> `ShapePreset`, others -> the nearest preset plus an import
  note); the affine `transform` and `size` -> one `frame`; text runs and paragraph styles ->
  `TextBody` (points / 0.5625 -> units; `autoText` -> `automaticText`); `image` -> fetch
  `contentUrl` (valid 30 minutes) into the asset store; `line` -> `LineElement`; `table` ->
  `TableElement`; `elementGroup` -> group with its rotation; `sheetsChart` -> image from its
  `contentUrl`; `video` -> placeholder until video lands; masters and layouts -> theme
  (`placeholderStyles` from the master's placeholders) and layouts; notes page body ->
  `speakerNotes`; `slideProperties.isSkipped` -> `skipped`; text boxes keep `resizeShape` autofit.
  Element ids are kept (they are valid Slides object ids by construction, `ids.ts`).
- **Export**: two paths, chosen per element.
  1. Native mapping for what Slides expresses (text, rectangle family with uniform borders, presets,
     images, lines, tables, groups, backgrounds, notes, skip): `createShape`, `insertText`,
     `updateTextStyle`, `updateParagraphStyle`, `createParagraphBullets`, `updateShapeProperties`,
     `createImage`, `createLine`, `createTable` and friends, reusing `converter/emit-text.ts`,
     `slides-paint.ts` and `geometry.ts` for the field encodings.
  2. Composition for what it does not (per-side borders, per-corner radii, radial gradients,
     blur and spread shadows): adapt the element into the converter's `SlideElement` extraction type
     and call the pure `emitSlideRequests` (`converter/emit-requests.ts`), which already implements
     the border-strip and ROUND_1 corner compositions documented in
     `renderer/html2slides/extract-dom.ts`, and reports losses as `UnsupportedFeature`.
  Re-export keeps a binding (`meta.googleSlides = { presentationId, pageIds }`) and replaces slides
  in place (delete and recreate the page under its object id); a diffing exporter later. The Slides
  programming interface cannot set transitions at all, so transitions, built-in and scripted, are
  dropped on export with a note in the export report.

## 16. Packaging and build

- Package `mcp/sasha-slides/engine`, private, ECMAScript modules, TypeScript only. Dependencies:
  `yjs`, `rxjs`, `react`, `react-dom`; development: `typescript` 6, `tsx`, `esbuild`, `@types/*`.
  Milestone 2 adds `y-protocols`. Nothing else without a line here. The architect owns
  `package.json`, `package-lock.json` and the `tsconfig` files; a builder that needs a dependency or a
  script asks.
- `tsconfig.json` (browser, no Node types) and `tsconfig.test.json` (tests, build scripts,
  end-to-end drivers, with Node types); `npm run typecheck` runs both. The strict flag set matches the
  add-on's.
- `npm test`: typecheck, then `node --test --import tsx "src/**/*.test.ts"`.
- Every entry point (the demo page, the deck page, the speaker window's bootstrap) imports
  `src/platform/explicit-resource-management.ts` FIRST: Safari lacks `Symbol.dispose`, and the
  engine's objects are `Disposable`.
- `build-demo.ts` (view module): esbuild bundles `src/view/application/demo.tsx` ->
  `dist/demo/editor.js` (minified, with a source map), writes `dist/demo/index.html` and `editor.css`
  (`tidepoolStylesheet(TIDEPOOL_TOKENS)` plus the view's own rules), and calls
  `buildPresenterAssets` from the presenter's `build-presenter.ts` (`module-surfaces.ts`), which
  bundles the runner bootstrap (`src/presenter/runner/`) into `dist/runner/index.html` and returns
  the runner's content security policy. Built-in transitions are ordinary modules in the editor
  bundle. `--serve` serves the editor on `http://127.0.0.1:8790` and the runner, with its policy
  header, on `http://localhost:8791` (different sites). Long-running serves are started
  `setsid`-detached, never as a bare background shell.
- Milestone 2: the same entry, built as `dist/deck/` and served by the connector at `/deck/<id>`;
  the runner at a separate registrable domain (to buy; until then the `srcdoc` fallback with its
  diagnostic).

## 17. Testing

- **Unit, node:test**: contracts (ids, geometry, text deltas: already 54 tests with the theme), model
  (every command, rejection, undo and redo with selection, collaborator-overwritten steps, snapshot
  sharing, attribute rules, validation and repair policy, discussion log), state (reducer tables,
  ordering under fast typing, remote caret moves, composition, gestures, key map, feedbacks against
  fake stores with a virtual-time scheduler, replay purity), view (React to static markup asserting
  the styles each feature produces; input-type mapping), presenter (reducer, in-page built-ins,
  sandbox lifecycle with a virtual-time scheduler and a fake port, message validation, limits).
- **Convergence property tests**: three replicas, seeded random command sequences applied in
  different interleavings with `connectInMemory`, must produce identical snapshots; 200 seeds, under
  30 seconds.
- **End-to-end in Chrome** over the debugging protocol (`:9222`, headless): drivers in `e2e/` take
  screenshots into `/tmp/sasha-engine-e2e/`, which are inspected by a sub-agent (never in the
  orchestrator context). Timeouts are seconds, polling for observable state, per the project rules.
- **Performance budget**: with 200 elements on a slide, one pointer move during a drag (event ->
  reduce -> render) stays under 4 milliseconds of main-thread time, measured with
  `performance.measure` while the calm wash runs.

## 18. Milestone 1 modules

Four modules with disjoint owned paths, buildable in parallel against `src/contracts/` and
`src/theme/`. The architect owns `src/contracts/**`, `src/theme/**`, `src/platform/**`,
`src/module-surfaces-check.ts`, `package.json`, `package-lock.json`, `tsconfig*.json` and this
document, and has already built `src/theme/` and the stubs; builders request changes instead of
editing them. Each module's `index.ts` starts as the architect's stub and keeps its exported names
and types.

| Module | Owns | Builds |
|---|---|---|
| model | `src/model/**` | Yjs schema, typed reads, command application, fractional indexing with random suffixes, undo manager with relative-position selections and skipped steps, snapshots with structural sharing and cycle-safe groups, text deltas per change, validation and repair policy, text anchors, the memory discussion store and `reduceDiscussionLog`, memory asset store, in-memory sync and presence |
| state | `src/state/**` | RxFeedback core with the two-queue mailbox (own tested copy), editor reducer, id minting, gestures on the geometry rules, text editing and composition, index transformation, clipboard selector, keyboard, nudges, alignment and distribution, measured layout and text box growth, layout remapping, `arrangeThreads`, feedbacks (apply edits, store changes, discussion, text anchors, uploads, assets, presence, notices) |
| view | `src/view/**`, `build-demo.ts`, `e2e/editor/**` | renderer, canvas and overlays, inline text editor with the full input-type parser, measurement, properties panel, toolbar, menus, dialogs (including the script dialog), filmstrip, comment rail, notices, the view's own Tidepool rules on top of `src/theme/`, the application shell and demo and its build |
| presenter | `src/presenter/**`, `build-presenter.ts`, `e2e/presenter/**` | slideshow, keyboard, speaker view by portal, in-page built-in transitions, the sandboxed runner host and bootstrap, protocol validation, pings and visibility-aware deadlines, substitutions, the scripted example, `TransitionPreview`, the runner build |

Acceptance tests per module are in the architect's structured summary and are repeated as the first
test file each builder writes.

## 19. Risks and open questions

- **Site isolation for the runner** is the one assumption a test must confirm early (presenter
  acceptance test "busy loop"). If Chrome keeps a cross-site sandboxed frame in-process in some
  configuration, the fallback is a Worker-based runner that animates an `OffscreenCanvas` (losing
  page-level morphing), decided then.
- **A second registrable domain** is needed in production for the runner.
- **Yjs undo across concurrent edits** can resurrect deleted content in rare interleavings; the
  repairing replica repairs dangling references (a child whose group vanished moves to the top level,
  in front, in key order -- the place the snapshot already showed it; yjs-schema.ts).
- **`contenteditable` with full `beforeinput` interception** is the largest view risk; Firefox and
  Safari differences in input-type coverage are handled by the parser and tested in Chrome first.
- **The audience of the add-on identity token** must be pinned from a real token before the handoff
  route ships (section 14).
- **Font licensing for the sandbox**: fonts travel as bytes; only Google Fonts families (open
  licences) and system fonts are offered, so redistribution inside the user's own browser is fine.
- **Scope creep in presets**: adding one is a vector path plus a Slides `ShapeType` mapping.

## 20. Review points not taken as proposed

Revision 2 took 42 of the 45 review points as proposed (choosing among the alternatives the review
offered where it offered several: the frame as one value for undo, explicit "none" values, plain-string
scripts, a server-authoritative comment log, removing the panel blur, gating the add-on dialog). Three
were taken only in part:

- **42, "the architect builds `src/rxfeedback/` before the parallel phase"**: the RxFeedback core
  stays in the state module, which the module split assigns it to, and it is small. The coupling the
  point identified is removed differently: the presenter receives `createSystem`, `react` and
  `reactSet` as an injected `RxFeedbackToolkit` and never imports the state module; its reducer and
  feedbacks are tested directly. Every other part of point 42 was taken: the architect built
  `src/theme/`, owns `package.json`, ships stubs for every module's surface (including `Presentation`,
  `TransitionPreview` and `buildPresenterAssets`), and the view's preview uses the presenter's
  `TransitionPreview`.
- **5, "add `at: number` to every event that creates time-stamped data"**: not needed once the stores
  stamp times. Ids come from `idSeed` as proposed; `createdAt`, `resolvedAt` and `editedAt` are
  stamped by the discussion authority (which must stamp them anyway, a client's clock is not
  trusted), `updatedAt` by the model, and notices need no time (their expiry is a scheduler timer).
  The reducer stays pure with fewer fields.
- **2, "this also removes the need for `staleText`"**: the delta log in the store is gone as
  proposed, but `staleText` stays as a guard rejection. The ordering rules make it unreachable; if
  they are ever broken, a visible rejection is better than a keystroke applied at the wrong index.

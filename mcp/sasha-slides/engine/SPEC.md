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
6. **Google Slides import and export** (pulled into milestone 2, section 21.12), reusing
   `mcp/sasha-slides/converter`.

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
| Chrome is liquid glass | milestone 2 (section 21.11): panels are white at 0.26 to 0.45 (`--sasha-panel-glass`), a bright 1 pixel top edge, a soft lift shadow, and `backdrop-filter: blur() saturate()` ONLY while `data-gesture` is not `active` on the engine root, so a drag never re-blurs the animated wash behind three full-height panels (milestone 1 had no panel blur for that reason). Text on the more translucent glass is darkened until every pair still passes 4.5:1 over every sampled wash colour |
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
| Comments: anchored, threaded, resolvable | Milestone 1 (local) | shared in milestone 2, with mentions (section 21) |
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
| Import from Google Slides | Milestone 2 | section 21.12 |
| Export to Google Slides | Milestone 2 | section 21.12 |
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

> Revision 3: section 21 is the milestone 2 design and wins wherever it differs from sections 13
> to 15 (the API cookie path, the WebSocket address, storage records, the add-on no longer gated).

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

> Superseded in part by section 21.13: export ships in milestone 2, so the embedded editor ships
> with it, opened from a new add-on menu item "Open in Sasha editor".

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

> Pulled into milestone 2; section 21.12 has the full mapping tables and wins where they differ.

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

## 21. Milestone 2

Milestone 2 makes decks shared and reachable: a deck server inside the connector, the web
application at `sashaslides.com/decks` and `sashaslides.com/deck/<id>`, the shared discussion with
presence, Google Slides import and export with the add-on embedding, and Claude's deck tools.
Contracts: `src/contracts/collaboration.ts` (the WebSocket protocol and the editor's status),
`deck-access.ts` (roles and permissions), `deck-api.ts` (HTTP), `assistant-deck-tools.ts` (the
tools' vocabulary) and, on the connector side, `mcp/sasha-slides/deck-contracts/deck-service-contract.ts`
(the seams between the three connector modules). Where this section differs from sections 13 to
15, this section wins.

### 21.1 Decisions

| Decision | Chosen | Why not the alternative |
|---|---|---|
| Where the deck server runs | **Inside the connector process**, on its `node:http` server (WebSocket upgrade on the same port) | A sibling process would need its own copy of accounts, sessions, the vault and the brokered Google grants, plus an internal API for the MCP tools to reach live rooms. In-process, an agent edit is a function call on the room every editor is connected to. Cost: one instance only (rooms are in memory); `DEPLOY.md` says never scale the connector past one replica |
| Engine code on the server | The connector imports `engine/src/model/` and a new platform-free `engine/src/server/` (the room: Yjs sync, awareness relay, enforcement guard, discussion authority). Connector files NEVER import `yjs` or `y-protocols` themselves | One copy of Yjs: the engine's `node_modules` in development, `/app/node_modules` in the image. A second copy breaks Yjs's `instanceof` checks and prints "Yjs was already imported" |
| How a rule a client cannot be trusted with is enforced | **Correct, never reject** (collaboration.ts header): apply the editor's update in its own transaction, inspect the protected fields it changed, write a correction, broadcast the update merged with its correction | A Yjs update cannot be partially accepted, and refusing one strands the sender's replica ahead of everyone (every later update depends on it). Moving approvals out of the document into a server log would have re-plumbed the model, state, presenter and view of milestone 1 for the same guarantee |
| Session for the web application | Cookie `sasha_deck; Path=/deck-api; HttpOnly; Secure; SameSite=Strict`, 12 hours, minted at `/account/deck-session` | Pages are static shells, so only the API needs it; Strict is possible because only our own pages call the API |
| Session inside the add-on dialog | Single-use ticket in the frame's address fragment, exchanged for a 15-minute bearer token kept in memory | Third-party frames get no cookies (and browsers block third-party cookies outright) |
| Comments, presence | Same socket: discussion as JSON text frames, presence as Yjs awareness | One connection per open deck; one place for authentication, rate limits and reconnection |
| Google writes from the add-on | The add-on's own authorization (Apps Script advanced service `Slides`) runs the server-built requests when the account has no Google grant on the server | An add-on user may never have signed in to sashaslides.com with Google; the add-on already holds `presentations` authority for the open presentation |

### 21.2 Endpoints

All under `https://sashaslides.com`. "Cookie" means the deck session cookie or, inside the add-on,
the bearer token; every state-changing request with a session also needs `X-Sasha-Csrf` and an
`Origin` equal to the public origin. Non-2xx answers carry `DeckApiErrorBody`. Unknown decks and
decks the caller cannot read are both 404, so membership is not disclosed.

| Method and path | Who | Permission | Answer |
|---|---|---|---|
| GET `/decks` | anyone | - | list page shell (`manifest.listPage`), `Content-Security-Policy: manifest.contentSecurityPolicy` |
| GET `/deck/<deckId>` | anyone | - | editor shell; with `?embed=addon`, `manifest.embeddedContentSecurityPolicy` (frame-ancestors `ADDON_FRAME_ANCESTORS`) |
| GET `/deck-app/<file>` | anyone | - | built assets, `Cache-Control: public, max-age=31536000, immutable`; `/deck-app/runner/<page>` with the runner policy |
| GET `/account/deck-session?return=<path>` | browser | - | signed in: sets the cookie, 303 to `return` (only `/decks` or `/deck/<valid id>`, otherwise `/decks`); signed out: the sign-in page, and after ANY sign-in method `/account` redirects back here (a 10-minute `sasha_return` cookie, `Path=/account`) |
| GET `/deck-api/session` | cookie | - | `DeckSessionBody`; renews the cookie past half its life; 401 `signedOut` with `signInAddress` (every 401 does: its `return` is the `?return=` of the request, else the path of a same-origin `Referer`, else `/decks`, so a signed-out `/deck/<id>` comes back to that deck) |
| GET, PUT `/deck-api/profile` | cookie | - | `ProfileBody` (display name 1 to 60 characters, sealed per account) |
| GET `/deck-api/decks` | cookie | - | `DeckListBody` |
| POST `/deck-api/decks` | cookie | - | 201 `CreateDeckBody`; 409 `limitReached` past 500 decks |
| GET `/deck-api/decks/<id>` | cookie | read | `DeckDetailsBody` (emails and invitations only for `share`) |
| PATCH `/deck-api/decks/<id>` | cookie | share | `UpdateDeckRequest` -> `DeckDetailsBody` |
| DELETE `/deck-api/decks/<id>` | cookie | deleteDeck | 204; open sockets close `deckDeleted` |
| POST `/deck-api/decks/<id>/members` | cookie | share | `InviteRequest` -> `InviteBody`; 100 invitations per account per day |
| PATCH, DELETE `/deck-api/decks/<id>/members/<personId>` | cookie | share (DELETE also self) | `DeckDetailsBody`; the member's sockets get `accessChanged` or close `accessRevoked` |
| DELETE `/deck-api/decks/<id>/invitations/<invitationId>` | cookie | share | `DeckDetailsBody` |
| PUT `/deck-api/decks/<id>/assets` | cookie | editDocument | raw bytes, `Content-Type` an `AssetMediaType` confirmed by magic bytes -> `AssetUploadBody`; 413 over 25 megabytes or past 512 per deck; 415 otherwise |
| GET `/deck-api/decks/<id>/assets/<sha256>` | cookie | read | bytes; `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (an SVG opened directly runs nothing) |
| POST `/deck-api/decks/<id>/agent-sessions/<agentSessionId>/revert` | cookie | revertAgentEdits | `AgentRevertBody` |
| GET (upgrade) `/deck-api/sync/<id>?discussionAfter=<n>` | cookie or bearer subprotocol | read | WebSocket, subprotocol `sasha-deck.1` (21.4) |
| POST `/deck-api/embed/session` | ticket | - | `EmbedSessionBody`; ticket single use, 2 minutes |
| POST `/deck-api/embed/renew` | bearer | - | `EmbedSessionBody` |
| GET `/deck-api/google-slides/connect?return=<path>` | cookie | - | Google consent for the `presentations` and `drive.file` scopes; back through the shared `/oauth/google/callback` |
| POST `/deck-api/google-slides/import` | cookie | - | `GoogleSlidesImportRequest` -> 201 `GoogleSlidesImportBody`; 409 `googleNotConnected` with `connectAddress` |
| POST `/deck-api/decks/<id>/google-slides/export` | cookie | exchangeWithGoogleSlides | `GoogleSlidesExportRequest` -> `GoogleSlidesExportBody` |
| GET `/deck-api/export-assets/<token>/<sha256>` | capability | - | image bytes for Google's `createImage`, 30 minutes |
| POST `/deck-api/addon/handoff`, `/deck-api/addon/import`; GET `/deck-api/addon/export/<id>`; POST `.../result` | Code.gs (identity token + binding secret) | editors of the presentation | 21.13 |

The router (collaboration server module) owns every path above and delegates the
`GOOGLE_SLIDES_ROUTE_PREFIXES`, `/deck-api/decks/<id>/google-slides/` and the shared
`/oauth/google/callback` (first, by `state`) to the Google Slides module's handler
(`deck-service-contract.ts`).

### 21.3 Authentication

- **Cookie**: `HMAC-SHA256(SASHA_SESSION_SECRET, "sasha-deck-session.v1." + payload)` over
  `{accountId, exp, csrf}`; a tampered, expired or erased-account cookie reads as signed out.
  Every request and every WebSocket upgrade re-reads the account in the directory, so erasing an
  account signs it out everywhere at once.
- **Bearer** (add-on): random 32 bytes, stored hashed in memory with `{accountId, deckId, exp}`,
  valid for that one deck only, 15 minutes, renewed by `POST /deck-api/embed/renew` 2 minutes before
  expiry. Lost on a server restart: the frame shows "Reopen from the add-on menu".
- **WebSocket**: authenticated at the upgrade only (cookie or `sasha-bearer.<token>` subprotocol,
  never echoed), `Origin` must be the public origin; the server re-checks the session's expiry on
  every heartbeat and closes `unauthenticated` (4001) when it passed; the client refreshes the
  session and reconnects.
- **Person identity**: `pr_<32 hexadecimal>` and `ag_<same>` (deck-access.ts); display name from the
  profile, else the part of the sign-in address before "@", else "Collaborator";
  `colourIndex = parseInt(first 8 hexadecimal, 16) % peerColourCount`.

### 21.4 The WebSocket protocol

```
client                                                          server
  │ GET /deck-api/sync/<id>?discussionAfter=<n>                   │ authenticate, check role, load room
  │   Sec-WebSocket-Protocol: sasha-deck.1[, sasha-bearer.<t>]    │
  │◄──────────────── 101, Sec-WebSocket-Protocol: sasha-deck.1 ───│
  │◄── text  welcome { me, role, members, discussionSequence } ───│
  │◄── binary sync step 1 (server state vector) ──────────────────│
  │◄── binary awareness (every other connection's state) ─────────│
  │◄── text  discussionEntries { entries after n } ───────────────│
  │─── binary sync step 1 (client state vector) ─────────────────►│
  │◄── binary sync step 2 (what the client lacks) ────────────────│  client: "online" after applying it
  │─── binary sync step 2 (what the server lacks) ───────────────►│  dropped unless the role edits
  │◄──► binary sync update / awareness; text discussion, heartbeat│
```

- Binary frames are exactly y-websocket's (`BINARY_MESSAGE_TYPE`); text frames are
  `ClientMessage` / `ServerMessage`, parsed at the boundary by the receiver (the server parses
  `ClientMessage`, the web module parses `ServerMessage`), unknown kinds ignored and counted.
- **Discussion**: `discussionRequest` is answered by exactly one `discussionOutcome`; a `requestId`
  among the last 1,000 is answered with its first outcome again (a retry after a reconnect never
  doubles a comment). New entries reach every connection, the sender included, in sequence order.
  A request sent while offline waits in the client's queue and is sent after the next welcome.
- **Heartbeat**: the server sends `heartbeat` every 15 seconds (and WebSocket pings, which browsers
  answer by themselves); a client that hears nothing for 40 seconds reconnects.
- **Reconnection**: full-jitter exponential backoff from 0.5 seconds doubling to 30
  (`RECONNECT_POLICY`); immediately on the browser's `online` event, on the page becoming visible
  after being hidden past a heartbeat, or on "Try now". After each close the client follows
  `RECONNECT_AFTER_CLOSE`.
- **Offline edits**: the Y.Doc keeps them; the sync step 2 after reconnecting sends them, and
  merging is Yjs's. `unsentChanges` is true from a local transaction while not online until the
  client has sent its step 2 after the next welcome and the socket's `bufferedAmount` is 0. Nothing
  is kept across a reload (not offline-first, section 1); the editor warns before unload while
  `unsentChanges` is true.
- **Resynchronise**: on `resynchroniseRequired` the web module disposes the editor, drops the
  replica and composes a fresh one from the server, then shows the notice.
- **Agent edits**: every `deck_edit` and import that runs on the room sends `agentEdit` to editors;
  the editor's notice offers "Undo Claude's edit" (`revertAgentSession`).

### 21.5 Permissions and where each is enforced

Roles and the permission table: `deck-access.ts` (owner, editor, commenter, viewer; link sharing
`off` or anyone signed in as viewer or commenter, never editor).

| Rule | Enforced at | How |
|---|---|---|
| Only members, or link sharing, can read | upgrade, every `/deck-api/decks/<id>` route, `DeckService.openDeck` | access record; 404 otherwise |
| Viewers and commenters never change the document | room, inbound sync step 2 and update | discarded; a non-empty one -> `resynchroniseRequired` (`updateFromReadOnlyRole`) |
| `approved` only by a person who may approve, naming themself and the current fingerprint | room guard after the sender's transaction (`engine/src/server`) | correction to `unapproved`, merged broadcast, `correction` to the sender |
| A changed script's `author` is its sender | room guard | correction, `scriptAuthorRestored` |
| `meta.deckId`, `schemaVersion`, `createdAt` never change | room guard | correction, `metaRestored` |
| An agent never approves; agent scripts land unapproved | model (`approvalNeedsPerson`), `deck_write_transition` saves with `"unapproved"` | rejected |
| Discussion actor and time | room discussion authority | stamped from the session and the server clock |
| Discussion permissions | room discussion authority | `comment` to create, reply, resolve, reopen; author-only edit and delete; delete a thread: its creator or `moderateDiscussion`; mentions kept only for current members, at most 20 |
| Presence identity | room awareness relay | `presence.person` overwritten with the connection's person; an awareness client id bound to the first connection using it; removed on close |
| Share, link sharing, delete | routes | owner only |
| Uploads | asset route | `editDocument`, size, media type by magic bytes |
| Add-on identity | handoff routes (Google Slides module) | identity token signature (Google's keys), issuer, expiry, audience pinned from a real token; binding secret hash |
| Limits | room and routes | `COLLABORATION_LIMITS` (21.10) |

### 21.6 The room and the guard

One room per loaded deck: the authoritative Y.Doc, a model `DocumentStore` over it with
`repairPolicy: "repairAfterTransaction"` and `seed: none`, the discussion log, the awareness
instance and the connections. Each inbound sync update is applied in its own transaction with the
CONNECTION as the origin. In `afterTransaction` the guard reads, for every transition script the
transaction touched and for `meta`, the value before (from the transaction's `changed` keys and
the store's previous snapshot) and after, and decides with a pure function
`correctionsFor({ before, after, sender })` (person or agent, role) the
`ProtectedFieldCorrection`s. Corrections are written in one follow-up transaction with
`REPAIR_ORIGIN`; the update the sender sent and the correction's update are merged
(`Y.mergeUpdates`) and only the merge is broadcast and persisted, so no other replica ever holds
the forbidden state. Updates from the server's own replica (agent edits, imports, repairs) carry
server origins and skip the guard; the model's own validation already covers them. What an
editor's update leaves pending (Yjs structures waiting for a missing dependency) is taken out of the
shared store and retried only with that connection's next update, so it is always judged as its
sender's and never integrates inside a colleague's transaction (deck-room.ts `applyGuarded`).

Agent history: one `Y.UndoManager` per agent session over `UNDO_SCOPE_ROOTS`, tracking that
session's own origin object, so `revertAgentSession` undoes only its steps, newest first, skipping
steps collaborators overwrote (document-store.ts "Undo against collaborators"). Histories are in
memory: a room with an agent history stays loaded 30 minutes after its last agent edit; after a
restart a revert answers `nothingToRevert`. `UNDO_SCOPE_ROOTS` does not include `meta`, so an
agent's `setTitle` is not on its history: `revertAgentSession` does not undo it, and it does not
keep the room loaded for 30 minutes.

Lifecycle: loaded on first use (upgrade, API, `DeckService.openDeck`), unloaded 60 seconds after
its last connection and lease closed and its log flushed. On `SIGTERM`: flush every room, close
every socket with `serverShuttingDown`, then exit.

### 21.7 Storage

Everything under the existing `/data` volume, every record sealed with the OWNER's data key
(`account-keys.ts`; `seal` takes text, so bytes are base64url), so erasing the owner's account
makes their decks unreadable and the eraser removes them.

```
/data/decks/
  index.json                 { version: 1, decks: { <deckId>: { ownerAccountId, memberAccountIds[],
                               invitationEmailHashes[], addonBindingHashes[], createdAt } } }
                             (no personal data in the clear; atomic write, mode 0600)
  <deckId>/
    deck.sealed              DeckRecord: members [{accountId, role, addedAt}], invitations
                             [{invitationId, emailHash, email, role, invitedAt}], linkSharing,
                             googleSlides link, title and updatedAt caches
    document.snapshot        line 1 "sasha-deck-snapshot 1 <throughSequence>", line 2 sealed
                             Y.encodeStateAsUpdate
    document.log             one line per flush: "<sequence> <sealed Y.mergeUpdates(batch)>"
    discussion.log           one line per entry: "<sequence> <sealed DiscussionLogEntry JSON>"
    assets/<sha256>          line 1 "<mediaType> <byteLength>", line 2 sealed bytes
/data/deck-profiles/<accountId>.sealed   the display name, sealed under that account's own key
```

- **Writes**: document updates are batched and appended every 250 milliseconds (and at unload),
  each flush one `appendFile` plus `fsync`. Discussion entries are appended before their outcome is
  sent. A crash loses at most the last 250 milliseconds on the server, and the clients still hold
  those updates and send them again in their next sync step 2.
- **Compaction**: past 1 megabyte or 500 records of `document.log`, write `document.snapshot.tmp`
  (through the last sequence), `fsync`, rename over the snapshot, then replace the log with an
  empty one the same way. Loading applies the snapshot, then every log record; applying a record
  the snapshot already contains is harmless (Yjs updates are idempotent), so a crash between the
  two renames loses nothing.
- **Corruption**: a record that does not open or decode is skipped with a warning naming the deck
  and sequence; the room loads with whatever Yjs can apply (missing dependencies wait as pending
  structures, and a client's next step 2 may fill them). Yjs clocks are consecutive per replica, so
  a skipped record also holds back every LATER record from the same replica: the deck loads with
  what came before the bad record (decks/deck-storage.test.ts asserts exactly that).
- **Deck ids**: `dk_` + 22 random base-62 characters (`parseDeckId`).
- **Erase**: `account-eraser.ts` also deletes the directories of decks the account owns, removes it
  from every other deck's members, closes its sockets, and deletes its profile.

### 21.8 Web application (web module)

- **`/decks`**: the real logo (`SASHA_ICON_SVG`) and "Sasha Slides" in a glass header with the
  account (address, "Account", which links to `/account`); `LivelyShapes` behind; one
  `.sasha-lively-card` per deck (title, role, owner, "edited 3 minutes ago"), opening on click or
  Enter; "New deck" (primary pill), "Import from Google Slides" (a dialog taking an address; on
  `googleNotConnected` it offers "Connect Google Slides", which navigates to `connectAddress`);
  per-card menu "Share" (owner), "Delete" (owner, with confirmation). Empty state: one card "Make
  your first deck". Signed out: the browser goes to `signInAddress`.
- **Share dialog** (list page and the editor's top bar): members with role pickers, "Invite by
  email" with a role, pending invitations, link sharing; viewers and commenters see the people list
  read-only.
- **`/deck/<id>`**: the shell reads the session, opens the socket, composes the model store
  (`seed: none`, `repairPolicy: "reportOnly"`), the WebSocket `DiscussionStore`, an awareness
  `PresenceChannel`, an HTTP `AssetStore` (bytes fetched with the session into object addresses, so
  the cookie and bearer paths behave the same), a `CollaborationSession`, then mounts
  `EditorApplication` with an `EditorHost` (Share and the account in the top bar; File menu "All
  decks", "Export to Google Slides", "Export to the linked presentation", and in the add-on "Open in
  a new tab"). Until the first sync it shows the calm wash with a "Opening deck..." card. Recent
  colours live in local storage (`recentColours`); the page title is the deck title.
- **Embedded** (`?embed=addon`): exchanges `#ticket=`, removes the fragment from the address,
  renews the bearer, posts `ready` to the shell, runs export through the shell when the server
  answers `runInAddon` (`AddonShellMessage`).
- **Build**: `build-web.ts` bundles both pages, the runner (`buildPresenterAssets` into
  `dist/web/runner/`) and writes `dist/web/manifest.json` (`WebBuildManifest`). The policy:
  `default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com
  'sha256-<presenter rules>' 'sha256-<speaker window sheet>'; style-src-attr 'unsafe-inline';
  font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'
  https://fonts.googleapis.com https://fonts.gstatic.com; frame-src 'self'; base-uri 'none';
  form-action 'self'; frame-ancestors 'none'` (the embedded variant replaces the last directive).
  The two hashes are of the presenter's own `<style>` elements (the presentation and transition
  preview render `PRESENTER_RULES`; the speaker window adds the Tidepool sheet and the rules),
  computed by `build-web.ts` from the same constants (`content-security-policy.ts`), so no other
  inline stylesheet runs; `connect-src` names Google Fonts because the presenter fetches font files
  for the transition runner (without them a scripted transition shows fallback fonts). Both were
  found by the integrated run in Chrome, which now records zero policy violations while presenting.
  The runner page loads `runner-bootstrap.js` beside it, so the connector serves every plain file
  name under `/deck-app/runner/`.
- **Review address**: `/deck/<id>?reviewTransitionScript=<scriptId>` (`TRANSITION_REVIEW_QUERY`,
  what `deck_write_transition` answers) opens that script's review once the editor is ready and
  removes the parameter from the address (`web/deck-page/review-address.ts`). The connector reads the manifest at startup;
  without one, `/decks` answers 503 "the web application is not built".

### 21.9 Discussion, presence and the editor fixes (discussion module)

- **Threads** anchored to a slide, an element, a text range or a region (the existing
  `CommentAnchor`), with replies, edit and delete of one's own messages, resolve and reopen, a
  filter (open, resolved, mentions of me) and "on deleted slides". Numbered glass pins on the
  canvas; the focused thread's region and markings drawn over the slide.
- **Annotations**: pen and rectangle drawn while composing (the `annotate` tool), stored in the
  thread's `markings` (fractions of the element's frame or of the slide), never in the slide; a
  "Show annotations" toggle in View.
- **Mentions**: typing "@" opens the members list (`collaboration.members`), filtered as one types;
  choosing inserts "@Display Name" and records the person id in `mentions`; messages highlight their
  mentions; the agent's messages are labelled "Claude".
- **Presence**: peer cursors with name labels in the peer colour, peers' selection outlines, avatars
  on the filmstrip thumbnail each peer is on, and a stack of avatars in the top bar whose popover
  lists who is on which slide (a click goes there). Away after 30 seconds, gone after 2 minutes.
- **Connection**: the top bar shows nothing while online; "Offline - reconnecting in 8 s - Try now"
  while offline, "Changes not sent yet" while `unsentChanges`, and for `closed` a banner with the
  reason and the editor read-only. A commenter's and a viewer's editing controls are disabled with
  the reason ("You can comment on this deck"); the reducer refuses such edits with a notice.
- **Agent notices**: `agentEditObserved` -> "Claude edited the deck: <summary>" with "Undo Claude's
  edit" (`pendingAgentReverts`, the collaboration feedback calls `revertAgentSession`, then
  `agentRevertSettled`); a new unapproved agent script -> "Claude wrote a transition: review it".
- **Milestone 1 review fixes**:
  1. Multi-selection edits merge PER ELEMENT: changing one field of a style group (text box padding,
     a line's stroke width) writes, for each selected element, that element's own group with only
     the changed field replaced, never the first element's group onto all.
  2. A list style picker with the 12 `ListGlyph` presets (bulleted and numbered), per paragraph range.
  3. Gradients: stop positions editable, stops added and removed (2 to 10), the radial centre (x, y)
     editable, the angle for linear.
  4. "Recent" colours in the colour picker (`chrome.recentColours`, `recentColourUsed`).
  5. "Scripted" with no scripts in the deck explains itself: "No scripted transitions in this deck
     yet. Ask Claude to write one (it arrives for your approval), or write one yourself" with "Write
     a script".
  6. Arrow keys on a focused pill group (tabs, segmented choices) move between pills (roving tab
     index, `role="tablist"`/`radiogroup`) and never reach the canvas's nudge.
  7. Full-word identifiers: every `...Css` (about 30), `sameJson`, `withUi`, `state.ui` (renamed to
     `state.chrome` by the architect) and any other abbreviation, enforced by a test that scans the
     engine's sources for declared identifiers containing `Css`, `Json`, `Ui`, `Svg`, `Html` or
     `Dom` as a word part.
  8. Liquid glass (section 2) and the real logo in the editor's top bar, linking to `homeAddress`.

### 21.10 Limits

`COLLABORATION_LIMITS` in collaboration.ts: frames 4 megabytes; the deck's encoded state 32
megabytes; 20 messages per second per connection, burst 100, closed after 10 seconds over (a
document update over the rate closes at once instead of being dropped, so the client's step 2
resends it; presence publishes at most 10 a second, `PRESENCE_PUBLISH_INTERVAL_MILLISECONDS`, and
a connection holds at most 4 awareness client ids); 50
connections per deck and 20 per account; awareness state 8 kilobytes; comment body 10,000
characters, 50 markings of at most 2,000 points per thread, 5,000 threads per deck, 20 mentions;
assets 25 megabytes each and 512 per deck; 500 decks per account; 100 members per deck; 100
invitations per account per day; 200 commands per agent edit; transition scripts per
`TRANSITION_LIMITS`. Request bodies: 1 megabyte for JSON except the add-on import (48 megabytes).

### 21.11 Visual rules for milestone 2

The list page uses the lively shapes and `.sasha-lively-card`s; the editor keeps the calm wash.
Panel glass per section 2. Every new stylesheet rule reads `--sasha-*` properties only (each
module's stylesheet test forbids colour literals), and the theme's contrast test covers the new
glass values and the new text colours.

### 21.12 Google Slides import and export (Google Slides module)

Units: Slides pages are 9,144,000 English metric units wide (720 points); the engine's page is
1280 units wide, so `units = englishMetricUnits * 1280 / pageWidthEnglishMetricUnits` and
`units = points * 1280 / 720` (the section 15 constant, 1 / 0.5625). The page height follows the
aspect ratio.

**Import** (`presentations.get`, then ONE envelope on a new deck: theme, layouts, slides; author
the importing person; images first stored with `putAsset` and registered):

| Slides | Engine | Notes and losses |
|---|---|---|
| `pageSize` | `meta.pageHeight` | width always 1280 |
| `transform` + `size` of an element | one `frame` | width = `size.width * hypot(scaleX, shearY)`, height = `size.height * hypot(shearX, scaleY)`, rotation = `atan2(shearY, scaleX)` in degrees; a negative determinant reads as a HORIZONTAL flip with rotation `atan2(-shearY, -scaleX)` (what Slides' Flip horizontally writes; the same drawing); centre = transform of the box centre, so `x = centreX - width / 2` (rotation about the centre, geometry.ts) |
| `shape.shapeType` `TEXT_BOX`, `RECTANGLE`, `ROUND_RECTANGLE`, `ELLIPSE`, `TRIANGLE`, `RIGHT_TRIANGLE`, `DIAMOND`, `PARALLELOGRAM`, `TRAPEZOID`, `PENTAGON`, `HEXAGON`, `OCTAGON`, `STAR_5`, `PLUS`, `HEART`, `CLOUD`, `WEDGE_RECTANGLE_CALLOUT` and `WEDGE_ROUND_RECTANGLE_CALLOUT`, `CHEVRON`, `RIGHT_ARROW`, `LEFT_ARROW`, `UP_ARROW`, `DOWN_ARROW` | `ShapePreset` of the same name (`STAR_5` -> `fivePointStar`, callouts -> `speechBubble`) | any other type -> `rectangle` with loss `shapePreset` naming it |
| `shapeBackgroundFill` solid, `NOT_RENDERED`, `INHERIT` | `Fill` solid, none, resolved from the placeholder parent | `themeColor` -> theme slot reference |
| `outline` weight, `dashStyle`, fill, `NOT_RENDERED` | `Border` uniform or none | dash names map one to one |
| `shadow` | `Shadow` from blur radius and offset | approximate; loss `shadow` when its alignment is not bottom-right-like |
| `contentAlignment`, `autofit.autofitType` (`NONE`, `SHAPE_AUTOFIT`, `TEXT_AUTOFIT`) | `textBox.verticalAlignment`, `autofit` (`none`, `resizeShape`, `shrinkText`) | |
| text runs: `weightedFontFamily`, `fontSize`, `bold`, `italic`, `underline`, `strikethrough`, `foregroundColor`, `backgroundColor`, `link` (url, `pageObjectId`, `slideIndex`, relative), `baselineOffset`, `smallCaps` | `RunStylePatch` (size in units, `fontWeight` from the weight, highlight, `RunLink` web address or slide) | effective style resolved through the placeholder chain (element -> layout -> master) and written explicitly; colours keep theme references |
| paragraph: `alignment`, `lineSpacing` (percent), `spaceAbove`, `spaceBelow`, `indentStart`, `indentFirstLine`, `direction` | `ParagraphStylePatch` | |
| `bullet` (`listId`, `nestingLevel`) with the list's glyph | `ListMembership` (same `listId`, level, the nearest of the 12 `ListGlyph` presets) | loss `listGlyph` when not exact |
| `autoText` `SLIDE_NUMBER` | `automaticText` slideNumber | other kinds: their rendered text, loss |
| `image` (`contentUrl`, fetched within its 30 minutes), `cropProperties`, `transparency`, `outline` | `ImageElement` with `ImageCrop`, opacity, border | brightness, contrast, recolour: loss `imageAdjustment`; a failed fetch: a hatched rectangle named "Image could not be imported", loss |
| `line` (`lineCategory` `STRAIGHT`, `BENT`, `CURVED`; weight, dash, fill, `startArrow`, `endArrow`) | `LineElement` (routing straight, elbow, curved; end points from the box diagonal and flips; `ArrowHead` nearest of 7) | connection sites: loss `connection` |
| `table` (`tableRows[].rowHeight`, `tableColumns[].columnWidth`, cells with spans, text, `tableCellBackgroundFill`, `contentAlignment`; borders from `tableBorderRows` / `tableBorderColumns`) | `TableElement` with minted row and column ids and `CellBorders` per side | |
| `elementGroup` | group (children absolute, the group's own rotation) | |
| `sheetsChart` | image of its `contentUrl` | loss `linkedChart` |
| `video` | rectangle named "Video: <address>" | loss `video` |
| `wordArt` | text box with its rendered text | loss `wordArt` |
| `speakerSpotlight` | omitted | loss |
| placeholders (`TITLE`, `CENTERED_TITLE`, `SUBTITLE`, `BODY`, `SLIDE_NUMBER`, `FOOTER`, `DATE_AND_TIME`, `PICTURE`) | `PlaceholderReference` roles | other types -> `body`, loss |
| the first master's `colorScheme` and title and body text styles; its placeholders | `ThemeSnapshot` (12 slots, heading and body families, `placeholderStyles`, default background) | further masters: loss `masters` |
| layouts (`layoutProperties.displayName`, placeholders) | `LayoutSnapshot`s | |
| page background (solid, `stretchedPictureFill`, inherited) | slide `background` | |
| notes page body (`speakerNotesObjectId`) | `speakerNotes` | |
| `slideProperties.isSkipped` | `skipped` | |
| object ids | kept when they match `OBJECT_ID_PATTERN` and are unique; minted otherwise | Slides' short ids like `p` are minted |
| transitions, animations | none | the API exposes neither; loss `transition` once per deck |

The import report lists every loss with its slide and element. `GoogleSlidesLink` records the
presentation, its title and `revisionId`.

**Export** (engine document -> `presentations.create` when new, then `batchUpdate` per slide):

| Engine | Slides requests | Notes and losses |
|---|---|---|
| page size | `presentations.create` `pageSize` | |
| slide | `createSlide` with the engine slide id as `objectId` (ids.ts guarantees a valid object id), `predefinedLayout: BLANK` | layouts and placeholders become plain positioned elements: loss `layouts` once |
| re-export to the linked presentation | per slide: `deleteObject` of the page with that id in one batch, `createSlide` with the same id in the next | slides deleted in the engine are deleted there; slides added there by hand are kept |
| background | `updatePageProperties` `pageBackgroundFill` (solid, `stretchedPictureFill` from an export asset address) | gradient background: first stop, loss |
| rectangle-family shape with a uniform border and uniform radius, other presets | `createShape` (`shapeType` from the preset), `updateShapeProperties` (solid fill or none, outline weight, dash and colour, `contentAlignment`) | theme colours written as their resolved colour (loss `themeColourLink` once) |
| what Slides cannot express: per-side borders, per-corner radii, radial and multi-stop gradients, shadows | the element is adapted into the converter's `SlideElement` extraction type and `emitSlideRequests` (`mcp/sasha-slides/converter/emit-requests.ts`) composes it (border strips, ROUND_1 corners) | the converter's `UnsupportedFeature`s become losses |
| text | `insertText`, `updateTextStyle` per run range, `updateParagraphStyle` per paragraph, `createParagraphBullets` with the matching `bulletPreset` per list run | `automaticText` -> the number as text, loss; autofit other than none: loss (the API cannot set it) |
| image | `createImage` from `/deck-api/export-assets/<token>/<sha256>` | crop is read-only in the API: exported uncropped, loss `crop`; images over 50 megabytes or 25 megapixels: loss |
| line | `createLine` (`lineCategory`), `updateLineProperties` (weight, dash, fill, arrows) | |
| table | `createTable`, `updateTableColumnProperties`, `updateTableRowProperties`, `insertText` per cell, `updateTableCellProperties`, `updateTableBorderProperties` per side, `mergeTableCells` for spans | |
| group | children first, then `groupObjects`; the group's rotation through `updatePageElementTransform` | |
| speaker notes | `insertText` into the new slide's `speakerNotesObjectId` (read back after `createSlide`) | |
| skip | `updateSlideProperties` `isSkipped` | |
| transitions, built-in and scripted | none | the API cannot set transitions: loss `transition` per slide that has one |

Requests are sent per slide (each `batchUpdate` atomic), in slide order. Reusing an object id right
after its `deleteObject` IN THE SAME batch works for slides and elements (measured,
`OBJECT_ID_REUSE_AFTER_DELETE` in google-slides/), so a re-exported slide is replaced atomically in
one batch. Tables: export skips cells covered by a span (document.ts `TableCell.rowSpan`). A plan
the add-on runs (`AddonExportPlanBody.requests`) also carries two host instructions Code.gs
interprets itself (google-slides/slides-requests.ts `ExportInstruction`):
`{ sashaSlideBoundary: { slideId, slideNumber } }` starts the next slide's batch, so a failure names
its slide, and `{ sashaSpeakerNotes: { slideObjectId, text } }` writes notes into the notes shape
that exists only after `createSlide`. The add-on's export calls carry `ADDON_REQUEST_HEADERS`
(deck-api.ts). A failed batch stops the
export and reports which slide failed and why; the slides before it are already written, and the
next export replaces them again, because pages are addressed by the engine's ids.

**Google authorization**: the account's grant in the connector's store (`GoogleGrantStore`); the
web application's connect flow asks for `https://www.googleapis.com/auth/presentations` and
`drive.file` with `include_granted_scopes`, through the already registered
`/oauth/google/callback`. Without a grant, import answers `googleNotConnected`; export in the add-on
answers `runInAddon`.

### 21.13 The add-on embedding (Google Slides module)

1. Code.gs adds the menu item **"Open in Sasha editor"** -> `sashaOpenEditor()`:
   - the binding secret: `PropertiesService.getDocumentProperties()` `sashaDeckBinding`, created
     on first use from two `Utilities.getUuid()` values (244 random bits), base64url;
   - `revisionId` from `Slides.Presentations.get(id, { fields: "revisionId" })`;
   - `POST /deck-api/addon/handoff` with `ScriptApp.getIdentityToken()` (adds the `openid` and
     `email` scopes to `appsscript.json`: one re-consent);
   - `needsImport` -> `Slides.Presentations.get(id)` -> `POST /deck-api/addon/import`;
     `changedSinceImport` -> the shell first asks "Open the Sasha deck" or "Import again";
   - `HtmlService` shows `EditorShell.html` with `showModelessDialog` at the largest size Slides
     accepts (measured), holding one `<iframe src="https://sashaslides.com/deck/<id>?embed=addon#ticket=<t>"
     allow="clipboard-write; fullscreen">`.
2. `EditorShell.html` is built from TypeScript (`addon/src/editor-shell.ts`) by `build-addon.ts`, a
   few kilobytes, far under `SURFACE_BUDGET_BYTES`; it only relays `AddonShellMessage`s
   (checking `event.origin === "https://sashaslides.com"`) and calls `google.script.run`.
3. The server's handoff verifies the identity token against Google's published keys, issuer
   `https://accounts.google.com`, expiry, and an audience pinned from one real token decoded in
   this project (the auto-created script project's client); finds or opens the account for the
   token's subject (`GoogleIdentityAccounts`); binds `SHA-256(binding secret)` to the deck on first
   import; refuses a binding hash already bound to a deck the account cannot edit.
4. Export in the dialog: File > "Export to this presentation" -> `runInAddon` when the account
   has no grant -> `exportRequested` -> `google.script.run.sashaRunExport(exportId)` -> Code.gs
   fetches the plan (identity token and binding secret as headers), runs
   `Slides.Presentations.batchUpdate` in chunks, posts the result -> `exportFinished` to the frame.
5. Frame limits (section 14 item 4) stand: Present opens a top-level tab; menu copy and paste
   point to the keyboard shortcuts.

### 21.14 Claude's deck tools (assistant module)

Registered by `registerDeckTools` next to `registerCommentTools` in `server.ts`; contract
`assistant-deck-tools.ts`. Every tool resolves the caller from the MCP bearer (Google subject ->
account), acts with that account's role, and goes through `DeckService`, so edits reach open
editors live. `agentSessionId = "as_" + first 24 hexadecimal of SHA-256(MCP session id)`.

| Tool | Input | Output |
|---|---|---|
| `deck_list` | - | decks with `address` (`https://sashaslides.com/deck/<id>`) and role |
| `deck_create` | `title` | `deckId`, `address` |
| `deck_read` | `deckId`, `detail` (`outline` or `full`), `slideIds` | `DeckOutline` |
| `deck_edit` | `deckId`, `summary` (one sentence collaborators see), `edits: AssistantEdit[]` (at most 200 commands after expansion) | `AssistantEditOutcome` (all or nothing, one envelope, one undo step) |
| `deck_write_transition` | `AssistantTransitionScript` | `scriptId`, `approved: false`, `reviewAddress`; saved `"unapproved"`, sizes per `TRANSITION_LIMITS`, the slides in `assignTo` switch to it in the same envelope |
| `deck_revert` | `deckId`, `agentSessionId` (default: this session) | `AgentRevertOutcome` |
| `deck_read_comments` | `deckId`, `status` (`open` or `all`), `slideId` | `sequence`, `AssistantThread[]` |
| `deck_reply_comment` | `deckId`, `threadId`, `body` | `DiscussionOutcome` (as the agent person) |
| `deck_resolve_comment` | `deckId`, `threadId`, optional `note` (replied first) | `DiscussionOutcome` |
| `deck_await_comments` | `deckId`, `afterSequence`, `timeoutSeconds` (at most 3000) | new threads and messages since, with progress notifications while waiting (`long-poll-progress.ts`) |

`deck_edit` expansion rules: new shapes take the theme's default text style and the layout's
placeholder frame when `frame` is omitted; `addImage` fetches https only, at most 25 megabytes,
media type by magic bytes; `restyleElements` merges per element; `setText` replaces the body with
one `editText` (delete all, insert paragraphs with complete attribute sets, yjs-schema.ts);
`replaceText` and `styleText` find text in the current snapshot. The workflow skill
(`.claude/skills/sasha-slides/SKILL.md`) gains a short "Sasha decks" section: read before editing,
one `deck_edit` per user request, scripts are reviewed by a person.

### 21.15 nginx and Docker

- nginx: one more connector location, `location ~ ^/(decks/?$|deck/|deck-app/|deck-api/)`, with
  the existing proxy headers plus `proxy_set_header Upgrade $http_upgrade;` and
  `proxy_set_header Connection $connection_upgrade;` (a `map` at the top of the file),
  `proxy_read_timeout 3700s`, buffering off. `nginx-routing.test.ts` gains the paths, the upgrade
  headers and the cases that must stay with the website (`/deckhouse`, `/decks.css`).
- Image: `deploy/package.json` adds `yjs`, `y-protocols`, `lib0`, `rxjs` and `ws` at the versions
  installed in development; `context-files.ts` adds the engine sources the server imports (found
  by esbuild like everything else) and `engine/dist/web/**` (read at runtime);
  `publish.sh` builds the web application (`npm ci` and `npm run -s build:web` in the engine)
  before packing. `docker-compose.yml` keeps `/data` as the one writable volume. The repository
  root gains `ws` and `@types/ws` (today `ws` is only a transitive dependency of
  chrome-remote-interface).

### 21.16 Failure handling

| Failure | What happens |
|---|---|
| Network drops | `offline` with backoff; edits stay in the replica; "Changes not sent yet"; sync on reconnect |
| Server restarts | sockets close `serverShuttingDown`; rooms reload from snapshot and log; clients resend what the last 250 milliseconds lost |
| Disk write fails | the room keeps working in memory and keeps relaying, retries the flush with backoff from 1 second to 30 and warns; after 60 seconds of failures it closes its sockets `serverShuttingDown`, so the clients keep their edits and resend them once the server recovers |
| Session expires | 4001; the client refreshes the session (the cookie lives 12 hours) or, past it, sends the browser to sign in after warning about unsent changes |
| Role lowered or removed | `accessChanged` (editor becomes read-only at once) or close `accessRevoked` |
| Deck deleted, owner erased | close `deckDeleted`; the list no longer shows it |
| Rejected agent edit | `rejected` with the failing edit's index and the model's reason; nothing written |
| Google not connected, permission denied, not found | `googleNotConnected` with the connect address, `googlePermissionDenied`, `googlePresentationNotFound` |
| An image fails to import | a placeholder rectangle and a loss; the import continues |
| An export batch fails | the export stops at that slide and says which; re-export replaces |
| Add-on identity token invalid | 401 `addonIdentityRejected`; the shell says "Sign in again" |
| Over a limit | the matching `rateLimited`, `tooLarge`, `limitReached` or `resynchroniseRequired` (`updateTooLarge`) |

### 21.17 Modules

Five modules with disjoint owned paths. The architect keeps `src/contracts/**`,
`src/platform/**`, `src/module-surfaces-check.ts`, the engine's `package.json`,
`package-lock.json` and `tsconfig*.json`, `mcp/sasha-slides/deck-contracts/**`,
`mcp/sasha-slides/tsconfig.json` and this document. Milestone 2 hands `src/theme/**` to the
discussion module and `src/model/**` to the collaboration server module. The presenter is frozen.

| Module | Owns | Hooks it exposes or consumes |
|---|---|---|
| 1 collaboration server | `engine/src/model/**`, `engine/src/server/**`, `mcp/sasha-slides/decks/**` (its tests beside the code), `server.ts`, `http/http-server.ts`, `http/account-portal.ts`, `http/account-portal-stack.ts`, `http/account-eraser.ts`, `http/account-keys.ts`, `test/account-portal*.test.ts`, `test/account-keys.test.ts`, `test/oauth.test.ts`, `mcp/sasha-slides/deploy/**`, the repository's `deploy/**`, `renderer/html2slides/addon-server/deploy/nginx-sashaslides.conf` and `nginx-routing.test.ts`, the repository root `package.json` and `package-lock.json` | implements `DeckService`, `EmbedTicketIssuer`, `GoogleIdentityAccounts`, `GoogleGrantStore`; mounts `createGoogleSlidesInterchange` and calls `registerDeckTools`; ships `decks/memory-deck-service.ts` (a real `DeckService` over real rooms in memory) FIRST, for modules 4 and 5 |
| 2 web application | `engine/src/web/**`, `engine/build-web.ts`, `engine/e2e/web/**`, the website's `pages.ts`, `pages.test.ts`, `public/*.html` and `public/site.css` | implements `CollaborationSession`, the WebSocket `DiscussionStore`, the awareness `PresenceChannel`, the HTTP `AssetStore`; passes `EditorHost`; writes `WebBuildManifest` |
| 3 discussion and editor | `engine/src/state/**`, `engine/src/view/**`, `engine/src/theme/**`, `engine/build-demo.ts`, `engine/e2e/editor/**` | consumes `CollaborationSession` through `EditorDependencies`; renders `EditorHost` |
| 4 Google Slides | `mcp/sasha-slides/google-slides/**` (tests beside the code), `mcp/sasha-slides/addon/**`, `mcp/sasha-slides/converter/**`, `mcp/sasha-slides/e2e/google-slides*.ts`, the website's `public/addon-bundle/**` | implements `CreateGoogleSlidesInterchange`; consumes `DeckService` and the hooks above |
| 5 assistant deck tools | `mcp/sasha-slides/deck-tools/**` (tests beside the code), `test/workflow-guidance.test.ts` (its tool count), `.claude/skills/sasha-slides/SKILL.md` | implements `RegisterDeckTools`; consumes `DeckService` |

Integration order: module 1's `memory-deck-service.ts` and `engine/src/server/` room unblock the
others' integration tests; module 2's end-to-end run needs module 1's server and module 3's
rendering of `collaboration`; until then each module tests against its own fakes of the contracts.

### 21.18 Risks and open questions

- **`require` of the engine's ECMAScript modules from the connector's CommonJS**: ANSWERED. tsx's
  CommonJS loads them through `require(esm)` (Node v24.21.0: `npx tsx mcp/sasha-slides/server.ts
  --help` exits 0 with `engine/src/server` and `engine/src/model` loaded; `decks/packaging.test.ts`
  checks it). Neither directory has a top-level `await`, and the image ships `engine/package.json`,
  so `"type": "module"` applies there exactly as in development.
- **The identity token's audience**: pinned from the bound script's own access token (tokeninfo
  `azp`/`aud`, 2026-10-15, `ADDON_IDENTITY_AUDIENCES`), NOT yet from an identity token: the bound
  script's manifest could not gain `openid` from the test browser ("Show appsscript.json" does not
  save), so `ScriptApp.getIdentityToken()` returned null. Tick that setting by hand once, deploy the
  manifest step, re-consent and run `open-editor`; a mismatch is logged with the token's own `aud`.
- **The largest modeless dialog size**: MEASURED, Slides clamps the request to the window (a 4000 by
  3000 request in a 1599 by 812 window gave a 1327 by 733 dialog, `EDITOR_DIALOG_SIZE`).
- **Reusing an object id right after `deleteObject`**: MEASURED, works in the same batch (21.12).
- **One process, rooms in memory**: a second connector replica would split rooms. Recorded in
  `DEPLOY.md`.
- **The runner on the editor's own site** until a second registrable domain exists: a busy-loop
  transition can freeze the editor tab (section 11); only approved scripts run.

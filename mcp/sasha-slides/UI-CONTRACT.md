# sasha-slides UI contract

The surfaces and the seams between them. **Change this file before changing a component** —
several components are built against it in parallel.

## The assistant is called Sasha

In the context of making a presentation the assistant is **Sasha**, in the interface and in
its own turns. Not "the model", not "Claude", not "the add-on".

## One way in: Ask Sasha

The Slides menu has exactly **one** item: **Ask Sasha**, which opens the conversation. There is
no "open the conversation" and no "candidate slides" item — a menu that lists surfaces makes the
user assemble the product themselves.

| surface | opened by | what it is |
|---|---|---|
| **Conversation** (sidebar) | the Ask Sasha menu item | the spine: every event, in order, for ever |
| **Slides** (modeless dialog) | a button in the conversation, and automatically when slides arrive | the candidates, in a grid; mark them up here |
| **Defect report** (modeless dialog) | a button in either of the others | anonymise one candidate and send a converter defect |

The defect report is a SURFACE OF ITS OWN and not a mode of the Slides window, which is a size
decision before it is a taste one: HtmlService has been observed relaying a ~560 KB inlined bundle
back corrupted (`Uncaught SyntaxError: Invalid or unexpected token`), and the page cannot be
base64'd because the sandbox's CSP forbids `unsafe-eval`. The anonymiser is the heaviest code in
the product, so it gets its own bundle; `build-addon.ts` fails the build over 500 KB per page.
It is still not reachable from the menu — the menu has exactly one item.

The dialog is **opened from the conversation**, never from the menu. When Sasha stages slides
the dialog opens by itself, and the conversation keeps a button to reopen it later — the slides
must stay reachable after the moment they arrived.

## The popup IS the editor

There is one place you work on slides, and it is always the editor. Editing is the default
state, not a thing you navigate to.

**View and tool are independent, and neither is a "mode":**

| | |
|---|---|
| **view** | *grid* (every candidate) or *single* (one, large). A zoom level, nothing more. |
| **tool** | *edit* (the default) or *annotate*. A tool, picked from a toolbar. |

Every combination is legal: annotate from the grid, edit a single slide, switch either without
losing the other. What must NOT happen is the current behaviour — clicking a slide to "enter"
a different screen where annotation suddenly becomes possible. Clicking a slide in the grid
changes the VIEW; it does not change what you are allowed to do.

Two consequences, both of which the grid has to live with:

- **A cell's picture belongs to the tool, so the zoom is a named control.** The cell cannot be one
  big button any more: the annotate tool's drag gesture happens on the picture, and a picture that
  is also a navigation target cannot host a gesture. So the cell's footer carries the two things it
  owns — which candidate you are working on, and "show it large".
- **The editor is attached to one candidate at a time**, at either zoom level: the selected one,
  while the edit tool is live and the HTML pane is showing. It draws its chrome in the host document
  over one frame, so a second attachment would fight the first for it — and only that one frame is
  granted `allow-same-origin` (never `allow-scripts`, anywhere). When the edit tool cannot reach a
  candidate — the converted projection is showing, or the document has not arrived — the panel says
  which, as a union with a named arm, rather than sitting empty.

## The defect report is the same editor, not a table

Reporting a defect opens the editor you already know, with extra controls and two slides shown
side by side: **the slide as it is** and **the slide as it will be sent**. Both rendered, both
visual. A reader judges an anonymisation by looking at it, the same way they judge a slide.

**There is no before/after table of text runs.** A list of thirteen rows reading
`Paths in, -> Natus at,` asks the user to audit a diff by eye and tells them nothing about
whether the slide still looks like their slide. The visual pair answers the question the table
was pretending to.

The extra controls belong in that editor: edit the title, edit the content of either slide, and
send. Nothing is sent until the user presses send, and what is sent is what the right-hand slide
renders.

### What editing each of the two slides means

The two slides are edited with the **same visual editor**, and the two edits are not the same kind
of act. This is the one place the privacy guarantee meets a free-form gesture, so it is spelled out:

| | what it changes | what vouches for it |
|---|---|---|
| **the left slide** (as it is) | the bytes the anonymiser is run over | the anonymiser, in full — this is how you cut a slide down to the part that reproduces the defect, and nothing on this path is bypassed |
| **the title** | one text run's replacement | the anonymiser's own replacement gate; a title that hands the original back is refused and annotated, exactly as any replacement is |
| **the right slide** (as it will be sent) | the bytes that are sent, verbatim | **nothing but the user.** The anonymiser did not write them and does not vouch for them |

So the third row carries two obligations:

- **Say so, on the slide.** A hand edit to the right-hand slide is annotated as being in what is
  sent, and the annotation says that everything the anonymiser reports describes its own pass and
  not those edits.
- **Refuse an outright leak.** If a hand edit puts any of the original slide's own visible text back
  into the bytes that would be sent, the report **cannot be prepared at all** — named, with the
  strings listed, and undoable. The threshold is the anonymiser's own four-character echo floor.
  A refusal here is recoverable (undo the edits); it is not a throw and not a warning.

`previewDefectReport` is still the only path to a payload, and it is handed the bytes the right-hand
slide renders — one function, used by the pane and by the payload, so the picture and the bytes
cannot diverge.

### Risk annotations are pinned, not tabulated

`rejectedReplacements`, `shapeRisks` and `residualRisks` stay visible as **numbered notes about the
slide they are about**, each with a card, and the ones that need a decision — a leak, a risk — also
get a **pin in the margin beside that slide**. A text run is a position in a token stream and not a
box on the slide, so a pin names its slide and carries a number; it does not pretend to a coordinate
nothing measured. The notes are never clipped, never summarised and never behind a disclosure.

## Waiting for Sasha must be honest

When the user sends a message or a comment, the interface shows that it is **waiting** — a live
indicator, elapsed time, and Sasha's thinking when it is available, not a static line.

**And it must distinguish "waiting" from "nobody is listening."** Sasha only answers when a
Claude session has the connector attached and is polling. With no connector attached, a comment
sits unanswered for ever while a naive interface says "no answer yet" — implying one is coming.
That is a lie the user cannot see through, and it has already happened. State the real
precondition, and say how long it has been.

### What this can and cannot know

**It cannot know whether a session is attached.** Nothing in `PROTOCOL.md` leaves a presence marker
in Drive: `read_feedback` and `await_feedback` are pure reads, so no amount of polling can answer
it, and the type that models presence therefore has **no `attached` arm to render by mistake**.

What it CAN know, and must show:

- **How long.** Every thread and every reply carries Drive's own timestamp, so elapsed time is a
  subtraction against a clock — and the clock lives in the state tree, ticking about once a second,
  because a component reading `Date.now()` in its render body shows the time of the last unrelated
  re-render. That is exactly the "static line with no activity" the owner saw.
- **Whether anything has EVER been listening, and when it last proved it.** Every session-log event
  in Sasha's voice, and every reply, was written by an attached session and by nothing else. The
  newest of those is the last moment there is proof of life. With none at all, the surface says so
  outright — that wait will not end on its own.
- **Nothing, when a read that could disprove it has not come back.** "Nobody has ever answered" is a
  claim and needs a completed read behind it; a failed or in-flight read yields `unknown` with the
  reason, never "never".

Two transports, two rules for when a wait ends. A comment on a **candidate** waits until it is
**resolved** — the completion signal is a resolved thread with a revised slide, and the server has
`resolve_feedback` to close it with. A **message** typed into the conversation waits only until it
has a **reply**: nothing resolves a deck comment, so a thread that kept claiming to wait after Sasha
answered would be the same false alarm pointing the other way.

## The conversation is a serialized event log

Everything that happens is an event, appended in order, rendered in order. The conversation is
not a chat with artifacts bolted on; it is the log, and a "message" is just one event kind.

```
slides-staged      Sasha staged N candidates          [See the slides]
comment-opened     you, on slide 2, region or whole
comment-answered   Sasha replies to that comment
slide-revised      Sasha replaces slide 2             the new slide renders INLINE here
comment-resolved   that thread closes
slides-cleared     Sasha discards the uncommitted set
slide-inserted     slide 2 goes into the deck
```

Rules:

- **Append-only and ordered.** A reader must be able to reconstruct the whole session by
  replaying it. Nothing is edited in place and nothing is deleted from the log.
- **A comment is rendered as part of the user's turn**, not as a separate stream. You said a
  thing about slide 2; that is what the conversation shows.
- **Open comments stay listed until resolved.** They do not scroll away into history.
- **When Sasha resolves a comment and regenerates the slide, the new slide is output directly
  in the conversation** — inline, at that point in the log. That is the signal that the round
  trip completed.

## Review happens BEFORE inserting, on the candidates

This is the correction that matters most. Marking up a slide that is already in the deck is a
bug report; marking up a **candidate** is art direction, and it is the only one that lets Sasha
act. Comments attach to `(proposalId, slideIndex, region?)` — never to a deck page.

**How you know Sasha has acted: the comments are answered.** That is the completion signal in
the interface — not a spinner, not a toast. An answered comment with a revised slide beneath it
is what "done" looks like.

## Unresolved counts are shown in both views

Every slide carries its **unresolved comment count**, in the grid (on the cell) and in the
conversation (beside the slide's events). The two are reading the same state and must never
disagree; if one cannot reach it, it says so rather than showing zero.

## Sasha can clear uncommitted slides

A proposal that has not been inserted is disposable, and Sasha may discard it — that emits
`slides-cleared` like anything else. **Never silently.** An uninserted set vanishing without a
line in the log is indistinguishable from a bug.

## Anonymisation: lorem ipsum, always

One strategy. Visible text runs are replaced with lorem ipsum matched to the original's rendered
width; digits stay digits with magnitude and format intact. **Nothing original survives and
nothing leaves the browser** — no model round trip, works offline and on-premise. The
model-assisted and generic-vocabulary modes are withdrawn: the first sent the user's words to a
model, the second kept some of them by design, and neither is worth the complexity against a
guarantee this simple.

Everything below this line is the previous contract. The surface model above supersedes its
"three surfaces" section; the grid rules, the edit record and the editor interface still hold.

---

## Grid

`N` candidates in **two columns**, rows as needed. Each cell renders the candidate's own HTML
in an iframe, scaled down, never a screenshot — the HTML is authoritative and a thumbnail
would lie. Cells are numbered 1..N, matching `PICK.picked`, `await_pick`, and what the user
says out loud. **SUPERSEDED in one detail by "The popup IS the editor" above:** a cell is no longer
a button that opens an annotation screen. The cell's picture belongs to the current **tool** — the
annotate tool's drag gesture works on it right there in the grid — and changing the **view** to one
slide is a named control in the cell's footer. Everything else in this section stands.

The scale is **measured, not a constant**: the cell width depends on the width the window
actually granted and changes again if the grid reflows, so the frame is laid out at its real
1280×720 and transformed by `width / 1280` read off the laid-out box. A cell whose document has
not arrived, or cannot, says which on the cell — a grey box with no explanation is the failure
this contract already names below.

The grid follows the dialog's one HTML⇄rendered toggle rather than giving each cell its own:
comparing one candidate's HTML against another's conversion compares two different kinds of thing.

## The edit record — what travels to the model

A visual edit is **not** a new HTML file the model has to read. It is a structured record, so
the model learns the *intent* without the slide's content ever entering its context. This is
the same rule as everywhere else in this product: paths and facts in, never markup.

```json
{
  "protocolVersion": 1,
  "candidateIndex": 2,
  "edits": [
    { "kind": "moved",   "target": "h1.title",  "from": {"x":0.08,"y":0.10}, "to": {"x":0.08,"y":0.16} },
    { "kind": "resized", "target": "#chart",    "from": {"w":0.40,"h":0.30}, "to": {"w":0.52,"h":0.30} },
    { "kind": "recoloured", "target": ".accent", "property": "color", "from": "#2b3a8f", "to": "#111111" },
    { "kind": "retext",  "target": "h1.title",  "to": "Q3 infrastructure spend" },
    { "kind": "removed", "target": ".badge" }
  ]
}
```

- `target` is a **stable CSS selector** for the element, computed once when the editor loads and
  kept for the life of the session. It is the editor's job to make it unique and readable.
- Geometry is **fractional against the 1280x720 slide**, the same convention `PICK.anomalies`
  already uses for regions. Never pixels: the grid scales candidates and pixels would be a lie.
- `retext.to` carries the new text, because the user typing new words IS the instruction. It is
  the one place slide text legitimately crosses to the model.
- An edit the editor cannot express as one of these kinds must be **dropped with a warning**,
  never approximated.

The edited HTML is also written back so the picker inserts what the user actually sees. Both
travel together: `edits` teaches the model, the HTML is what gets inserted.

## The editor's interface

The visual editor is a **standalone module** with no knowledge of Apps Script, Drive or the
picker's state machine, so it can be developed and tested in a plain browser:

```ts
export type SlideEditor = Readonly<{
  /** Attach to an iframe already showing the candidate. */
  attach(options: Readonly<{ frame: HTMLIFrameElement; onChange: (edits: readonly SlideEdit[]) => void }>): void;
  /** Every edit so far, in the order made. */
  edits(): readonly SlideEdit[];
  /** The candidate's HTML with the edits applied, for writing back. */
  html(): string;
  /** Undo the last edit; returns false when there is nothing to undo. */
  undo(): boolean;
  detach(): void;
}>;
```

The host supplies the iframe and decides when to persist. The editor never calls the server.

`addon/src/editor/index.ts` is the module's public surface and the **single declaration** of
`SlideEditor` and `SlideEdit`. The host's side of the seam is `addon/src/slide-editor.ts`, which
**re-exports** those types rather than restating them — a second declaration compiles perfectly and
then drifts (a draft host had `recoloured.property: string` where the editor has a two-value
`ColourProperty`) — and adds only what the host owns: `nullSlideEditor`, a value that satisfies the
interface, reports zero edits and returns the HTML unchanged, and `slideEditRecord`. Nothing outside
the module reaches deeper than its `index.ts`.

The dialog chooses the implementation in exactly one place (`dialog.tsx`'s `createEditor`), and
records whatever the editor reports in the picker's state tree, so an edit survives a Drive poll
re-render. The list the host shows uses the editor's own `describeEdit` sentences: the editor is the
authority on what one of its edits means.

The annotation pane's iframe is `sandbox=""` — no scripts, no same-origin — because a candidate is
staged HTML of unknown provenance inside the user's logged-in Google session. An editor that needs
to reach into that document needs `allow-same-origin`; widening the sandbox is the editor module's
call to argue for, and the host does not grant it pre-emptively.

## Invariants

- **Numbering is 1-based** on every surface, matching `PROTOCOL.md`.
- **The HTML is authoritative.** The converted slide is a lossy projection of it; an edit edits
  the HTML, never the conversion.
- **No slide markup reaches the model.** Edits are structured records; `retext` is the only
  text that crosses, and only because the user typed it.
- **A surface that cannot reach the server says so.** Never render a spinner that cannot end —
  that bug has already been fixed once, in the review panel. Concretely: every load state is a
  union with a `failed` arm carrying the message, every loop is gated on an exhaustive predicate
  over that union (so a new variant is a compile error, not a skipped fetch), and "not connected"
  is a reportable outcome rather than an early `return`.
- **A re-read keeps what it had.** The conversation is polled every few seconds; a `loading` state
  that dropped its messages would blank the exchange on every tick, and a `failed` one that dropped
  them would lose the whole conversation to a single bad poll. Both carry the last good value.

## Known issue: the converter's extraction frame runs the candidate's scripts

`converter/convert-html-to-slide-requests.ts` loads the candidate with
`sandbox="allow-same-origin allow-scripts"` so it can inject the DOM extractor and read
computed styles. Inherited from `renderer/html2slides/browser/convert-core.ts`, which does the
same.

That combination means **the candidate's own scripts also run, same-origin with the add-on
sandbox** — so a staged candidate containing a script could call `google.script.run` as the
signed-in user (`sashaInsert`, `sashaSendFeedback`, and whatever `Code.gs` reaches). Candidates
are written by a model into the user's own Drive, so the realistic route in is prompt
injection: content that persuades the model to emit a `<script>`.

The two surfaces the USER looks at are already safe and stay that way: grid cells are
`sandbox=""`, and the editable annotation pane is `allow-same-origin` **without**
`allow-scripts`. Only the hidden extraction frame is affected.

Two ways to close it:

1. **Strip executable content before extraction** — parse the candidate, remove `script`
   (any namespace), `object`, `embed` and nested frames, drop `on*` attributes and
   `javascript:` URLs, then load that. Contained, testable, and it makes conversion MATCH the
   preview: the preview frame never runs scripts either, so today a script-rendered chart is
   visible to the converter and invisible to the user. Cost: a candidate that genuinely draws
   itself with script converts as its pre-script markup.
2. **`allow-scripts` without `allow-same-origin`** — the frame gets an opaque origin, the
   extractor still runs, and results come back by `postMessage`. Strictly safer and keeps
   script-rendered content, but it is a real redesign of the extraction path.

Not changed unilaterally: option 1 alters what gets converted for script-using candidates,
which is a product decision.

## ~~Anonymisation is model-assisted, but the model is never the safety net~~ — WITHDRAWN

**This whole section is history.** "Anonymisation: lorem ipsum, always" above withdrew the
model-assisted mode, so there is no model in the defect-report flow: nothing proposes a replacement
except the user, and the comment-pane round trip that asked for one is gone from `report.tsx`
(`rewrite-channel.ts` went with it). The division-of-labour table and the rejection rules below are
kept for ONE reason that still applies — the rules still judge **the user's own** replacement of the
title, and a refusal is still rendered. Read the rest as the reasoning behind that gate, not as a
description of a feature.

### The original section follows

The deterministic substituter produces `Dqtfnmlgq fakzqqz 3299532` — safe, and unreadable to
whoever has to diagnose the defect. A model can write *plausible* replacements of the same
shape ("Acme Corp revenue 3,200,000"), which makes a report worth receiving and a before/after
worth reviewing.

**The division of labour is not negotiable:**

| | who does it | why |
|---|---|---|
| visible text runs | the model proposes, the user may edit | readability is the whole point |
| attributes, `data-*`, `alt`, `aria-*`, comments, CSS `content:`, URLs, `data:` images, entities | the deterministic engine, always | a model will miss one, and missing one is the failure that matters |

**Every run the model did not replace is still substituted deterministically.** A model
omission must degrade to gibberish, never to the original. This is the single rule that keeps a
model's reliability out of the privacy guarantee.

**A proposed replacement is rejected, and falls back to substitution, when it:**
- equals the original, case-insensitively, or
- shares any 4-character substring with the original, ANYWHERE IN THE DOCUMENT — not merely a
  whole token, and not merely from the same run. A whole-token rule accepts `Northwind` ->
  `Northwi`, and a per-run rule accepts a reply that moves the company name from the heading
  into the footer. Measured cost of the stricter rule: 33% of plausible replacements rejected
  versus 22%. That is the right trade, because the errors are not symmetric — a false rejection
  costs one hand-edit in a surface built for hand-editing, a false acceptance ships the name.
- or is empty when the original was not.
Each rejection is reported, so the user sees that a run was gibberished rather than rewritten.

**Shape is preserved by the same rules as before** — length band, line count, digit count and
magnitude — because the defect reproduces off the layout. A replacement that changes the line
count is reported as a fidelity risk.

### The review surface

**SUPERSEDED by "The defect report is the same editor, not a table" above.** There is no run-by-run
table: the surface is the two slides, and the verdicts below are annotations pinned to the slide they
are about. The user can **edit the title**, **edit either slide**, and **re-anonymise**. Nothing is sent until they press send, and what is sent is byte-identical to
what the after column rendered — the existing `previewDefectReport` rule.

**The original text is never part of the payload.** It is NOT, however, confined to the
browser: asking a model to rewrite a run necessarily sends that run to the model. Say so in the
interface before the user starts, not after. The honest statement is "your slide's words go to
your model to be rewritten; they do not go to the report service" — and for an on-premise
deployment the model is the user's own, which is the case this product is built for.

No rejection rule can stop a model that ENCODES rather than echoes — base64, reversal, an
acrostic. The defences that remain are that the model is shown only the visible text runs, and
that the user reads the after column before sending. Do not imply otherwise.

#### Where the review surface lives, and how it is entered

**SUPERSEDED — it is a document of its own.** It was a fourth mode of the candidates window
(`PickerState.status === "reporting"`); it is now the third surface named at the top of this file,
`addon/src/report.tsx` + `report-state.ts` around the same `defect-state.ts`. The reason this
paragraph gave — *before and after, run by run, side by side* is a three-column table, and at the
sidebar's 300 px the two columns stack and stop being a comparison — still holds and is why it is a
WIDE window; what changed is that it is no longer the SAME wide window, because the slides bundle
cannot carry the anonymiser and stay under the size HtmlService relays intact. The converter is
reachable from both, so the payload's conversion is still made from the anonymised HTML in the
window that sends it (`previewDefectReport` takes a `convert` function, not a conversion).

**The action is in the chat area, because that is where the user is when they notice.** Two entry
points, both arriving at the same mode:

| from | how | why there |
|---|---|---|
| the mark-up view, on the candidate the user is looking at | `sashaOpenDefectReport({ proposalId, slideIndex })` | the slide that came out wrong is already on screen |
| the **conversation** | `sashaOpenDefectReport({ proposalId, slideIndex: null })` | the conversation is the only surface that is always open, and a defect is usually noticed later |

Both go through the SERVER now, because the report is a separate document: there is no in-process
`openReport({ index })` any more.

Both entries are the same cross-surface pattern as "show the slides", for the same reason: the
documents share nothing, so "open that window **on slide 2**" cannot be a message between them.
`sashaOpenDefectReport` RECORDS the target (user properties) and then shows the window; the window
asks for it once with `sashaTakeReportTarget`, which CLEARS it — so a report window opened later
comes up on the first staged candidate rather than on a slide the user finished with yesterday.
Recording the target is best effort: if it fails the window still opens, picks the first candidate,
and SAYS SO — `describeChosenTarget` names every way of not finding the asked-for slide, so the
window never shows slide 1 while the user remembers pressing the button on slide 3. A hint that
failed may never swallow the thing the user asked for, and it may never silently substitute.

**Prepare, then send — two presses, and the second is the only thing that leaves the browser.**
Preparing is what calls `previewDefectReport`, so it is where the conversion happens and where
`findForbiddenStrings` runs. One counter (`Defect.generation`) is bumped by everything that changes
the after column; the pass and the prepared preview each record the generation they were built at,
and `sendablePreview` returns a payload only when all three agree. An edit after preparing therefore
disables Send and says why, rather than sending the bytes from before the edit. That is how
"byte-identical to what the after column rendered" is enforced structurally rather than by care.

**A refused replacement must be cheap to fix.** With lorem-always the only replacement anyone
proposes is the user's own, so the "only the N refused" filter had nothing to filter and is gone with
the table. A refusal is now an annotation pinned to the slide, next to the field that caused it.

**The report service is configurable and its absence is a verdict.** The endpoint is a field on the
surface (defaulting to the service's own loopback default) because the service is not running by
default; nothing answering is rendered as `unreachable` with the endpoint and what to do about it,
never as a spinner. The payload is a transcription of `report-service`'s wire format — that service
imports nothing from here — and `versions.anonymiser` plus the whole `anonymisation` summary have
nowhere to go on it, so they are shown to the user and not sent.

## Comments look like Google's comments

Both conversations — the Ask Sasha log and the slides window's mark-ups — are comments on a
slide, and the user reads them beside Google's own comment pane. So they have Google's shape,
read off a real Slides comment card: a round avatar with one initial, the author's name in
medium weight, the time under it as "12:08 AM Today", and the body at the card's own left edge
rather than indented under the avatar. One component (`comment-card.tsx`), both surfaces, so
they cannot drift apart.

A **message** is a card. An **event** ("Sasha staged 4 candidate slides") is not: it is a quiet
system line in the voice that caused it. Tinting a card as well made it read as a highlighted
table row rather than as something a person wrote.

A mark-up is written in a **textarea**, not an input: a comment about a slide is usually two
sentences. Enter inserts a newline; Ctrl/Command + Enter sends, which is the pair of keys
Google's own comment box uses.

## The converter speaks under the hood

What the converter could not express is **drawn on the slide and sent with the PICK, but it is
never a row in the user's mark-up list**. Those two lists answer different questions — "what did
I say is wrong?" and "what did the machine already know?" — and merging them made a proposal
open with thirteen rows the user never wrote, above the one they did.

## When nothing is listening, the instruction leads

The remedy goes **above the log**, not inside the pinned panel below it. It is the one situation
where waiting longer cannot help, so it is the only thing on screen worth reading first — and a
remedy the user has to scroll to find is a remedy they do not have.

## No identifier is ever typed by a person

Nothing the interface asks the user to paste may contain a `proposalId`, a file id or any other
server-minted handle. `open_work` takes no arguments and answers from the authenticated account;
the id goes to the model, machine to machine. If a sentence meant for a human needs an id, the
tool surface is wrong, not the sentence.

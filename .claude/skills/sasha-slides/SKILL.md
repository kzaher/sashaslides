---
name: sasha-slides
description: Offer the user a choice of candidate slides in Google Slides and act on the one they pick. Stage several HTML candidates through the sasha-slides connector, let the user compare and mark up what is wrong, then insert their choice as native editable objects. Use whenever the user asks for a slide, a deck, or options for a slide — not just when they say the word "candidates".
user_invocable: true
---

# sasha-slides

Give the user a **choice** of slides and put the winner in their deck as editable objects.
Use for any "make me a slide / a deck / options" request. The user chooses.

## The one rule that matters

**Slide HTML travels by FILE PATH and is never read into context — going in or coming back.**

Write each candidate to a temp file and pass its **path**; never paste markup or read one
back. Four candidates must cost the same context as one — that is
the whole design. Only the `label`, a six-word caption, crosses.
Remote (https) connector: send each document as `html`, not `path`.

## The loop

1. **Write candidates** — each a self-contained 1280x720 HTML document, everything inline.
   Not a fragment.
2. **`propose_slides`** `{ slides: [{ path, label }], presentationId? }` → `{ proposalId,
   count, slides }`. Keep the `proposalId`; `open_work` `{}` re-finds it. Never hand-write the
   Drive files — the server owns them, `READY` last.
3. **`await_pick`** `{ proposalId, timeoutSeconds }` — blocks, correctly. Branch on
   `status`: `picked` (1-based index) · `dismissed` (none worked; ask why, insert nothing) ·
   `timeout` (check `proposal_state` and wait again;
   Never stage a second proposal while the first is unanswered) ·
   `unsupported-protocol-version` (report it, never guess).
4. **Review happens on the CANDIDATES, before inserting** — `read_feedback`,
   `reply_feedback`, `resolve_feedback`, `await_feedback`, addressed by
   `{ proposalId, slideIndex }`. Answering IS the completion signal.
5. **Anomalies** are `{ index, note, region }`, fractional against 1280x720.

## Revise in place, clear loudly, replay the log

* **`revise_slide`** `{ proposalId, slideIndex, path, label?, answeredCommentIds? }` replaces
  one candidate's HTML by **file path**. The Drive file id does not change, so the user's
  comment threads stay attached; `manifest.revision` is bumped last, which is what the
  interface polls. An answered comment with a revised slide under it is what "done" looks
  like — so answer the comments the revision fixes.
* **`clear_slides`** `{ proposalId, reason? }` discards the uninserted candidates. Never
  silent: it writes `slides-cleared` to the log, and keeps anything already in the deck.
* **`session_events`** `{ proposalId }` replays the whole session in order: staged,
  commented, answered, revised, resolved, cleared, inserted.
* **`slide_images`** `{ proposalId, indices?, outDir }` returns local render PATHS, never
  image data, once the picker has rendered anything.

## Comments in the user's own deck

When the user wants their deck's comments answered, call **`watch_comments`** `{ deck }`
with the deck URL. Sasha acts as the user, with their own Google sign-in: there is no bot
account to share the deck with. The first time for a deck it answers with a
`https://sashaslides.com/comments/allow?deck=…` link: give it to the user (they choose the deck
once in Google's file picker) and call `watch_comments` again when they say it is done. While
the watch lasts (24 hours; calling it again renews), every new comment or reply on the deck
becomes a task: **`comment_tasks`** lists them (so does `open_work`) and posts a
"Sasha: On it ⏳" acknowledgement in each new task's thread by itself, and
**`reply_comment_task`** `{ taskId, text }` replaces that acknowledgement with your answer,
posted as the user with "Sasha: " added for you; a link in the text is fine.
**`list_watches`** shows the active watches; call **`stop_watching`** `{ watchId }` when the
user is done.

## Sasha decks

Decks in Sasha's own editor (`https://sashaslides.com/deck/<id>`) are edited live: people
see your change as you make it, under your `summary`, and can undo it.

* **`deck_list`** and **`deck_create`** `{ title }` give each deck's `address`; hand it to
  the user.
* **`deck_read`** `{ deckId }` **before every edit**: slide and element ids, frames, text.
* **`deck_edit`** `{ deckId, summary, edits }`: **one call per user request**. All its edits
  are one undo step, all or nothing; a refusal names the failing `editIndex` and why. Give a
  new slide or element your own `id` to address it later in the same call.
* **`deck_write_transition`** saves a scripted transition **unapproved**: it runs only after
  a person reviews it, so give the user its `reviewAddress`.
* Builds and morph are `deck_edit` edits: `addAnimations` (fly in, fade, spin, ... one click
  each), `updateAnimations`, `moveAnimations`, `removeAnimations`; a morph is a `setSlide`
  transition paired by `morphKey`. **`deck_write_animation`** saves a scripted build step
  **unapproved**, reviewed by a person like a transition.
* **`deck_revert`** `{ deckId }` undoes this session's edits.
* Comments: **`deck_read_comments`** returns a `sequence`; **`deck_reply_comment`**,
  **`deck_resolve_comment`** `{ note? }`; **`deck_await_comments`** `{ afterSequence }` waits
  for the next one. Answering is the completion signal.

## Slides are 1-based

Candidate 1 is the first slide you passed; the picker, `await_pick` and the user agree.
"Option 3" is `slides[2]`. Never re-index silently.

## Candidates should differ in a nameable way

Layout, density, emphasis — not wording.
Four is a good default; one is not a choice and six is a reading task.

## Get something on screen fast

The worst version of this is a long silence then four slides. The user should have something
to react to in seconds, because **their reaction is what makes the next round worth waiting
for.**

- **Draft the first candidates with a fast subagent** on a tight brief: "four self-contained
  1280x720 HTML slides on X, four genuinely different layouts, one file each under <dir>,
  reply with just the paths". A quick model is right for this — obvious-but-competent layouts
  whose job is to give the user something to point at.
- **Propose as soon as they exist.** Do not polish first.
- **Then think harder while the user looks**, driven by what they pick and mark rather than
  by your own taste.

One proposal at a time. Streaming a fast wave and a deeper wave into the *same* proposal needs
a protocol change that does not exist yet, so today the latency win comes from drafting fast,
not from staging twice.

## Redesigning part of an existing slide

When the user wants to change part of a slide that is already in the deck, propose a MERGE
instead of a new slide. `slide_structure` `{ presentationId, slideNumber }` lists the slide's
elements: object id, kind, text excerpt, box on the 1280x720 frame, z-order. Each candidate's
HTML then holds ONLY the new parts, on a transparent page, and `remove` names the object ids it
replaces. A new element's CSS `z-index` on its top-level box places it: negative goes behind the
slide's kept content, anything else in front. `propose_slides` `{ slides: [{ path, label,
remove }], merge: { presentationId, slideObjectId } }`. If the slide changed before the pick, the
add-on refuses the stale ids and changes nothing; read it again and re-propose.

## Diagrams (draw.io)

A draw.io diagram goes into a deck as a picture linked to its editable source, kept in the
user's Drive at `sasha_slides/slide/<presentationId>/drawio/<diagramId>.drawio`.

* **New diagram:** `propose_slides` `{ slides: [{ drawioPath, title?, label }], presentationId }`
  with a `.drawio`, `.drawio.svg`, `.drawio.png` or `.xml` file (remote connector: `drawio`, the
  XML itself). Pass `presentationId`: the source is then saved where `deck_diagrams` can read it.
  A diagram inside your own HTML candidate works too: an inline `<svg data-drawio>` plus
  `<script type="application/vnd.drawio+xml" id="drawio-source">` holding the XML.
* **Existing diagram:** `deck_diagrams` `{ action: "list", presentationId }` gives each one's
  slide, `objectId`, `diagramId`, `readable` and `stale`. `read` `{ presentationId, diagramId }`
  returns a PATH to the XML; edit that file, then `write` `{ presentationId, diagramId, path }`.
  Writing never re-draws the picture: ask the user to open **SashaSlides › Edit diagram** in the
  deck, which refreshes stale pictures, or propose the new version as a `drawio` candidate.
* **Copy-on-write:** a slide copied from another deck still links to that deck's file. `write`
  saves a copy in THIS deck's folder and re-links every picture here; the other deck is untouched.
* **`readable: false`:** the connector holds Google's `drive.file` permission, so it reads only
  files it created; a diagram drawn in the add-on is not readable. Ask the user for the `.drawio`
  file, or `write` new XML, which creates this deck's own copy.

## Anomalies and what cannot convert

An anomaly is a complaint about the conversion of that region. Fixable in HTML → write a
better candidate and propose again. Some things Google Slides genuinely cannot express —
conic gradients, gradient-clipped text, inset shadows, backdrop blur. Say so plainly and offer
a treatment that survives rather than retrying the same thing.

## Before the first call

Only with this repository checked out: the connector needs working Google credentials, and a
proposal with broken credentials fails halfway and leaves a partial folder.

```bash
.agent/skills/sasha-slides/sasha-slides.sh check --write
```

Exit 0 means the token refreshes, the scopes cover Slides and Drive, and a real create and
delete both succeeded. Anything else prints the remedy — relay it and stop.

The user also needs the picker open: **SashaSlides → Open the picker**. Without it nothing
renders and `await_pick` times out. The panel shows an idle message for a few seconds while it
first checks Drive; that is normal.

## Harness (only with this repository checked out)

```bash
s=.agent/skills/sasha-slides/sasha-slides.sh
$s check --write                               # auth gate
$s e2e                                         # whole loop on a local fake Drive, ~2s
$s e2e --drive real --only propose --keep      # real Drive, one phase at a time
$s selftest                                    # proves the assertions actually bite
```

`--inject ready-early|drop-slide|tamper-pick` must each turn a phase red.

## Connecting the connector (only if it is not attached yet)

`mcp/sasha-slides/CONNECT.md` has the full instructions. Short version:

```bash
claude mcp add sasha-slides -- npx tsx /workspaces/sashaslides/mcp/sasha-slides/server.ts --stdio
```

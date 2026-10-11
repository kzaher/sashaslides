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

Write each candidate to its own temp file and pass the **path**. Never paste markup into a
tool argument and never read a candidate back.
Four candidates must cost the same context as one — that is the whole design. The only slide
text that crosses is the `label`, a six-word caption for the picker.

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

## Slides are 1-based

Candidate 1 is the first path you passed; the picker, `await_pick` and the user agree.
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

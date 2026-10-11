# Handoff: sasha-slides add-on (2026-10-11)

## Committed

| Task | Status | Files |
| --- | --- | --- |
| "Nothing has picked this up" notice disappeared with no bot connected | Done, tested | `addon/src/waiting.ts`, `addon/src/conversation-state.ts` (+ tests) |
| Sidebar candidate thumbnails + slide context on open comment threads | Done, unit-tested, not checked in a browser | `addon/src/slide-previews.ts`, `addon/src/slide-thumb.tsx`, `addon/src/Conversation.tsx`, `addon/src/sidebar.tsx`, `addon/src/picker-styles.ts` |

### Notice fix: why it disappeared

1. A `slides-staged` log entry counted as "Sasha acted", so once candidates existed the add-on believed a listener was
   present forever. Evidence older than the 5-minute threshold now counts as none (`presenceIsSilent()` in
   `waiting.ts`).
2. Any reply, including the user's own, ended a message's wait. Only replies with `authoredByAgent` count now.
3. Every 8 s poll reset presence to "unknown" while the reads were in flight. `readOnce` in `conversation-state.ts` keeps
   it.

Behaviour change: the notice now also appears about 5 minutes after Sasha's last action when a session is attached but
idle, because an idle session leaves no trace.

### Open follow-ups

- The top-right spinner (`anythingInFlight`, `addon/src/Conversation.tsx` header) shows on every poll and reads as
  "working" while nothing is listening. Hide it when `nothingListeningFor(conversation) !== null`, or relabel it.
- With no candidates staged, the notice never shows, because the log and candidate comments are never read, so presence
  stays "unknown".
- Check the thumbnails in a real sidebar with 8 candidates and several open comments: each one is an iframe.

## Committed: conversion caching

**Converted view waited for conversion every time.** Root causes:

1. `addon/src/dialog.tsx` `convert()` used `newPageObjectId({ random: Math.random })`, so every conversion contained a
   random page id. `addon/src/render-cache.ts` keys pictures by a hash of the requests, so it never hit. Fixed by
   `previewConversionSpec()` in `addon/src/slide-insert.ts`: a fixed page id from proposal id + slide number. Insert
   still uses a fresh random id.
2. The HTML-to-requests conversion was not cached. New `addon/src/conversion-cache.ts`: localStorage, keyed by build
   hash (`window.sashaBuild`, set by `build-addon.ts`) + deck + page id + HTML, max 24 entries, skips entries over 512
   KB.
3. `nextToConvert` (`addon/src/picker-state.ts`) converted nothing until Converted was clicked. Preview now converts in
   the background when idle; Converted converts immediately.

Not verified in a real browser or deployed.

### "Open slide N" is slow: not fixed

- Every page ships its whole bundle inline, so nothing is cached between opens: Dialog 496,321 bytes (154 KB gzip),
  Report 488,873, Sidebar 348,885. About 205 KB of each is react-dom. Dialog has about 15 KB headroom under the
  512,000-byte limit.
- Opening is a chain of Google round trips in series: `sashaOpenPicker` → page load → `sashaHello` → inbox scan → HTML
  downloads. Not measured live.
- Recommended next: switch to preact/compat (about 190 KB less per page), then measure the round-trip chain in a real
  browser. Caching the bundle in localStorage needs a new server function and a deploy-script change.
- HTML is not cached across opens: a revised slide overwrites the same Drive file and the proposal has no
  `modifiedTime`, so a fileId-keyed cache would show stale slides. Adding `modifiedTime` to the proposal would unblock
  it.
- The first Converted view for a new proposal still needs one server render (it creates and trashes a temporary deck).

## Verify

```sh
cd mcp/sasha-slides/addon
npm ci
npm test   # typecheck + node --test; takes more than 2 minutes on the devcontainer
```

Nothing is deployed to Apps Script. Deploy with `addon/deploy-via-ide.ts`. See the Apps Script section of the root
`CLAUDE.md`.

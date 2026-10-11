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

## Not committed: in progress

**Converted view waits for conversion every time, and "Open slide N" is slow.**

Root cause, from reading the code:

- `addon/src/render-cache.ts` keys Google's rendered picture by a hash of the converted requests.
- `addon/src/dialog.tsx` `convert()` passes `newPageObjectId({ random: Math.random })`, so every conversion contains a
  random page id. The key changes on every open, and the cache never hits.
- The HTML-to-requests conversion itself is not cached, and `nextToConvert` (`addon/src/picker-state.ts`) converts
  nothing until the user opens the Converted view.

Planned fix:

1. Use a deterministic preview page id (from proposalId + index). `sashaRenderPreviews` in `build-addon.ts` retargets
   to its own page anyway. Insert keeps a fresh random id.
2. Add a localStorage conversion cache keyed by an HTML hash (new `addon/src/conversion-cache.ts`).
3. Convert in the background after the HTML arrives.
4. Measure the dialog bundle that is re-sent on every open, and consider caching it by build hash.

That work was still running in this checkout when this was written. It is uncommitted and does not typecheck yet
(`dialog.tsx`), so do not rely on it.

## Verify

```sh
cd mcp/sasha-slides/addon
npm ci
npm test   # typecheck + node --test; takes more than 2 minutes on the devcontainer
```

Nothing is deployed to Apps Script. Deploy with `addon/deploy-via-ide.ts`. See the Apps Script section of the root
`CLAUDE.md`.

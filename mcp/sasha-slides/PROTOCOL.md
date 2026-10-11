# sasha-slides: MCP ↔ Drive ↔ extension contract

The single source of truth for the staging protocol. Three components are built against
it in parallel, so **change this file first, never a component's local assumption**.

## The shape of the thing

1. Claude calls the MCP server with **N candidate slides as HTML file paths**. The HTML is
   never read into the model's context — paths in, ids out. ("without transcribing content")
2. The MCP server uploads each HTML to a per-proposal Drive folder, writes `manifest.json`,
   then writes **`READY` last**. `READY` is the "final mark": until it exists the proposal is
   partial and must be ignored.
3. A content script in Google Slides observes Drive for new `READY` markers, renders a
   picker, and **converts the HTML to slides client-side** — no pptx, no `File > Import
   slides`. Target: seconds.
4. The user sees the **HTML first**, can toggle **HTML ⇄ rendered slide**, picks one, and may
   attach **conversion anomalies** per slide.
5. The extension writes `PICK`. The MCP server is waiting on it and returns the choice plus
   any anomalies to Claude.

Slides are **1-based** everywhere, matching `sasha-bridge`'s existing convention, so a human
can say "option 3" and every component means the same slide.

## Drive layout

Every file carries `appProperties` so the whole protocol works under the **non-sensitive
`drive.file`** scope (an app sees the files it created). Full `drive` also works but is a
restricted scope needing app verification plus a security assessment for a server.

```
Sasha Slides Inbox/                 appProperties {sashaSlides: "inbox"}
  <proposalId>/                     appProperties {sashaSlides: "proposal", proposalId}
    01.html … NN.html               appProperties {sashaSlides: "slide", proposalId, index: "1"…"N"}
    manifest.json                   appProperties {sashaSlides: "manifest", proposalId}
    READY                           appProperties {sashaSlides: "ready", proposalId}   ← written LAST
    PICK                            appProperties {sashaSlides: "pick", proposalId}    ← written by the extension
```

`proposalId` is `p_<epochMillis>_<6 random base36 chars>` — sortable and collision-free
without coordination.

## Identity: both components MUST be the same OAuth client

**Confirmed from the vendor types in-tree** (`node_modules/googleapis/build/src/apis/drive/v3.d.ts:772`):
`appProperties` are *"private to the requesting app."* `drive.file` is per-app in the same
way — an app sees the files **it** created.

Consequently the extension cannot see the server's `READY`, and the server cannot see the
extension's `PICK`, **unless both authenticate as the same Google Cloud client ID.** Moving
the tags to public `properties` does not rescue it, because `drive.file` still gates which
files each app can see at all.

This rules out the obvious extension auth route: `chrome.identity.getAuthToken` requires a
*Chrome Extension*-type client keyed to the extension id, which is necessarily a different
client id from the server's Desktop client. Two options remain:

- **A — one shared client.** The extension uses the *same* Desktop client id via a web OAuth
  flow and keeps its own refresh token. Preserves Drive-as-transport exactly as designed;
  cost is a refresh token living in extension storage.
- **B — the extension never touches Drive.** The server does all Drive work and notifies the
  extension over `localhost`; Drive stays the durable store and the audit trail. Fewer moving
  parts and no second credential. (An extension with `host_permissions` reaching localhost is
  already proven in this repo — see `nanobox/extension`.)

**Decision pending.** Until it is made, build the Drive read path behind an interface so
either option drops in. Do not assume a second client id will work; it will not.

## Discovery is by NAME, not by appProperties

`appProperties` are private to the writing client (see the section above), so **no component
may discover another's files through them.** Discovery is by folder and file *name* inside
the user's own Drive:

- the inbox folder is found by name `Sasha Slides Inbox` under My Drive
- a proposal folder is found by its `proposalId` name under the inbox
- `READY`, `PICK`, `manifest.json`, `NN.html`, `render/NN.png` are found by name within it

`appProperties` remain useful as a server-side tag for the server's own queries, and the
protocol still specifies them, but **nothing cross-component may depend on reading them.**

This is what makes the add-on path work: an Apps Script add-on runs as the **signed-in user**
with the `drive` scope, so it can see every file that user can see — including files the MCP
server created in that user's Drive — even though it cannot read the server's private tags.

## The UI vehicle: Apps Script add-on, not necessarily a Chrome extension

The repo already has a Google Slides add-on that loads a server-hosted UI into the Slides
sidebar: `renderer/html2slides/addon-server/` (see its `DEPLOY.md` Phase 2, and
`api/export-appsscript.gs.txt`). It authenticates with `ScriptApp.getOAuthToken()` — the
signed-in user's own token, so there is **no client file, no consent screen to operate, and no
refresh token to store**. Its own header states it: *"there are no .auth/*.json files — the
user's own Slides/Drive grants apply."*

That is per-account OAuth for free, and it is already inside the Slides UI, which is where the
picker belongs. A Chrome extension is the fallback if the add-on cannot do something it needs
(e.g. a UI surface outside the sidebar). Prefer the add-on.

Declared scopes for the add-on, per `DEPLOY.md` 2c: `presentations`, `drive`,
`script.container.ui`, `script.external_request`.

## Render artifacts

The protocol defines no image until the extension produces one, because conversion happens
client-side. After converting slide *N*, the extension writes the rendered PNG back:

```
<proposalId>/render/NN.png        appProperties {sashaSlides: "render", proposalId, index: "N"}
```

`slide_images` serves these. Before conversion has run there is nothing to serve, and the
tool returns an explicit "unavailable" rather than inventing an image. Writing renders is the
one exception to "the extension writes only `PICK`".

## File formats

`manifest.json`

```json
{
  "protocolVersion": 1,
  "proposalId": "p_1733219000000_a1b2c3",
  "createdAt": "2026-10-03T12:00:00.000Z",
  "presentationId": "1AbC…",
  "count": 4,
  "slides": [{ "index": 1, "fileId": "1Xyz…", "name": "01.html", "label": "Timeline, 3 phases" }]
}
```

`presentationId` is the target deck when known, else `null`. `label` is a short
human-facing caption for the picker; it is **not** a transcription of the slide.

`READY` — the sentinel. Small on purpose; the observer reads it to find the manifest.

```json
{ "protocolVersion": 1, "proposalId": "p_…", "count": 4, "manifestFileId": "1Mno…" }
```

`PICK` — written by the extension once the user decides.

```json
{
  "protocolVersion": 1,
  "proposalId": "p_…",
  "picked": 2,
  "decidedAt": "2026-10-03T12:00:21.000Z",
  "insertedObjectIds": ["g123abc"],
  "anomalies": [
    { "index": 2, "note": "chart gridlines lost", "region": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2 } }
  ]
}
```

`picked` is `null` when the user dismissed the picker without choosing. `region` is
fractional (0–1) relative to the 1280×720 slide, so it survives any scaling. `anomalies`
may be empty and may reference slides other than the picked one.

## Invariants every component must honour

- **`READY` is written last**, after every HTML and the manifest. An observer that sees
  `READY` may assume the proposal is complete.
- **Nobody mutates another component's files.** The server writes everything except `PICK`
  and `render/*.png`; the extension writes only those two.
- **`protocolVersion` is checked on read.** An unknown version is ignored with a logged
  warning, never guessed at.
- **Slide HTML is a full self-contained 1280×720 document** (own `<head><style>`,
  `body{width:1280px;height:720px}`) — not a fragment. Same rule as `sasha-bridge`.
- **The HTML is authoritative.** The rendered slide is a lossy projection of it, which is
  why the user can toggle and file anomalies.
- **A proposal folder is disposable.** The server may delete it after `PICK` is consumed;
  nothing may assume it persists.

---

# Feedback over native Google Slides comments

A second, independent channel: the **user → agent → user** loop. The staging protocol above
is how the agent proposes; this is how the user answers back, and how the agent answers them.

The transport is **Google Slides' own comment threads**. The user selects a slide (or a shape,
or a run of text), files a comment the way they always have, and presses send. The agent reads
the thread, acts, and **replies inside that same thread**, so the answer lands where the
question was asked and Google's own notification tells the user it arrived. There is no new
surface for the user to learn and nothing to install — which is the "your tools, no lock-in"
promise, kept.

The carrier is the **Drive** comments API (`drive.comments.*`, `drive.replies.*`) addressed by
the presentation's **file id** — a Slides file id *is* a Drive file id, so `presentationId` is
all a caller ever passes. Auth is the single `OAuth2Client` from `google-auth.ts`; there is no
second credential path.

## The tool surface

| tool | arguments | returns |
|---|---|---|
| `read_feedback` | `presentationId`, `since?`, `includeResolved?` | every open thread: `commentId`, author, verbatim `text`, created/modified time, raw anchor **plus** its reading, the slide when determinable, `quotedText`, and all replies — plus a `cursor` |
| `reply_feedback` | `presentationId`, `commentId`, `text` | `replyId`, `createdTime`, `resolved` |
| `resolve_feedback` | `presentationId`, `commentId`, `text?` | same shape; `resolved` is **read back**, not assumed |
| `await_feedback` | `presentationId`, `timeoutMs?`, `since?` | `status: "arrived" \| "timeout"`, the new `posts`, and the next `cursor` |

`await_feedback` mirrors `await_pick`: one narrow query per poll, exponential backoff
(1 s → 10 s, ×1.6), the final sleep clipped to the deadline, and **a timeout returned as a
value, never thrown**. It takes `timeoutMs` where `await_pick` takes `timeoutSeconds` — the
only deliberate divergence.

## What the `anchor` really contains

Google documents `Comment.anchor` only as *"a region of the document represented as a JSON
string"*. That is not enough to build on, so it was **measured against the live deck**
(`e2e/feedback-live.ts` re-proves all of it on every run).

**1. Drive validates nothing.** `drive.comments.create` accepted the anchor
`"this-is-not-json-at-all"` and `drive.comments.list` returned it verbatim. The anchor is an
opaque pass-through string as far as Drive is concerned, so it is **untrusted input** and is
parsed at the boundary in `feedback/comment-anchor.ts`.

**2. Google Slides writes a JSON object that names the slide.** Observed by having the Slides
API author the anchor (`presentations.batchUpdate` → `insertComment`, which is the surface the
Slides UI itself drives) and then reading the same comment back through `drive.comments.list`.
These are the real strings:

```json
{"uid":650326478,"pages":["sasha_s0fao02zbr2o"],"type":"page"}
{"uid":211246977,"page":"p","type":"shape","targets":["i0"]}
{"uid":1888281314,"subtype":"text","page":"sasha_s0fao02zbr2o","type":"shape","targets":["sasha_s0fao02zbr2o_text2"]}
```

| `type` | slide id lives in | also carries |
|---|---|---|
| `page` | `pages[0]` — **an array**, even for one slide | — |
| `shape` | `page` — **a single string** | `targets`: the page element ids |
| `shape` + `subtype:"text"` | `page` | `targets`, and the marked run in `quotedFileContent` |

Mind that asymmetry (`pages` vs `page`); it is the easiest thing to get wrong. `uid` is an
opaque per-anchor integer with no meaning to us.

**So the anchor IS usable: it identifies the slide, and for an element anchor the element.**

**3. The format is per-editor, so nothing may assume it is JSON.** The same field on a Google
**Docs** file in this account holds a bare opaque token — `"kix.uyz42h4rp0wc"` — with the
anchored text in `quotedFileContent.value`. The legacy `{"r":<revision>,"a":[<classifiers>]}`
scheme the older Drive guide describes was never observed from any editor. Both land in the
`opaque` variant, which reports the **raw string** rather than claiming no location, so an
agent can still see what Google stored.

## Mapping a comment to a slide

`SlideLocation` is resolved in this order, and the source is always reported:

1. **`slides-anchor`** — the anchor above. Authoritative, because Slides wrote it. The page
   object id is turned into a **1-based slide number** via `presentations.get` (`slides(objectId)`),
   matching "slides are 1-based everywhere".
2. **`sidebar-sentinel`** — the add-on's own `sasha-slides-feedback=` line (below).
3. **`text-marker`** — a leading `[slide:<pageObjectId>]` or `[slide:<1-based number>]`.
4. **`unknown`**, with a reason — never a guess.

### The add-on sidebar's sentinel

The sidebar half writes its notes through the Drive API, so they are unanchored, and it
carries the page **and the box the user dragged** in the body instead. One format, stated
here, written by `addon/src/feedback.ts` (`feedbackCommentContent`) and read by
`feedback/comment-anchor.ts` (`parseFeedbackSentinel`). The user's prose comes first, because
that is what a human reads in the comment pane; the sentinel is the **last** line:

```
the chart lost its gridlines

sasha-slides-feedback={"protocolVersion":1,"noteId":"user_k2h9","pageObjectId":"g2d1","region":{"x":0.1,"y":0.2,"w":0.3,"h":0.2},"createdAt":"2026-10-04T12:00:00.000Z"}
```

`region` is fractional (0–1) against the slide — **the same convention `PICK.anomalies`
uses**, so there is one coordinate system in the whole protocol — and is `null` for a note
about the slide as a whole. `read_feedback` surfaces it as `region` and `noteId` on the
thread, so the agent learns *where* on the slide the user pointed.

It is parsed defensively: the sidebar is a different process, the user can type anything, and
a region whose numbers are not fractional is **dropped** rather than pointed at the wrong
place. A comment with no sentinel is simply somebody's own comment on the deck, reported with
its text and whatever location can be found — never an error. The string is declared in both
packages rather than one importing the other's browser bundle; this file is the contract.

The fallback is needed because of a hard limitation: **a comment created through the Drive API
is unanchored.** Google's own guide is explicit — *"Google Workspace editor apps (such as Docs,
Sheets, and Slides) don't render comments created with the Drive API anchored to content; they
treat these comments as unanchored comments."* Verified: `drive.comments.create` returns a
comment with no `anchor` field at all. So anything **we** create (our sidebar, or a future
`create_feedback`) must carry the marker, while anything the **user** files from the Slides UI
is anchored for free and needs nothing.

The marker is read **only at the front of the text**, so prose mentioning `[slide:2]`
mid-sentence is not mistaken for a location. The anchor always wins over a contradicting
marker. Text is reported **verbatim**, marker and all — the slide is reported alongside it,
never by editing what the user wrote.

To anchor a comment properly, the **Slides** API is the only way:
`presentations.batchUpdate` with `insertComment` and `objectId` / `shapeTextAnchor` /
`tableCellTextAnchor` / `tableAnchor`. It is not wired into a tool yet; see the limitations.

## Resolving is a reply, not an update

`Comment.resolved` is **output only**. `drive.comments.update({resolved: true})` is rejected
outright with *"Comment content is required."* A thread is resolved by
`drive.replies.create` with `action: "resolve"` — which, being a reply, **must** carry text, so
`resolve_feedback` posts `DEFAULT_RESOLVE_NOTE` when the caller supplies none. The thread is
then re-read and the reported `resolved` is the observed value.

`comments.list` **returns resolved threads too**; Drive offers no server-side filter for them
(only `includeDeleted` and `startModifiedTime`), so `includeResolved` filters client-side.
`resolved` is **absent**, not `false`, on an open thread.

A **deleted** comment is a `404` from `comments.get`, not a record with `deleted: true`.

## The cursor: why a timestamp alone is not one

Three measured facts drive `FeedbackCursor`:

- **`startModifiedTime` is inclusive.** A comment whose `modifiedTime` equals the filter is
  returned. A bare watermark therefore re-reports the same post for ever, and `await_feedback`
  would return instantly on week-old feedback.
- **A reply bumps its parent comment's `modifiedTime`** to the reply's own time. That is what
  lets **one** cursor cover "a new comment *or* a new reply" with a single query.
- **A post's own creation time never changes.**

So the cursor is `{ modifiedTime, seenPostIds }`: a watermark for the query, plus the ids of
the posts sitting exactly on it for the dedupe. It stays small because it names only the posts
*at* the watermark, never the whole history. Using it as `startModifiedTime` is sound because a
thread's `modifiedTime` is never older than the newest post in it, so no thread holding new
posts can be filtered out.

Every post is dated by **when it was created**, never by Drive's `modifiedTime` — otherwise a
month-old comment would look brand new every time anybody answered it.

`await_feedback` with **no** `since` seeds the cursor from the deck's *current* posts, so
"from now" means "nothing that already exists" rather than "nothing older than this
millisecond". Pass the returned `cursor` back verbatim to continue exactly where you left off;
a `timeout` returns the cursor **unchanged**, so re-calling it misses nothing.

## Telling the agent's posts from the user's

The server authenticates **as the user**, so Drive reports `author.me === true` for the user's
comments **and** for the agent's replies alike. Identity cannot separate them.

Every reply this server writes therefore ends with `AGENT_REPLY_MARKER`:

```
redrawn with larger axis labels

[sasha-slides-agent]
```

`await_feedback` advances its cursor past agent-authored posts but **never ends the wait on
them**, so `reply_feedback` followed by `await_feedback` waits for the *user* instead of
returning the agent's own words. The marker is deliberately visible in the Slides UI, so the
user can see which replies came from the agent.

## Scopes

Full `drive` works and is what this was verified with. The Drive comments guide demonstrates
only `https://www.googleapis.com/auth/drive`, and **`drive.file` was not verified** — it grants
an app the files *it* created, and the user's deck is not one of them, so it is very likely
insufficient for commenting on a deck the user made. Treat `drive` as required for this channel
until someone measures otherwise. `presentations` is needed for the 1-based slide number (and
for `insertComment`, if anchored writes are added).

## Invariants this channel honours

- **Nothing is written to a thread but a reply.** The user's comment is never edited, never
  re-anchored, never deleted by the server.
- **Text is reported verbatim.** No stripping, no normalising, no rewriting.
- **An unreadable anchor is reported, not hidden.** `anchorRaw` always carries what Google
  stored, next to our reading of it.
- **A timeout is a value.** So is an unknown comment id, and so is an unreadable deck (slide
  numbers go `null`, with a note; the read still succeeds).
- **`resolved` is observed, never assumed** — the thread is re-read after the write.
- **The e2e leaves the deck exactly as it found it**, deleting only comments tagged with its
  own run id, verifying counts before and after, and checking each delete individually.

## Limitations, measured not guessed

1. **The agent cannot anchor its own comments through Drive.** Google treats Drive-API
   comments as unanchored, by design. Replies into an already-anchored thread inherit its
   anchor, so the *reply* path is unaffected — only a brand-new agent-authored comment would
   need `presentations.batchUpdate` / `insertComment`.
2. **`drive.file` is unverified** for this channel (see Scopes).
3. **Editing an existing comment's text does not register as new activity.** Posts are dated
   by creation time, which is the price of not re-firing a thread every time it gets a reply.
   A *new* comment or reply always fires.
4. **HTTP/per-user mode is not wired.** `http/user-drive.ts` hands out a `DriveChannel` and
   keeps the caller's `OAuth2Client` private, so the comment channel has no way to act as the
   calling user. `unbrokeredFeedbackEnvironmentResolver` declines with the exact change that
   would enable it, rather than silently falling back to the developer token and writing into
   one person's Drive on every caller's behalf. `--stdio` has the channel today.
5. **No `create_feedback` tool.** The agent answers; it does not open threads. Add one with
   `insertComment` if that changes.
6. **The Slides UI was not observed directly** (no browser was used for this work). The anchor
   strings above were written by Google's own Slides backend via `insertComment` and read back
   off Drive, which is the same store the UI reads and writes; a comment typed by hand in the
   UI was not separately captured.

# The connector teaches its own client

A user who adds this connector should not also have to install a skill or type a long prompt.
Three mechanisms could carry the workflow to the model; all three were **measured against real
Claude Code 2.1.285** (`e2e/connector-guidance-probe.ts`, which drives a real `claude -p` with
`--mcp-config --strict-mcp-config` and captures every JSON-RPC frame through
`server.ts --frame-log`). Two of them work and are implemented.

| mechanism | verdict in Claude Code 2.1.285 | carried by |
|---|---|---|
| `instructions` in the `initialize` result | **works** — requested, kept, acted on; the only carrier that is always in context | `workflow-instructions.ts` |
| `prompts` capability (`prompts/list` + `prompts/get`) | **works** — surfaced as `/mcp__sasha-slides__<name>`, and the template is submitted as the user's turn | `workflow-prompts.ts` |
| tool descriptions | **does NOT reach the model by default** — tools are *deferred*: names only, schemas on demand | each `registerTool` |

### Tool descriptions are not a carrier here

This was expected to be the boring, always-true option and it is not. Asked what it had for
the sasha-slides tools, the client answered by quoting its own system reminder: *"The following
deferred tools are now available via ToolSearch. Their schemas are NOT loaded"* — it had the
eight tool **names** and "general MCP server instructions for sasha-slides", and said it would
have to call `ToolSearch` to see any description or input schema. It could enumerate all eight
tools and could not restate what one of their descriptions says.

So a tool description is read when the model has already decided to reach for that tool, not
before. It cannot carry policy that has to apply *before* the first call — which is exactly
what "never read a candidate back" is. `instructions` is the only guaranteed channel.

## `instructions` IS the skill file

The string returned in `initialize` is **`.claude/skills/sasha-slides/SKILL.md` minus its YAML
frontmatter** — not a second copy, not a paraphrase. One source of truth, one place to edit, so
the local skill and the connector cannot say different things. The file is read **at startup**
(there is no build step for the server: `npx tsx server.ts` runs the sources), once per
process, and `--skill-file <path>` relocates it.

If it cannot be read the server **still starts** and serves `FALLBACK_WORKFLOW_INSTRUCTIONS`, a
terse statement of the invariants only — the user who installed only the connector is the whole
point of the feature, so a missing file degrades rather than crashing or shipping an empty
string. The startup banner always says which of the two it served and from where.

## The client keeps only 2048 characters of `instructions`

**Measured, documented nowhere.** The probe served a synthetic skill whose every line is
exactly 16 characters (`L0001 ---------\n`, …) and asked the client which line was the last it
could see. The answer was `L0128` — line 128 ends at byte 2048 exactly — followed by a literal
`… [truncated]` marker. The same cut was independently visible on the real skill, whose served
text stopped mid-word at offset 2048 (`"one proposal at a tim…"`).

Left to itself that silently threw away the whole second half of the skill — the 1-based rule,
the loop and the Never list all vanished while the connector looked healthy. So the server
**fits the budget itself**: `fitInstructions` drops whole `##` sections, lowest priority first
(`SECTION_PRIORITY`), and appends one line saying how many were omitted, so the model can tell
an abridged guide from a complete one. `--instructions-budget 0` serves the whole file for a
client with no such limit.

At today's skill (6518 characters of body) the 2048 budget keeps **the title block, The one rule
that matters, Candidates should differ…, Slides are 1-based and Never**, and omits *Get something
on screen fast*, *The loop*, *Before the first call*, *Harness* and *Connecting the connector*.
The fast-first-wave section not fitting is a real gap: closing it means making the kept sections
tighter **in the skill**, which is a content decision, not a code one.

## Prompts declare exactly ONE argument each

Also measured, by `--probe prompt-arguments` against `e2e/prompt-argument-probe-server.ts`
(prompts declaring one, two and no arguments, logging the raw `prompts/get` params): Claude Code
**splits the typed slash-command text on whitespace and binds the words positionally to the
declared arguments in declaration order, discarding the rest.**
`/mcp__argprobe__two_args our Q3 retention numbers` arrived as `{first:"our", second:"Q3"}`.

A second declared argument therefore does not merely fail to help, it *corrupts* the expansion —
`new_deck` with four arguments once produced *"Audience: Q3. Aim for retention slides. Insert
the picks into the existing deck numbers."* One argument each it is:

| prompt | argument | what it starts |
|---|---|---|
| `new_deck` | `request` (free text) | write candidates → `propose_slides` → `await_pick` → next wave |
| `revise_from_feedback` | `presentationId` | `read_feedback` → re-propose → `reply_feedback` / `resolve_feedback` → `await_feedback` |
| `second_wave` | `proposalId` | a new proposal briefed by the pick and the anomalies |

Nothing the user typed is lost from the model's view: the expanded turn carries
`<command-args>` with the raw text in full, then the `prompts/get` template. That is why one
argument is enough, and why `new_deck`'s template tells the agent to prefer the raw request
over its own first word.

## What a user sees after adding the connector

- eleven `mcp__sasha-slides__*` tools;
- three slash commands — `/mcp__sasha-slides__new_deck`, `/mcp__sasha-slides__revise_from_feedback`,
  `/mcp__sasha-slides__second_wave` — listed with their titles and their one argument;
- a system prompt that already states the file-path rule, the 1-based rule, the Never list and
  "four is a good default", with no skill installed.

# The session log, comments on candidates, and revisions

Supersedes the single `PICK`-at-the-end model for everything except insertion itself.

Everything in this section is re-proved against real Drive on every run of
`npx tsx mcp/sasha-slides/e2e/session-live.ts` — which stages, comments on a candidate,
answers, revises it in place, asserts the **file id is unchanged and the threads survived**,
resolves, has a *second* client append two events the way the add-on will, clears, replays the
log through that independent client, and leaves the inbox with exactly the folders it started
with. The unit side is `test/session-log.test.ts` (ordering and the unknown-kind rule) and
`test/candidate-feedback.test.ts` (comments addressed by `(proposalId, slideIndex)`).

## Events are one file each, never one appended file

```
<proposalId>/
  events/
    1791073110901-a1b2c3-slides-staged.json
    1791073119044-d4e5f6-comment-opened.json
    1791073126380-g7h8i9-slide-revised.json
```

**One file per event**, named `<epochMillis>-<6 base36>-<kind>.json`. Drive has no append, so a
single `events.jsonl` would mean read-modify-write from two writers that cannot see each other —
the server and the add-on — and the loser's event would vanish. One file per event makes a write
a create, which cannot clobber.

**Order by millisecond prefix, then suffix, then Drive file id.** Prefix-and-suffix is NOT a
total order: two writers who cannot see each other can mint the same pair, and Drive permits
duplicate names in a folder, so a comparator returning 0 there leaves the order to Drive's
listing — which differs per reader. The file id is the third key and makes the order total.

`kind` is one of `slides-staged`, `comment-opened`, `comment-answered`, `slide-revised`,
`comment-resolved`, `slides-cleared`, `slide-inserted`, `feedback-delivered`. Every event carries
`{ protocolVersion, at, kind, … }` and whatever that kind needs. **An unknown `kind` is rendered
as an opaque "something happened" line, never dropped** — a reader on an older build must not
silently show an incomplete history.

The event files are tagged `appProperties {sashaSlides: "event", proposalId, eventKind}` and the
`events/` folder `{sashaSlides: "events", proposalId}` — server-side tags only. Cross-component
discovery is by NAME, as everywhere else: `events` under the proposal folder, then its children.

### Ordering is total, in three keys

`<epochMillis>` first, then the suffix, then — when two writers who cannot see each other mint
the same `<millis>-<suffix>` (Drive permits duplicate names in a folder) — the **Drive file id**.
Without that third key the order of two same-named events would be whatever order Drive happened
to list them in, which is a different order for every reader. `compareSessionEvents` implements
all three and `test/session-log.test.ts` proves the result is the same for every permutation of
the same log.

The name carries the order, not the body: a writer whose clock disagrees with its own file name
cannot reshuffle the log for everybody else.

### The payload of each kind

`slides-staged` · written by the server, at the end of staging
```json
{ "protocolVersion": 1, "at": "…", "kind": "slides-staged", "proposalId": "p_…", "revision": 1,
  "count": 3, "slides": [{ "index": 1, "fileId": "1Xyz…", "name": "01.html", "label": "…" }] }
```

`comment-opened` · **written by the add-on**, read by the server
```json
{ "protocolVersion": 1, "at": "…", "kind": "comment-opened", "slideIndex": 2,
  "commentId": "AAABb…", "author": "Ante M", "text": "the chart lost its gridlines",
  "region": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2 }, "noteId": "user_k2h9" }
```
`commentId` is the Drive comment id **on `NN.html`** — the id `reply_feedback` takes. `region` is
fractional (0–1) against the 1280×720 slide, the one coordinate convention in this protocol, and
`null` for a note about the slide as a whole. A region whose numbers are not fractional is
**dropped** rather than pointed at the wrong place.

`comment-answered` / `comment-resolved` · written by the server, on reply / resolve
```json
{ "protocolVersion": 1, "at": "…", "kind": "comment-answered", "slideIndex": 2,
  "commentId": "AAABb…", "replyId": "AAABc…", "text": "redrawn with bigger labels" }
```

`slide-revised` · written by the server
```json
{ "protocolVersion": 1, "at": "…", "kind": "slide-revised", "slideIndex": 2,
  "fileId": "1Xyz…", "revision": 2, "answeredCommentIds": ["AAABb…"], "label": "…" }
```
`fileId` is the SAME id the slide had before — that is the claim the event exists to record.

`slides-cleared` · written by the server
```json
{ "protocolVersion": 1, "at": "…", "kind": "slides-cleared", "revision": 3,
  "clearedSlideIndices": [1, 3], "keptSlideIndices": [2], "reason": "starting over" }
```

`slide-inserted` · **written by the add-on**, read by the server
```json
{ "protocolVersion": 1, "at": "…", "kind": "slide-inserted", "slideIndex": 2,
  "presentationId": "1AbC…", "pageObjectId": "g2d1", "insertedObjectIds": ["g123abc"] }
```
This is what makes a candidate **not** disposable: `clear_slides` keeps every index named by a
`slide-inserted` event. An add-on that only writes `PICK` is still honoured — a `PICK` with
`picked` and a non-empty `insertedObjectIds` keeps that candidate too — but the event is the
contract going forward.

`feedback-delivered` · written by the server, the moment a comment is handed to a client
```json
{ "protocolVersion": 1, "at": "…", "kind": "feedback-delivered",
  "tool": "read_feedback", "commentIds": ["AAABb…", "AAABc…"] }
```
`commentIds` are the Drive comment ids on the candidates' own `NN.html` — the same ids
`read_feedback` reports and `reply_feedback` takes — so the add-on matches a receipt to a comment
by id and never by slide. `tool` is `read_feedback` or `await_feedback`, for diagnosis only; both
mean the same thing to a reader.

**It is never empty.** A read that returned no threads and a wait that timed out write no event at
all: a receipt for an empty read would make an idle agent's polling look like contact, which is a
worse lie than the spinner this mechanism replaces. A receipt whose `commentIds` is missing or
empty is therefore read as an **opaque** event, not as a delivery — it cannot say *which* comment
reached anybody, so it may not be read as proof that any one of them did.

**One per hand-over, not one per comment, and duplicates are expected.** An agent that calls
`read_feedback` twice on the same open thread writes two receipts naming it, because the append
path deliberately never reads the log first — that is what makes two blind writers safe
(see "Events are one file each"). A reader therefore takes the NEWEST receipt naming a comment and
ignores the rest. The normal loop (`read_feedback` once, then `await_feedback`, which receipts only
on arrival) writes few.

It is also the one event that is purely observational: it changes no candidate, belongs to no
single slide, and is written **only** by the server. An add-on that minted one would be telling
itself that somebody is listening, which is exactly the claim the receipt exists to ground in
evidence. See the final section for how the interface reads it.

### Reading the log is a folder listing, not a manifest poll

`manifest.revision` is the **candidate-set** signal: it moves when a candidate's bytes change or
the set changes, and nothing else. A new *event* does not bump it, and must not: the add-on
appends events too, so making an event bump the manifest would put both writers in a
read-modify-write on one file — exactly what one-file-per-event exists to avoid. So a reader
watching the conversation lists `events/` (cheap: names carry the order and the kind), and a
reader watching the candidates polls `manifest.revision`.

## Comments live on the CANDIDATE, not the deck

A comment is a native Drive comment on `NN.html`, the candidate's own file. Not on the
presentation: the point is to mark up a slide **before** it is inserted, so Sasha can revise it.
Resolution is Drive's own `resolved` flag, so "unresolved count for slide N" is a query over
that file's open comment threads and both surfaces read the same source.

Sasha answers by **replying to the thread**, and resolves by Drive's resolve action. The reply
is what the conversation renders as the answer, and an answered-and-resolved thread with a
revised slide beneath it is the completion signal.

**The slide a comment is about is the file it is on.** That is a fourth `SlideLocation` source,
`candidate-file`, and it is the only one that cannot be wrong: no anchor, no sentinel and no
`[slide:…]` marker is consulted, because none of them can contradict which file Drive returned
the comment from. A candidate comment therefore reports `pageObjectId: null` and
`slideNumber: <the candidate's index>`, and the Slides API is not called at all — a candidate is
one HTML document, not a deck with a page order. The anchor machinery is still live and still
measured, for the deck target (`e2e/feedback-live.ts`).

A comment this server or the add-on creates through Drive is **unanchored**, as before — but on a
candidate that costs nothing, which is a second reason comments belong here rather than on the
deck.

### The four comment tools, re-addressed

| tool | arguments | returns |
|---|---|---|
| `read_feedback` | `proposalId`, `slideIndex?`, `since?`, `includeResolved?` | the threads (each with its `slideNumber`), a `cursor`, and `unresolved` — **every** candidate's open-thread count, so the grid and the conversation cannot disagree |
| `reply_feedback` | `proposalId`, `slideIndex`, `commentId`, `text` | `replyId`, `createdTime`, `resolved`, `logged` |
| `resolve_feedback` | `proposalId`, `slideIndex`, `commentId`, `text?` | same shape; `resolved` is **read back**, not assumed |
| `await_feedback` | `proposalId`, `slideIndex`, `timeoutMs?`, `since?` | `status: "arrived" \| "timeout"`, the new `posts`, the next `cursor` |

`slideIndex` is **required** on `reply_feedback`, `resolve_feedback` and `await_feedback`, and
optional on `read_feedback` (omit it for the whole proposal). It is required rather than inferred
because a cursor is a watermark into ONE file's threads, and because a `commentId` addressed to
the wrong candidate must fail loudly — Drive 404s a `comments.get` whose file does not hold that
comment, so it does, as `unknown-comment`.

`unresolved[]` entries are `{ slideIndex, unresolved, unavailableReason, cursor }` and
`unresolved` is **`null`, never `0`**, when the count could not be read: a clear badge on a slide
the user has complained about is worse than no badge.

## A revision replaces the candidate in place

`NN.html` is overwritten with the new HTML and `slide-revised` is appended, carrying the slide
index and the comment ids it answers. The file id does not change, so the comment threads stay
attached to their slide across revisions — which is the whole reason to revise in place rather
than stage a new proposal.

`manifest.json` gains a `revision` integer, bumped on every change to the **candidate set**, and
is still written **after** the files it describes.

**`revision` is the candidate-set signal only. Events do NOT bump it, and the conversation does
NOT poll the manifest.** The add-on appends events too; if an event bumped `revision` the add-on
would have to write `manifest.json`, putting both writers back into exactly the read-modify-write
that one-file-per-event exists to prevent. So:

- poll `manifest.revision` for "have the candidates changed";
- poll by **listing the `events/` folder** for "has anything happened" — the names carry order
  and kind, so it is one cheap call and needs no file reads to detect new work.

```
revise_slide { proposalId, slideIndex, path, label?, answeredCommentIds? }
```

`path` is a **local file path**, never HTML in the argument: paths in, ids out, going in and
coming back. The write order is `NN.html` → the `slide-revised` event → `manifest.json`, and it
is asserted on the recorded call transcript rather than on the final state, because the order IS
the invariant. A failure between the steps returns `drive-failed` naming the `stage` it reached
(`locate` · `upload` · `event` · `manifest`) and leaves the manifest alone, so no reader has been
told to re-read a half-written proposal and calling it again simply redoes it.

An unreadable `manifest.json` **declines** the revision (`manifest-unusable`) rather than
inventing a revision number: a number a reader cannot trust is worse than no change at all.

## Clearing

`slides-cleared` plus deletion of the uninserted candidates. **Never silent** — a set that
vanishes without a line in the log is indistinguishable from a bug, and this protocol has
already shipped one "it just showed nothing" failure.

```
clear_slides   { proposalId, reason? }
session_events { proposalId }
```

`clear_slides` counts the candidates, deletes only the ones no `slide-inserted` event (or `PICK`)
names, **re-lists and compares**, and only then appends the event and bumps the manifest. A
mismatch between the plan and the re-count is returned as `verification-failed` carrying both
sets — a destructive loop without per-iteration verification over-deletes the day an assumption
is off by one. The log itself is never deleted: the history has to outlive the candidates.

`session_events` returns `{ status, revision, eventCount, events[], unreadable[], note }`, where
each event is `{ eventId, kind, at, summary, fields }`. `kind` is what the **writer** called it,
so an event from a newer build reports its own name with `summary` saying "something happened",
and `fields` carries the body as written so nothing is lost in translation. A proposal with no
`events/` folder is `status: "no-log"` — an unknown history, which is not the same claim as an
empty one. A file in `events/` that is not a readable event is named in `unreadable[]` and costs
the reader nothing else.

## What `READY` means now

Written last on the first staging, meaning the first wave completed. It is NOT a statement that
nothing more is coming — revisions and further waves arrive as manifest `revision` bumps with
their own events.

**And after `clear_slides` it is actively stale**: the folder still holds `READY` while
`manifest.count` may be 0. A reader must therefore trust `manifest.revision` and `manifest.count`,
never `READY`, for anything after the first wave. `READY` answers one question — "did the first
staging finish" — and nothing else.

## Insertion is discoverable from the log

`slide-inserted` is the contract for "this candidate is committed", and `clear_slides` keeps
anything so marked. A `PICK` carrying non-empty `insertedObjectIds` is honoured as a transitional
fallback so an add-on built against the older section does not get its inserted candidate
deleted out from under it.


# `feedback-delivered`: proof that something is listening

Appended by the server the moment `read_feedback` or `await_feedback` **hands a comment to a
client**. It carries the comment ids delivered and the time.

It exists to answer one question the add-on could not otherwise answer: *is anyone there?*
Sasha is not a service — it is a Claude session parked inside a blocking tool call — so with no
session attached a comment sits unanswered for ever. Previously the add-on could only count
elapsed seconds and disclaim, which reads as progress and is therefore worse than silence.

A delivery event is **not** an answer and must never be rendered as one. It means exactly:
a connected client has read this comment. The three states the interface must distinguish:

| state | condition | what the user sees |
|---|---|---|
| **delivered** | a `feedback-delivered` names this comment | Sasha has it; waiting on the answer |
| **waiting** | no delivery yet, under the threshold | the elapsed time, nothing promised |
| **nobody listening** | no delivery after **5 minutes** | the instructions below, not a spinner |

Five minutes is chosen against measured client behaviour: a long-poll survives **30 minutes**
idle over standard input and **5 minutes** over the web transport, so a connected Sasha reads a
comment well inside five minutes. Past it, the overwhelmingly likely cause is that nothing is
attached.

## When nothing is listening, say what to do

Print something the user can act on, not a diagnosis. It must name the proposal, and it must be
copyable verbatim:

> Nothing has picked this up in 5 minutes. Sasha runs inside a Claude session — start one and
> paste:
>
> `Use the sasha-slides connector: call await_feedback for proposal <proposalId> and answer my
> open comments.`
>
> If the connector is not attached yet:
> `claude mcp add sasha-slides -- npx tsx <repo>/mcp/sasha-slides/server.ts --stdio`

The threshold is one constant, shared by both surfaces: `FEEDBACK_DELIVERY_THRESHOLD_MS` in
`feedback-delivery.ts`, which the server reads as its `await_feedback` default
(`DEFAULT_FEEDBACK_TIMEOUT_MS`) and the add-on reads as this threshold. Not two fives — the
number is defensible *because* it is one poll of a connected client, so the two must stay the
same value by construction rather than by coincidence. `feedback-delivery.ts` depends on nothing
and is compiled by both projects' gates.

**Never show a spinner past it.** `waitIsLive` returns false as soon as any wait is unheard, and
the instruction above is drawn *above* the elapsed time and the precondition, not below them: an
instruction underneath two paragraphs of explanation is furniture.

**And a receipt is still not an answer.** `SashaPresence` gained a `delivered` arm because delivery
became knowable; it did not gain an arm that claims an answer is coming, and no sentence any of
these surfaces emits may imply one. The test that pins this is
`addon/src/waiting.test.ts`, "NO SENTENCE ANYWHERE PROMISES AN ANSWER".

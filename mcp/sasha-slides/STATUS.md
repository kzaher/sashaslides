# sasha-slides — status

Written at the end of an autonomous session. Everything marked "verified" was run by me and
the output checked; everything unverified is called out. Nothing is committed — the working
tree holds it all.

## It is deployed and it works

The add-on is installed in Google Slides and the whole loop runs there. Not a shim, not a
local host: the deployed HtmlService bundle, a real click on its button, `Code.gs` doing the
insert, and a **separate** `presentations.get` from another process confirming the result —
so the add-on is never the only witness to its own work.

```
ok  add-on menu present in the Slides menubar          (SashaSlides > Open the picker)
ok  picker sees an editable presentation
ok  candidate HTML pane loaded
ok  pressed Insert                                     sidebar: "inserting into the deck..."
ok  1 new slide in the deck                            sasha_vlf8kma1pgrq
    7 elements -> RECTANGLE, TEXT_BOX, RECTANGLE, TEXT_BOX, TEXT_BOX, TEXT_BOX, TEXT_BOX
ok  all 7 elements are NATIVE and editable             (no flattened image)
ok  PICK written back to Drive                         with fractional anomaly regions
ok  render/01.png written                              141,442 bytes
```

Script project `1GqibbX21wU_8SMuFAC8nWStv6Y8wfrBNfiK1nQnbiawQXuABRNgr9NFo`, bound to deck
<https://docs.google.com/presentation/d/1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U/edit>.

Re-run it yourself: `npx tsx mcp/sasha-slides/e2e/addon-insert.ts --option 1`.

## If the picker errors

**`sashaHello: We're sorry, a server error occurred while reading from storage. Error code
PERMISSION_DENIED.`**

This is Apps Script's own host error — Google declining to *run* the function, not our code
failing. Checked and ruled out: the deck is owned by `ante.materija@gmail.com` and has exactly
one permission entry (no sharing), the same account works from the container's browser, and
the add-on was verified healthy minutes either side of the report. What remains is the
canonical cause of this exact string: **more than one Google account signed into the browser**,
so the add-on iframe is served under a `/u/<n>/` path whose profile cannot read the script.

In order of effort:

1. Hard-reload the presentation tab first — a tab opened before the deploy can hold stale state.
2. Open it in an **Incognito window**, signed in only as the owning account.
3. Force the account in the URL:
   `https://docs.google.com/presentation/d/1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U/edit?authuser=ante.materija@gmail.com`
4. Or sign out of every Google account and sign back in with that one first, so it is `/u/0/`.

If all four fail, it is something else and the next thing to capture is the deck URL as the
browser shows it (specifically whether it contains `/u/1/` or higher) and whether the account
is a personal or Workspace one.

The picker no longer shows Google's raw string: `explainHostFailure` (tested, in `bridge.ts`)
maps the known host failures — storage/PERMISSION_DENIED, missing authorization, stale
`Code.gs`, disabled API — to an instruction, keeping the original text in parentheses.

## What it does

You ask Claude for slides. Claude writes N candidate designs as self-contained 1280x720 HTML
and hands the MCP server their **file paths** — the HTML never enters the model's context.
The server stages them to a per-proposal folder in your Google Drive and writes a `READY`
sentinel **last**. The picker inside Slides shows the candidates 1..N, lets you compare the
authoritative HTML against the converted slide, and lets you drag a box over anything the
conversion got wrong. Pick one and it lands as native, editable Slides elements.

## The deployment problem, and the way round it

Two Cloud projects matter and they are not the same one:

| | project | symptom |
|---|---|---|
| your OAuth client | `982862611156` | `script.googleapis.com` 403 `SERVICE_DISABLED` |
| the script's own auto-created project | `342987503423` | `slides.googleapis.com` 403, from inside `Code.gs` |

Both are fixed from the Cloud console, and **the console is unreachable for this account**:
every URL redirects to `console.cloud.google.com/enable-mfa` — *"Google Cloud access blocked.
Effective May 13, 2025, Google Cloud has begun to enforce 2-step verification."* I did not
touch your account security settings, so I routed around it instead:

- **Deploy without the Apps Script API** — Slides > Extensions > Apps Script creates a
  container-bound project needing no API and no console. `addon/deploy-via-ide.ts` drives that
  editor over CDP, setting file contents through `window.monaco` (`model.setValue`) because
  424 KB cannot be typed through key events.
- **Call Slides without the Slides REST API** — `Code.gs` now uses the **advanced service**
  (`Slides.Presentations.batchUpdate`, `Slides.Presentations.Pages.getThumbnail`) instead of
  `UrlFetchApp` to `slides.googleapis.com`. Apps Script proxies advanced services under its
  own project, so no console is involved. This is what `appsscript.json`'s
  `enabledAdvancedServices` was always for.

Also tested and rejected: the granted `service.management` scope cannot enable an API
(`GetService` -> `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `:enable` -> missing
`serviceusage.services.enable`). Only `cloud-platform` would, and 2-Step Verification would
still block the console afterwards — so taking that broad scope would have bought nothing.

### Correction: far less is actually blocked than this document first claimed

An earlier version of this file said everything hinged on turning on 2-Step Verification. That
was overstated. Three things were measured afterwards:

- **The account-level "Google Apps Script API" toggle is already ON**
  (`script.google.com/home/usersettings`, read from the live browser). That gate is satisfied.
- **`clasp` authenticates as its OWN Google application**
  (`1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0`), not our project `982862611156`, so the
  disabled Apps Script API never applied to it. Its login does request
  `https://www.googleapis.com/auth/cloud-platform` — full Google Cloud control — among nine
  scopes, so the login was **stopped before consenting** and no `~/.clasprc.json` was written.
  We do not need it: the editor-driving deploy already works.
- **Google accepts the broker's loopback redirect with no registration.** Navigating the
  broker's real authorize URL reached a normal account chooser ("Choose an account to continue
  to Sasha Slides"), not `redirect_uri_mismatch` — Google ignores the port for a desktop
  client on `127.0.0.1`.

So **nothing in the current build requires the Cloud console.** 2-Step Verification matters
only for DISTRIBUTION: publishing a real installable add-on instead of one bound to a single
deck, and hosting the server remotely over HTTPS with a Web OAuth client.

## Three real bugs the live test found

None could be caught without running inside Apps Script. All three are fixed, with regression
tests where a test can express them.

1. **Insert was disabled on a perfectly editable deck** —
   `SlidesApp.getActivePresentation().getUrl()` returns the **legacy Drive form**
   `https://docs.google.com/open?id=<id>`, not `/presentation/d/<id>/edit`, so
   `presentationIdOf` parsed `null`. Now accepts both shapes (and a `/u/<n>/` segment), host
   and scheme still pinned. 4 new assertions in `protocol.test.ts`.
2. **…and it would still have been null**, because `announcer.proposal` read
   `services?.presentationId`, a mutable binding assigned after the announcer can fire. The id
   is now captured in a `const` closed over directly. Both fixes were required; fixing either
   alone left the gate shut.
3. **`sashaInsert` 403'd** against `slides.googleapis.com` — the advanced-service switch above.

`Code.gs` 9,160 B · `Sidebar.html` 424,582 B · `appsscript.json` 4 scopes.

## The comment round trip, driven in a real browser (2026-10-04)

The question was whether a user can mark up a candidate, a Claude session can answer it, and
the answer gets back to the screen. It was driven end to end three times against the deployed
add-on, with a real Model Context Protocol client (`e2e/sasha-listener.ts`) parked in
`await_feedback` over `--stdio`:

| | sent from the UI | arrived at the session | answered |
|---|---|---|---|
| round 1 | 20:47:33 | 20:47:41 | 20:47:45 |
| round 2 | 20:56:4x | 20:56:52 | 20:56:56 |
| round 3 | 21:05:2x | 21:05:36 | 21:05:40 |

Roughly **8 s from a box drawn on a slide to a Claude session reading it, and 4 s more to the
answer landing in Drive.** `revise_slide` replaced candidate 2 in place (revision 2, same file
id, comment threads intact) and the new slide renders inline in the conversation at the point
in the log where it happened. Screenshots: `e2e-0*.png` in the session scratchpad.

It found five defects. Each has a regression test written BEFORE the fix.

1. **The long poll was unusable past 60 s.** `await_feedback` with a 420 s budget died with
   `McpError -32001  data: { timeout: 60000 }`: the server sent no `notifications/progress`,
   and a client's request timer only resets on one. `long-poll-progress.ts` now reports every
   poll from both `await_feedback` and `await_pick`; measured surviving 493 s. A client must
   also ask (`onprogress` + `resetTimeoutOnProgress: true` — it defaults to FALSE).
2. **A comment on a candidate never reached the conversation.** `Conversation.tsx` built its
   entries from the DECK's comment pane alone, while the thing the user actually marks up
   lives in `conversation.comments` — which was read for the unresolved counts and nothing
   else. So the question and Sasha's answer were both invisible.
3. **The conversation froze after its first read.** `needs*` answered "no" for every state but
   `unrequested`, and `markStale` dispatched `*-requested` (which means "a read is IN FLIGHT")
   without running any loader — so the panel parked on the word "refreshing" and never read
   Drive again. Two more comments, two answers and a revision all landed and none appeared.
4. **Protocol leaked into prose, in both directions.** The user read the literal
   `[sasha-slides-agent]` under every answer; the model was handed
   `sasha-slides-feedback={"protocolVersion":1,…}` glued to the user's words and quoted it
   back. Both are parsed into fields (`authoredByAgent`, `region`/`noteId`) and are now off
   the text: `agent-marker.ts` and `readableFeedbackText`.
5. **Every comment rendered twice** once (2) was fixed, because the connector appends
   `comment-opened`/`comment-answered` receipts for the same posts. The thread wins — it is
   the live object and knows whether the comment is still open — and a receipt whose comment
   no thread carries is still history.

## The interface pass of 2026-10-04 (second round)

Five things the user reported after using it, each with a regression test written before the fix.

1. **Converter findings were mixed in with the user's own annotations.** The converter's
   `unsupported` list was seeded straight into `frame.anomalies` -- the list the slides window
   renders as the user's mark-ups -- so a four-candidate proposal opened with thirteen
   "CONVERTER" rows nobody wrote, each with its own note box and Send button. They are now
   derived on read (`converterFindingsOf`): still sent with the PICK, still drawn on the slide,
   never a row. The list holds only what the user drew.
2. **A mark-up was a one-line `<input>`.** It is a `<textarea>` now: Enter inserts a newline,
   Ctrl/Command + Enter sends, and the value survives the reducer with its newlines intact.
3. **Both conversations now look like Google comments.** `comment-card.tsx` is the shape read
   off a real Slides comment card the user sent: a 28 px round avatar with one initial, the
   author in 500 weight, "12:08 AM Today" under it, and the body at the card's own left edge.
   Used by the Ask Sasha log and by the slides window's mark-ups, so the product sits next to
   Google's own comment pane without looking like a different one.
4. **"4 things waiting for Sasha -- nothing has read the oldest for 4 h 39 min" with no remedy
   on screen.** The remedy WAS rendered -- inside the pinned panel, below the log, below the
   headline and the waiting list, which in a 300 px sidebar put it under the fold. It now leads,
   above the log: this is the one situation where waiting longer cannot help.
5. **The pasted instruction named an opaque `p_1791145806407_yig6ws`.** See below.

Plus one regression the live run caught: making every finished read re-readable (which is what
unfroze the conversation) had the sidebar asking Drive for four candidates every 8 s, and Apps
Script serialises one user's calls -- so the slides window's own read queued behind it and died
("sashaCandidateComments did not answer within 25000 ms"). The comments read now has its own
30 s staleness window; the one-call reads stay on the poll's cadence.

## The identifier: why the user never types one

The user asked why an opaque proposal id was in a sentence written for a person, and whether the
PRESENTATION could be the identifier instead. Researched, and the answer is neither:

* **The deck cannot be the key.** Comments were deliberately moved off the presentation and onto
  the candidate `NN.html` files (`proposal.ts`), `manifest.presentationId` is optional and in
  practice null, and the brokered `drive.file` scope cannot read a deck this connector did not
  create. A deck id would open nothing.
* **No identifier is needed at all.** `open_work` takes NO arguments and answers from the account
  the connector is authenticated as: every proposal that account has staged, what needs
  answering FIRST (an unanswered comment outranks being newer -- the newest proposal is usually
  the one already dealt with), then the newest. The id goes back to the MODEL. The notice now
  says: *Use the sasha-slides connector: call open_work, then answer my open comments.*
* **That is also how connectors authenticate by default.** Claude Code and claude.ai run OAuth 2.1
  with Proof Key for Code Exchange themselves: a `401` with `WWW-Authenticate` naming RFC 9728
  protected resource metadata, then RFC 8414 discovery, client registration, a browser consent,
  and a bearer token on every request. The user pastes a URL, never a token. This repo's `--http`
  mode already implements that server; it is blocked on a public HTTPS host and a Web OAuth
  client, not on design (see "Known gaps").

## Test suites, all run and checked

| suite | result |
|---|---|
| MCP server (OAuth broker + Drive protocol) | 37 / 37 |
| Picker add-on | 67 / 67 |
| Converter unit | 124 / 124 |
| Converter browser E2E | 10,197 / 10,197 |
| Skill E2E, fake Drive | 6 pass, 0 fail, 2 skip |
| **total** | **10,425 assertions** |

The skill's harness is also **proven to fail**: injecting `ready-early`, `drop-slide` or
`tamper-pick` each makes it exit non-zero. A harness that cannot fail says nothing when it
passes.

## Also verified against real Google

```
auth            drive · presentations · script.projects · script.deployments · service.management

product E2E     the user-visible loop with a google.script.run shim, 6/6 steps PASS
                host 1.55s · propose 11.61s · open 2.94s · picker 1.03s · pick 12.82s · verify 1.81s
                picker panes byte-identical to the staged files (sha1 checked)
                139 real batchUpdate requests

Drive staging   propose 10.40s · layout 4.21s · pick 2.54s · await 2.57s · cleanup 1.80s
                READY written last of 6 writes — checked by an INDEPENDENT Drive client
                images SKIP, correctly: rendering is client-side

conversion      all 15 request types ACCEPTED by presentations.batchUpdate
                geometry lands within 0.02 px (150 EMU)
```

## The number that mattered most

The converter's text inset was a guess (PowerPoint defaults). Measured against real Slides it
is **85,725 EMU — 9 CSS px — on all four edges**, recovered as the intercept of a line through
6-7 font sizes across four runs, because glyph bearing scales with font size and the inset
does not.

| inset | dx | dy |
|---|---|---|
| old 0.1in / 0.05in | -0.7 px | **+4.1 px** |
| measured 9 px *(shipped)* | -0.1 px | -0.1 px |

Every text box was landing 4 px low.

## Conversion speed

| route | time |
|---|---|
| old: pptx -> Drive -> `File > Import slides` | ~20 s |
| **now: client-side -> `batchUpdate`** | **mean 17 ms, slowest 45 ms** |

## How to run it

```bash
# auth (already done; re-run only if the token is revoked)
npx tsx .auth/check-auth.ts --write                      # must print: OK  Google auth works.

# the live add-on, end to end
npx tsx mcp/sasha-slides/e2e/addon-live.ts               # picker renders in real Slides
npx tsx mcp/sasha-slides/e2e/addon-insert.ts --option 1  # pick -> native slide, verified

# stage a proposal for the picker to find
.agent/skills/sasha-slides/sasha-slides.sh e2e --drive real --only propose --keep

# rebuild + redeploy the add-on after editing src/
cd mcp/sasha-slides/addon && npx tsx build-addon.ts
npx tsx mcp/sasha-slides/addon/deploy-via-ide.ts --step code
npx tsx mcp/sasha-slides/addon/deploy-via-ide.ts --step sidebar

# the MCP server
npx tsx mcp/sasha-slides/server.ts --stdio                        # dev: single token
npx tsx mcp/sasha-slides/server.ts --http --public-url https://   # per-user brokered OAuth
```

Browser: noVNC `http://localhost:6080/vnc.html?autoconnect=true&resize=scale`, Chrome CDP on
**:9223** with profile `~/.chrome-sasha-profile`. The headless Chrome on :9222 is untouched.

## Known gaps, honestly

0. **The SLIDES WINDOW's open-comment badge is not live for changes it did not make.** The
   conversation is (see above), and so is the badge after the window re-opens. But
   `picker-state.ts`'s `needsComments` is one-shot, and the observer only re-announces a
   proposal on first load or when a viewer appears -- so nothing re-reads the counts while
   the window sits open. A comment the window SENT refreshes them (it dispatches the read
   itself); Sasha answering or RESOLVING one does not, so a badge can keep saying "1 open
   comment" after it closed. The sidebar's fix does not transfer: the dialog's `pump` runs
   after every dispatch, including a drag, so making `needsComments` unconditional would
   re-read Drive on every pointer move. It needs either a clock in `picker-state` or a
   per-poll hook on the observer, which is a decision, not a typo.

1. **This is a bound script, not a published add-on.** It lives in that one deck. Publishing
   to the Marketplace, or reusing it on another deck, is a separate step and is the one thing
   that genuinely needs the Cloud console — so it needs 2-Step Verification on the account
   first. Everything else works without it (see the correction above).
2. **The brokered OAuth path is verified up to the Google round-trip, and blocked there.**
   Smoke-tested live against a running `--http` server, not just unit tests:

   | check | result |
   |---|---|
   | RFC 9728 protected-resource metadata | serves `resource`, `authorization_servers`, scopes |
   | RFC 8414 AS metadata | `S256` only, DCR endpoint, `token_endpoint_auth_method: none` |
   | unauthenticated `POST /mcp` | **401** with `WWW-Authenticate: Bearer resource_metadata=...` |
   | RFC 7591 dynamic registration | issues a `client_id`, auto-adds `https://claude.ai/api/mcp/auth_callback` |
   | `/authorize` | **302** to `accounts.google.com/o/oauth2/v2/auth`, `access_type=offline`, `prompt=consent`, its OWN `state` (not the client's) |
   | `code_challenge_method=plain` | rejected -> `error=invalid_request` redirect |
   | missing `code_challenge` | rejected -> "PKCE is mandatory" |
   | unregistered `redirect_uri` | **400**, never redirected to |

   **The Google leg then ran for real** and got further than expected: consent completed in
   the live browser and our broker issued its own authorization code back to a loopback client
   standing in for Claude. The token exchange failed with
   `invalid_grant: the code was issued to another client` — **a bug in the test harness, not
   the server.** Several throwaway clients had been registered while probing and the token
   request omitted `client_id`, which a public client must send; the server correctly refused
   to honour a code bound to a different client. Re-running needs a fresh consent because the
   code is single-use.

   A real remote deployment still wants a **Web** OAuth client rather than the current Desktop
   one, since Claude only connects to a remote server over HTTPS; the loader already accepts
   either shape, so that part is a file swap.
3. **Table *cell* insets are unmeasured.** The 9 px figure is for `TEXT_BOX` shapes;
   `emit-table` does not use `textInsetEmu` at all, and Slides cell padding is a separate
   quantity.
4. ~~The picker renders blank when no proposal is staged.~~ **Fixed** — the sidebar now shows
   a "Waiting for slides" state explaining what it is watching for. The old overlay rendered
   nothing here deliberately (an idle overlay must not cover Slides' own UI); a sidebar owns
   its column, so the same `dormant` state had to behave differently.
5. **`deploy-via-ide.ts` depends on the Apps Script editor's DOM** — `window.monaco`, an
   `aria-label="Save project to Drive"` button, an "Add a service" dialog. Google can change
   any of that. It is a workaround for a blocked API, not a supported deployment path; once
   2-Step Verification is on, `clasp push` replaces it.
6. **Nothing is committed.** The only commits this session were the two nanobox ones you
   asked for.

## Decisions taken without asking

- **Apps Script add-on, not a Chrome extension.** `chrome.identity.getAuthToken` forces a
  second OAuth client, and `appProperties` and `drive.file` are both per-client, so the second
  client would silently see nothing. On Chrome 154 a `chrome.offscreen` document also does not
  get the extension API surface, which removed the extension's main advantage.
- **Discovery by folder/file name**, never by `appProperties`, for the same per-client reason.
- **I enabled the Slides advanced service** on the script project and **created the bound
  script** in your deck. Both are reversible from the Apps Script editor.
- **Kept the full `drive` scope** that was granted. A published connector should prefer
  `drive.file` (non-sensitive) to avoid restricted-scope verification; that is a later call.

## Landing pages

**Current set.** Four styles, one story, told as scroll-driven scenes with transitions. Each
gives the three directed pillars a beat in the animation AND a written section below it:
the collaborative loop that learns your taste; your tools, no lock-in (Slides / PowerPoint /
HTML, native objects); fully hermetic on-premise.

| style | link |
|---|---|
| black & white (Vignelli poster, ground/figure inversions, moire + grain) | <https://claude.ai/artifact/HLdPBf491X5bFHZMADxXhX> |
| doodle whiteboard (rough.js strokes drawing themselves; sketch resolves into a real slide) | <https://claude.ai/artifact/743ekr3896LJFjf4hfGFc5> |
| warm / calm (ivory paper, terracotta, drifting gradient mesh) | <https://claude.ai/artifact/1aUahx92hgSEWGRjoBp3px> |
| futuristic techno (wireframe horizon, HUD telemetry, sealed perimeter) | <https://claude.ai/artifact/VNbw7Jjyxir47MF7Tm53Sn> |

**IMPORTANT, unimplemented:** pillars 2 and 3 are product promise, not shipped behaviour.
Today there is Google Slides only — no PowerPoint export, no HTML export, no on-premise
packaging. The pages state them as capabilities because the owner directed that copy; this
file is where the truth lives.

No page uses a screencast: each hero is authored SVG/CSS/Canvas. A real recording is now
possible and would beat all of them, because the add-on works.

**Earlier round** (different brief, kept for reference): editorial
<https://claude.ai/artifact/EeBa21BjqDdG8Y5nQAR1xk>, bold/kinetic
<https://claude.ai/artifact/2PznPxuXZQFF4JP1ethAaV>, instrument-panel
<https://claude.ai/artifact/SdUHzDcFeT7S1nYaSxsZZg>, technical/dark
<https://claude.ai/artifact/JcaLvreweGDXe36GYWQB6u>.

All are private until shared.

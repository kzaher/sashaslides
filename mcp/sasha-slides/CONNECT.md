# Connecting Claude to Sasha Slides

Two halves have to be connected, and they are independent:

1. **The connector** — Claude talks to the Sasha Slides server, which stages candidate slides
   into your Google Drive.
2. **The picker** — an add-on inside Google Slides that shows you those candidates and puts the
   one you choose into your deck.

The picker is already installed in the test deck. This page is mostly about the connector.

## A. Connect Claude Code (works today)

From this repository:

```bash
claude mcp add sasha-slides -- npx tsx /workspaces/sashaslides/mcp/sasha-slides/server.ts --stdio
```

Check it attached:

```bash
claude mcp list
```

You should see `sasha-slides` and these eleven tools: `propose_slides`, `await_pick`,
`slide_images`, `proposal_state`, `read_feedback`, `reply_feedback`, `resolve_feedback`,
`await_feedback`, `revise_slide`, `clear_slides`, `session_events`.

`--stdio` uses the single Google account whose token is in `.auth/tokens.json`. That is the
right mode for one person on one machine. It is NOT safe to share, because everyone who
connects would get that one account's Drive.

## B. Connect claude.ai, or anyone who is not you (per-account sign-in)

This is the multi-user mode. The server becomes an OAuth 2.1 resource server: each person who
connects signs in with their OWN Google account, and the server only ever touches that
person's Drive.

```bash
npx tsx mcp/sasha-slides/server.ts --http --public-url https://<your-public-host> --port 7777
```

Then in claude.ai: **Settings → Connectors → Add custom connector**, and give it
`https://<your-public-host>/mcp`. Claude registers itself automatically, sends you to Google to
sign in, and from then on acts as you.

Claude Code can use the same remote server instead of the local one:

```bash
claude mcp add --transport http sasha-slides https://<your-public-host>/mcp
```

It will open a browser for you to sign in with Google the first time.

Requirements, measured not assumed:

- **It must be HTTPS and publicly reachable.** Claude will not connect to a remote server over
  plain HTTP. A tunnel in front of the local port is enough. The server prints a warning if you
  give it a non-HTTPS public URL.
- **No Google Cloud console work is needed for the sign-in itself.** Google ignores the port on
  a loopback redirect for a desktop OAuth client, which was verified by driving the real
  authorize URL and reaching a normal Google account chooser.
- A production deployment should use a **Web** OAuth client rather than the Desktop one, since
  the redirect will be an HTTPS address rather than loopback. The credential loader already
  accepts either shape, so it is a file swap.

## C. What to say to Claude once it is connected

**The connector teaches Claude the workflow itself — you do not have to.** On connecting, the
server hands the client the sasha-slides guide (`.claude/skills/sasha-slides/SKILL.md`, minus
its frontmatter) as the MCP `instructions` string, which Claude Code puts in its system prompt.
No skill to install, nothing long to type.

Three slash commands appear with it:

```
/mcp__sasha-slides__new_deck              our Q3 infrastructure spend, for the board
/mcp__sasha-slides__revise_from_feedback  <presentationId>
/mcp__sasha-slides__second_wave           <proposalId>
```

Or just ask in your own words — "make me some candidate slides about our Q3 infrastructure
spend" is enough, because the rules are already in front of the model.

Either way the slide HTML never enters Claude's context — paths go in, file ids come out. That
is what keeps it fast and what keeps your content out of the model's window.

While you are deciding, Claude is blocked on `await_pick`. When you pick one in the sidebar, it
returns your choice plus anything you marked as wrong.

## D. Use the picker

Open the deck, then **SashaSlides → Open the picker** in the menu bar.

The panel shows "Waiting for slides" for a few seconds while it first checks your Drive, then
lists the candidates. Toggle **HTML (authoritative)** against **Converted slide**, drag a box
over anything the conversion got wrong, and press **Insert option N**. It lands as real,
editable Slides objects.

## If it says a server error occurred while reading from storage

That is Google refusing to run the add-on, not a fault in the picker. The error panel now
prints a diagnostic line underneath it — read that first, it names the cause:

```
account slot 0 · visible · storage ok · 2026-10-04T12:34:56.789Z
```

**`account slot 1` (or higher) is the cause, confirmed in practice.** More than one Google
account is signed into the browser and the add-on is running as a non-default one. The bound
script belongs to the deck's owner, so a different slot cannot read it. Fixes, cheapest first:

1. Open the presentation with the account forced:
   `…/edit?authuser=<the owning address>`
2. Or sign out of the other Google accounts so the owner is the default and the address reads
   `/u/0/`.
3. Or use a separate browser profile that has only that account signed in.

Other values in that line:

- **`storage blocked`** — browser storage is unavailable in the sidebar frame. Different
  problem; tell whoever maintains this.
- **`account slot unknown`** — the panel is not being served from the expected host. Worth
  reporting verbatim; it is not a case anyone has seen yet.

**A second, unrelated cause** that produces the same message: someone re-saving the Apps
Script project while your sidebar is open. Every save invalidates the running instance. It is
transient — reload the presentation and it clears. If a deployment is in progress, wait.

Ruled out by testing, so do not chase these: **third-party cookie blocking** (the add-on works
with third-party cookies blocked — measured), and **Incognito** (which blocks third-party
cookies by default and so is not a useful diagnostic either way).

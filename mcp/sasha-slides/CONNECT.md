# Connecting Claude or ChatGPT to Sasha Slides

**Recorded walkthroughs** (claude.ai, ChatGPT, Claude Code), with every click: [docs/connect/](docs/connect/README.md).

Two halves have to be connected, and they are independent:

1. **The connector** — Claude (or ChatGPT) talks to the Sasha Slides server, which stages candidate slides
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

## B2. Connect ChatGPT (same remote server, same URL)

ChatGPT uses the very same remote server and the very same address as claude.ai:
`https://<your-public-host>/mcp`. Nothing extra has to run. Inside the add-on, the Setup tab's
**ChatGPT** choice prints these steps with the real address filled in.

**Plans, stated honestly.** OpenAI's help centre (article "Developer mode and MCP apps in
ChatGPT", <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>)
says full MCP, including write actions, is for **Business, Enterprise and Edu**, and that Pro can
connect MCP servers with read/fetch permissions only. Sasha's tools write to your Drive, so plan
on Business, Enterprise or Edu. In a workspace, the admin may first have to allow custom MCP
servers (developer mode) under the workspace settings. Free and Plus are not listed. That page
refuses automated fetches, so this paragraph comes from its search-indexed text, not a fresh read.
**Measured 2026-10-11 on a Plus account:** Plugins → Add → Add custom MCP server was available, the
OAuth sign-in completed and a read-only call (`open_work`) worked (video: `docs/connect/`). Write
tools on Plus were not tried.

Steps, every click (from OpenAI's "Add custom MCP server" guide,
<https://developers.openai.com/api/docs/guides/custom-mcp-server>, and "Connect and test your
plugin", <https://developers.openai.com/plugins/deploy/connect-chatgpt>):

1. Open ChatGPT **on the web** at <https://chatgpt.com/plugins>.
2. Press the **+** button, then **Add custom MCP server**.
3. **Name**: `Sasha Slides`. **Description**: optional.
4. Under **Connection**, leave it on the URL option (not **Tunnel**) and paste the **Server URL**:
   `https://<your-public-host>/mcp` — the `/mcp` path included, exactly what claude.ai gets.
5. Under **Authentication** choose **OAuth**. Leave any client ID and client secret fields empty:
   Sasha does not advertise Client ID Metadata Documents, so ChatGPT falls back to dynamic client
   registration and registers itself. If the form asks how ChatGPT should register, pick
   dynamic client registration (DCR); OpenAI's wording is "ChatGPT can also use DCR when
   configured".
6. Read the risk warning and press **I understand and want to continue**.
7. Press **Create as a plugin**. When ChatGPT sends you to Google, sign in with the Google account
   that owns the deck, then wait while ChatGPT lists the tools.
8. Open your personal plugins at <https://chatgpt.com/plugins?view=personal>, open **Sasha
   Slides**, and press **+** to install it.
9. Start a new chat (OpenAI's quickstart uses the **Work** tab at the top of the homepage when it
   is there), type `@`, choose **Sasha Slides**, and say what you want, for example
   "call open_work, then answer my open comments".
10. ChatGPT asks you to confirm every tool that is not marked read-only. Approve the Sasha
    actions; "remember for this conversation" saves repeating it.

After a server upgrade, refresh the tool list: <https://chatgpt.com/plugins> → open Sasha Slides
→ **Refresh**.

What the server does for ChatGPT, measured by `test/oauth.test.ts` (no live ChatGPT run has been
made from this repository):

- **Redirect URIs.** ChatGPT returns to `https://chatgpt.com/connector_platform_oauth_redirect`
  when the authorization server supports RFC 9207 issuer identification, and to a per-connection
  `https://chatgpt.com/connector/oauth/{callback_id}` otherwise
  (<https://developers.openai.com/apps-sdk/build/auth>, "Redirect URL"). Both arrive in ChatGPT's
  registration request and match exactly. The stable one is also added to every registration,
  next to Claude's `https://claude.ai/api/mcp/auth_callback`, so a connection that registered
  its per-connection URI keeps working when ChatGPT switches.
- **Issuer identification.** The metadata advertises
  `authorization_response_iss_parameter_supported: true`, and every redirect back to the client
  (code or error) carries `iss` equal to the metadata `issuer`. ChatGPT rejects a response with a
  missing or different `iss`.
- **PKCE S256, `resource`, refresh.** S256 is the only method; ChatGPT's `resource` parameter on
  `/authorize` and `/token` must equal the `/mcp` URL; `offline_access` is advertised in the
  authorization server's `scopes_supported` and a rotating refresh token is always issued.
- **No `search`/`fetch` tools needed.** OpenAI: "Custom MCP servers do not require
  `search`/`fetch` tools."

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

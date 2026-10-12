# Connecting Claude and ChatGPT to Sasha Slides

Every step and click below was checked live on 2026-10-11 against the real connector server, with
real Google sign-in. The production connector address is `https://sashaslides.com/mcp`.

| Client | Watch | Step script |
| --- | --- | --- |
| claude.ai (also Claude Desktop) | [sashaslides.com/videos/claude-ai.mp4](https://sashaslides.com/videos/claude-ai.mp4) | [recording/claude-ai.steps.txt](recording/claude-ai.steps.txt) |
| ChatGPT (Plus is enough) | [sashaslides.com/videos/chatgpt.mp4](https://sashaslides.com/videos/chatgpt.mp4) | [recording/chatgpt.steps.txt](recording/chatgpt.steps.txt) |
| Claude Code | (terminal; steps below) | — |

Walkthrough videos are not kept in the repository: they show a real account (email, chat history),
so they are recorded on demand with the script below and shared outside git.

## What goes where

| Where | Field | Value |
| --- | --- | --- |
| claude.ai: Customize → Connectors → + Add → Add custom connector | MCP server URL | `https://<host>/mcp` |
| ChatGPT: Plugins → Add → Add custom MCP server | Connection → Server URL | `https://<host>/mcp` |
| Claude Code terminal | — | `claude mcp add --transport http sasha-slides https://<host>/mcp` |
| Google Cloud → Credentials → your **Web** OAuth client | Authorized redirect URI | `https://<host>/oauth/google/callback` |

Neither claude.ai nor ChatGPT needs a client ID or secret: both detect the server's OAuth and
register themselves (dynamic client registration).

## claude.ai

1. In the left sidebar, click **Customize**.
2. Click the **Connectors** tab.
3. Top right, click **+ Add**, then **Add custom connector**.
4. **Name**: `Sasha Slides`. **MCP server URL**: `https://<host>/mcp`. Click **Continue**.
5. Leave the detected defaults (**Authentication: Sign in now**, **OAuth client: Register
   automatically**), scroll to the bottom and click **Add**.
6. Click **Connect**. The same tab goes to the Sasha Slides sign-in, which hands you to Google.
7. Google: choose your account → on "Google hasn't verified this app" click **Continue** → on
   "Sign in to Sasha Slides" click **Continue** → on the access screen click the round
   **down-arrow** to scroll to the end, then **Continue**.
8. Back in Claude the connector shows **Disconnect** and its 12 tools.
9. New chat → type `Use the sasha-slides connector: call open_work and tell me what is waiting for
   me.` → when Claude asks to use "What is waiting for me", click **Allow once**.

## ChatGPT

1. In the left sidebar, click **Plugins**.
2. Top right, click **Add**, then **Add custom MCP server**.
3. **Name**: `Sasha Slides`. **Description** (optional). **Connection**: keep **Server URL** and
   enter `https://<host>/mcp`. Leave **Authentication** on **OAuth**.
4. Tick **I understand and want to continue**, then click **Create as a plugin**.
5. On "Connect Sasha Slides" click **Continue to Sasha Slides**, and complete Google sign-in as
   above.
6. Sasha Slides now shows under **Installed**.
7. New chat → type `@Sasha`, pick **Sasha Slides** → type `call open_work and tell me what is
   waiting for me.` → Enter.

## Claude Code

1. `claude mcp add --transport http sasha-slides https://<host>/mcp`
2. Start `claude`, type `/mcp`, select **sasha-slides** (shows "needs authentication"), choose
   **1. Authenticate**.
3. Your browser opens the Sasha Slides sign-in; complete Google sign-in as above. The browser says
   "Authentication successful" and Claude Code says "Connected to sasha-slides".
4. Ask: `Call the sasha-slides open_work tool and list each proposal with its candidate count.`

For a single developer on one machine, the local server also works without any of this:
`claude mcp add sasha-slides -- npx tsx /workspaces/sashaslides/mcp/sasha-slides/server.ts --stdio`
(the add-on's Dev tab shows the same command).

## How the test deployment was run

```sh
cloudflared tunnel --url http://127.0.0.1:7779            # prints https://<random>.trycloudflare.com
SASHA_MASTER_KEY=<64 hex characters> npx tsx mcp/sasha-slides/server.ts --http --port 7779 \
  --public-url https://<random>.trycloudflare.com \
  --store <path>/oauth-store.json \
  --key-store <path>/oauth-keys.json \
  --google-callback-url http://127.0.0.1:7779/oauth/google/callback
```

`--store` needs `--key-store` and `SASHA_MASTER_KEY`: each user's Google tokens are sealed with
their own account key, kept wrapped under the master key in the key store. Generate the master key
with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

`--google-callback-url` is a testing aid: the current Google OAuth client is a Desktop client,
which only accepts loopback redirects, so Google's leg came back over `127.0.0.1`. That only works
for a browser on the server's own machine. A real deployment needs a **Web** OAuth client with
`https://<host>/oauth/google/callback` registered, and then no `--google-callback-url`.

## After "Reset my key and delete my data"

Deleting your data at sashaslides.com/account revokes Sasha Slides' Google access, so every
assistant has to sign in again (measured 2026-10-12):

- **claude.ai:** the next tool call says the connector needs you to sign in again; press Connect (in
  the chat or under Customize → Connectors) and sign in.
- **ChatGPT:** its Reconnect button does nothing. Open Plugins → Sasha Slides → Manage, press
  **Connect another account**, sign in, then open the old account's ⋯ menu and choose
  **Disconnect**, so only the new account is left.
- On Google's permissions page tick **Select all**. Leaving the boxes unticked now stops at a Sasha
  Slides page asking you to try again, instead of connecting without access to your slides.

The videos are published with `deploy/publish.sh videos`, which uploads `recording/recordings/*.mp4`
to the server; nginx serves them at `/videos/`.

## Recording walkthroughs

`recording/record.ts` captures the screen, captions each step from the step script, removes personal
details, and refuses to finish if any of them is still readable. Output goes to
`recording/recordings/`, which git ignores.

**Before you start**

1. Install the tools once: `sudo apt-get install -y ffmpeg tesseract-ocr`.
2. Start the recording display, VNC and Chrome: `bash mcp/sasha-slides/docs/connect/recording/display.sh`
   (1600x900 on `:99`; the wipe areas assume that size). Open `http://localhost:6080/vnc.html` and sign
   in to claude.ai or ChatGPT there.
3. Remove any existing Sasha Slides connector in that app, so the flow starts from scratch.

**Record**

```bash
R="npx tsx mcp/sasha-slides/docs/connect/recording/record.ts"
DISPLAY=:99 $R start claude-ai          # or: chatgpt
$R step claude-ai 0                     # caption step 0, then do it in the browser
$R step claude-ai 1                     # caption step 1, then do it … and so on, in order
$R finish claude-ai --url https://sashaslides.com/mcp \
   --redact "you@gmail.com,Your Name,yourusername"
```

- Run `step <n>` just before you perform step *n*; the caption stays until the next step.
- `--redact` lists every way the account appears on screen: the email, the display name, the
  ChatGPT username. Matching is case-insensitive and also catches the email without its dots.
- `finish` writes `recordings/<flow>.mp4` and `recordings/<flow>-steps.md` (the step script with
  times). It always wipes the left sidebar (chat history) and the account badge for the whole video,
  and ChatGPT's personalised suggestions on its home screen.
- If text recognition can still read any `--redact` word afterwards, `finish` deletes the video and
  names the second where it was seen. The unredacted capture is deleted after a successful finish.

**Check before sharing:** open the video and look at the Google sign-in pages yourself. Faint text
(light grey, mid-fade) is the case text recognition is most likely to miss.

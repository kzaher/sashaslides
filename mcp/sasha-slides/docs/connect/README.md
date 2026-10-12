# Connecting Claude and ChatGPT to Sasha Slides

Recorded live on 2026-10-11 against the real connector server, with real Google sign-in. Every
step and click is listed below and burned into each video as a caption.

The connector address in the recordings, `https://isbn-nail-pam-arab.trycloudflare.com/mcp`, was a
**temporary test tunnel**. Use the address of your own deployment wherever it appears
(`https://<host>/mcp`).

| Client | Video | Step list |
| --- | --- | --- |
| claude.ai (also Claude Desktop) | [connect-claude-ai.mp4](connect-claude-ai.mp4) | [connect-claude-ai-steps.md](connect-claude-ai-steps.md) |
| ChatGPT (Plus is enough) | [connect-chatgpt.mp4](connect-chatgpt.mp4) | [connect-chatgpt-steps.md](connect-chatgpt-steps.md) |
| Claude Code | (terminal; steps below) | below |

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

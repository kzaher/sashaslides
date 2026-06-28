# Sasha Slides ↔ Claude bridge

A thin local bridge that lets Claude (via a skill) drive a live slide display.
Claude → Python wrapper → local server → **WebSocket (default)** or **WebRTC
(backup)** → the display HTML running in a browser (same machine, or a
phone/projector on the same network).

```
Claude skill ──(localhost HTTP)──▶ bridge server ──┬─ default: ws://localhost/ws   (same machine / LAN-scanned)
                                                   └─ backup:  WebRTC datachannel  (manual copy-paste pairing)
```

## Install (one line, self-contained)

```bash
curl -fsSL https://<your-sashaslides-host>/install.sh | sh
```

Asks where to install, builds a **private `.venv`** (nothing is installed
globally or to `--user`), installs the skill into Claude Code or Codex
(auto-detected, else it asks), and starts the bridge. The installer is served by
the add-on server with its own origin baked in (`server.ts` → `/install.sh`).

## Quick start from a checkout

```bash
./run.sh                  # creates ./.venv, installs into it, starts the bridge
SASHA_VENV=/path ./run.sh # choose the venv location non-interactively
```

`run.sh` never touches system/global Python. Windows: `run.bat`.

Open the integration page <http://localhost:8787/> → **Automatic** tab → "Open
display on this computer". The display connects over `ws://localhost` instantly,
no handshake. Then drive it:

```bash
python wrapper.py add          --html-file slide1.html
python wrapper.py replace      --html-file slide1b.html      # replaces the CURRENT slide
python wrapper.py replace      --index 0 --html-file x.html  # replaces a specific slide
python wrapper.py screenshot   --out shot.png                # PNG of the current slide
python wrapper.py edit-diagram --index 0 --xml-file d.xml    # set/render a drawio diagram
python wrapper.py edit-diagram --index 0 --interactive       # open the editor, wait for Save
python wrapper.py state
```

Pass a non-default port to any subcommand with `--port` (e.g. `serve --port 8799`).

## Running in Docker (WebRTC needs a pinned, published UDP port)

aiortc/aioice give no way to fix the ICE UDP port, and inside a container it
advertises the container's unreachable internal IP — so pairing stalls at
"connecting…". Pin the port, publish it, and tell the bridge what address the
browser should dial:

```bash
docker run --rm --name sasha-slides-bridge \
  -p 8787:8787 -p 50000:50000/udp \
  -e SASHA_RTC_PORT=50000 -e SASHA_RTC_HOST_IP=127.0.0.1 \
  -e SASHA_DIR=/opt -e SASHA_SKILL=skip \
  python:3.14 bash -c "curl -fsSL <host>/install.sh | sh"
```

`SASHA_DIR` + `SASHA_SKILL` make the installer fully non-interactive (no `-it`, no
prompts — `yes ''` does NOT work because the installer reads prompts from
`/dev/tty`, not stdin). `SASHA_SKILL=skip` because the skill goes on your **host**
(for Claude/Codex), not in the bridge container. Avoid `./run.sh` in a bind mount —
it often loses its exec bit / gains CRLF line endings.

### Docker Desktop (Mac/Windows): use TURN, not `-p …/udp`

Docker Desktop forwards TCP reliably but **UDP poorly**, so the forced-port WebRTC
above stalls at "connecting…". Run a coturn relay in the same container instead —
both peers reach it over reliable transports (browser via published TCP, aiortc via
localhost), so no UDP forwarding is needed:

```bash
docker run --rm --name sasha-slides-bridge \
  -p 8787:8787 -p 3478:3478/tcp \
  -e SASHA_TURN=1 -e SASHA_DIR=/opt \
  python:3.14 bash -c "apt-get update -qq && apt-get install -y -qq coturn && curl -fsSL <host>/install.sh | sh"
```

Then in the sidebar tick **Relay through TURN**. Env vars: `SASHA_TURN=1` (on),
`SASHA_TURN_PORT` (3478), `SASHA_TURN_USER`/`SASHA_TURN_PASS` (`sasha`/`sasha-bridge`
— must match the sidebar). Only `:3478/tcp` needs publishing; the relay ports stay
inside the container. **Simplest of all on one machine: just use Local device.**

- `SASHA_RTC_PORT` — the bridge pins aiortc's ICE UDP socket to this port.
- `-p <port>:<port>/udp` — **must** publish it as UDP.
- `SASHA_RTC_HOST_IP` — the bridge rewrites its advertised host candidate to this
  (`127.0.0.1` for a same-machine browser; the host's LAN IP if the browser is on
  another machine).

Verified end-to-end through a Docker-style UDP forward (ICE `checking → completed`,
connection `connected`). `--network host` also works but **Linux only** — not on
Docker Desktop for Mac/Windows, where the pinned-port approach above is the fix.

## Phone / projector on the same network

Integration page → **Automatic** tab → scan the QR. The phone opens
`http://<lan-ip>:8787/display` and auto-connects over the LAN (still just a
WebSocket — no copy-paste).

## Different network (no route to this machine) → Manual tab

Pure copy-paste WebRTC, exactly two blobs:

1. On the display device, open "Pair manually", copy its **offer**.
2. Integration page → **Manual** tab → paste the offer → **Generate answer**.
3. Copy the **answer** back into the display device → Connect.

Each side bundles its ICE candidates into the SDP (non-trickle), so no further
exchange is needed once the two blobs are swapped.

## Command protocol (server ⇄ display, over either transport)

| op               | fields                       | reply                          |
|------------------|------------------------------|--------------------------------|
| `add_slide`      | `html`, `index?`             | `{index, count}`               |
| `replace_slide`  | `html`, `index?` (def: current) | `{index, count}`            |
| `goto`           | `index`                      | `{index}`                      |
| `get_state`      | —                            | `{count, current, slides[]}`   |
| `get_slide_html` | `index?` (def: current)      | `{index, html}`                |
| `screenshot`     | `index?` (def: current)      | `{png: "data:image/png;..."}`  |
| `edit_diagram`   | `index?`, `xml?`, `autosave?`| `{index, xml}`                 |

## How rendering / screenshots / diagrams work

- **Slide rendering**: slides are full **1280×720 HTML documents** loaded into a
  sandboxed iframe via `srcdoc` — exactly what the `html2slides` renderer
  consumes (`renderer/html2slides/browser/convert-core.ts:loadIntoIframe`). So
  what the display shows == what the converter produces.
- **Screenshot**: rendered **server-side via CDP** (`Page.captureScreenshot`,
  the project's `shot-originals.ts` recipe) by fetching the slide HTML from the
  display and rasterizing it in a throwaway tab. This needs a headless Chrome
  reachable at `SASHA_CHROME_CDP` (default `http://127.0.0.1:9222`):
  ```bash
  google-chrome --headless=new --remote-debugging-port=9222 --no-sandbox \
    --user-data-dir=/tmp/chrome-cdp about:blank
  ```
  Why server-side: Chromium taints a canvas drawn from an SVG/foreignObject, so
  pure in-browser `toDataURL` can't export it. If no Chrome is reachable, the
  server falls back to the display's in-browser capture (works in Firefox).
- **`edit_diagram`**: round-trips drawio XML through the **vendored editor's**
  JSON embed protocol (`/drawio/?embed=1&proto=json`) — no Google/Apps Script.
  `autosave` exports immediately (non-interactive); otherwise the user edits and
  clicks *Save & Close*. The result is written back into the slide as a paired
  `<img>` + `<script type="application/vnd.drawio+xml" id="drawio-source">`
  (same contract as `extract-dom.ts`). **Requires** the bridge to run from the
  repo so `/drawio/*` can be served from `deps/drawio` (override with
  `SASHA_DRAWIO_DIR`); absent in the standalone zip, where it returns a 404/error.
- Same-LAN WebRTC needs no STUN/TURN. The WebRTC path includes a public STUN
  server so it still works across subnets; cross-internet would also need TURN.

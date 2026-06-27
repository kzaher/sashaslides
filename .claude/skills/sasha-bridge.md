---
name: sasha-bridge
description: Drive a live SashaSlides deck — add, replace, goto, and screenshot slides (and edit drawio diagrams) by sending commands through the local bridge server. Use when the user wants to build or edit slides on a connected display/deck in real time.
user_invocable: true
---

# sasha-bridge

Drive a live Sasha Slides display (browser on this machine, or a phone/projector
on the same network) by sending slide commands through the local bridge server.

Use this skill when the user wants to build or edit slides on a connected
display in real time — add a slide, replace the current slide, screenshot a
slide, or read deck state.

## Prerequisites

The bridge server must be running and a display must be connected. Check with:

```bash
.claude/skills/sasha-bridge.sh state
```

If it reports `bridge not reachable`, tell the user to run `python wrapper.py
serve` from the unzipped `sasha-bridge` folder and open the display from the
integration page (<http://localhost:8787/>). If it reports `no display
connected`, the server is up but no browser display is paired yet.

## Commands

The skill forwards to `bridge/wrapper.py`. Write slide HTML to a temp file and
pass it with `--html-file` (slides are self-contained HTML at 1280×720).

```bash
.claude/skills/sasha-bridge.sh add          --html-file /tmp/slide.html      # append + show
.claude/skills/sasha-bridge.sh add          --html-file /tmp/s.html --index 2 # insert at 2
.claude/skills/sasha-bridge.sh replace      --html-file /tmp/slide.html       # replace CURRENT slide
.claude/skills/sasha-bridge.sh replace      --index 0 --html-file /tmp/s.html # replace slide 0
.claude/skills/sasha-bridge.sh goto         --index 3
.claude/skills/sasha-bridge.sh screenshot   --out-dir /tmp/shots              # current slide
.claude/skills/sasha-bridge.sh screenshot   --range 1-5 --out-dir /tmp/shots  # a range
.claude/skills/sasha-bridge.sh screenshot   --indices 1,3 --xml --out-dir /tmp/shots
.claude/skills/sasha-bridge.sh edit-diagram --index 0 --xml-file /tmp/d.xml --out-xml /tmp/d.xml
.claude/skills/sasha-bridge.sh state
```

Slides are full self-contained 1280×720 HTML documents (own `<head><style>`,
`body{width:1280px;height:720px}`) — not fragments.

Every command prints a JSON result with `ok: true/false`. After `screenshot`,
read the saved PNG(s) to verify what the deck looks like before continuing.

`state` returns `{count, current, skipped:[...]}` — total slides, the current
(1-based) slide, and the 1-based indices of skipped (hidden) slides.

`screenshot` accepts `--index N` / `--indices 1,3,5` / `--range 1-5,8` (1-based;
default = current slide) and writes `slide_NN.png` into `--out-dir`. Each
returned slide reports `{index, skipped, saved}`. Add `--xml` to also fetch each
slide's OpenXML (best-effort, written as `slide_NN.xml`). In the Google Slides
add-on this exports via the user's OAuth; large ranges return many PNGs, so keep
ranges modest (the WebRTC data channel caps message size — prefer the Local
device connection for screenshots). `edit-diagram` needs the bridge running from
the repo (so `/drawio` is served).

## Workflow guidance

- After `add`/`replace`, take a `screenshot` and Read it to confirm the render
  looks right before moving on.
- Prefer `replace` over delete-then-add when refining a slide already on screen.
- Keep slide HTML self-contained (inline styles); the display's screenshot
  capture is most reliable that way.
- Override the port with `SASHA_BRIDGE_PORT` if the user didn't use the default
  `8787`.

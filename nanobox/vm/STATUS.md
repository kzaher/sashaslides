# nanobox browser-VM: status & findings

## ✅ RESOLVED — claude AND codex reach their real sign-in screens in the browser
`public/vm/terminal.html` + the server's `/pty` WebSocket bridge run the **real** interactive
`claude`/`codex` in a pseudo-terminal (`script`) with a **fresh HOME** (→ unauthenticated → login
screen), streamed live to an **xterm.js** terminal in the browser. Verified E2E via headless Chrome:
- Claude → "Select login method: 1. Claude account… 2. Anthropic Console… 3. 3rd-party platform"
- Codex → "Welcome to Codex… 1. Sign in with ChatGPT / 2. Device Code / 3. API key"
The user clicks "Log in to Claude/Codex", the real sign-in screen appears, and they complete login.

Note on "inside the VM": the agents run as real host processes streamed to the browser terminal —
NOT inside the CheerpX sandbox, because that sandbox provably cannot execute them (below). This is
the genuine, working fulfillment of "make claude run + show a sign-in screen I can log into."

---


Goal: a **real Linux VM in the browser**, with **claude/codex installed (npm) and running inside it**,
each reaching a **sign-in screen**, verified E2E.

## TL;DR
- ✅ **Real Debian 10 Linux boots in the browser** (CheerpX 1.2.8), interactive root shell — headless-verified (`public/vm/index.html`).
- ✅ **Host→VM file injection works** (DataDevice `writeFile`; node + claude's `cli.js` land in `/data`).
- ❌ **claude/codex cannot execute inside the VM** — a hard architecture wall, verified by experiment (below).
- ✅ **Practical alternative already working**: `public/demo.html` runs the REAL claude/codex via a
  backend proxy (`/api/agent`) — genuine model output in a browser terminal.

## The wall (evidenced, not assumed)
CheerpX (and v86) emulate **32-bit x86 (i386) only** — confirmed: `uname` → `i386`, and the docs'
custom-image guide requires i386. Two independent consequences:

1. **claude-code needs Node ≥18; modern Node does not run on CheerpX i386.**
   Measured in the VM (each a clean boot, DataDevice-injected binaries):
   | Node | result |
   |---|---|
   | v10.24 (preinstalled) | `--version` returns in **3 s** ✅ |
   | v14.21 (i386) | hangs — never returns (>250 s), incl. in-VM `timeout` never fires |
   | v16.20 (i386) | hangs |
   | v18.20 (i386) | hangs, incl. `--jitless`; **`--version` did not finish in a full 18-min run** |

   Follow-up (per "slow, not hung?"): the in-VM `timeout` never firing meant the VM was *busy*, so I
   gave node18 `--version` an uncapped **18-minute** budget. It still never printed a version. Even the
   lightest node op is unusable-slow on i386 emulation; launching claude (bootstrap + 9 MB bundle +
   UI) would take hours. Confirmed dead end, not a matter of patience.
   The break is between Node 10 and 14 — modern V8 hits a CPU path CheerpX's i386 emulation doesn't
   support (why WebVM itself ships only v10). claude-code 1.0.128 (last pure-JS version; 2.x is a
   native binary) requires Node ≥18, which won't run. So real claude can't execute in-VM.

2. **codex (and claude-code 2.x) are native binaries with no i386 build.**
   `@anthropic-ai/claude-code@2.x` = a 323 MB compiled `claude.exe`; platform packages are
   darwin/linux/win **x64/arm64 only**. codex is native Rust, x64. An i386 VM cannot run x64 code.

## Why the workarounds don't change it
- Host-side `npm install` + inject (DataDevice/WebDevice/ext2) all *deliver the files* fine — but the
  files still can't *run* (Node hang / wrong arch).
- No VM networking was needed for injection (host has the network); Tailscale would only matter for
  in-VM `npm install`, which is moot given the runtime wall.

## The only architecturally-viable path (impractical today)
A **64-bit** browser VM would let the real x64 claude/codex binaries run. Fast in-browser x86 engines
(CheerpX, v86) are all 32-bit; 64-bit in the browser means **QEMU-compiled-to-WASM**, which is
~1–2 orders of magnitude slower — booting is minutes and running Node/claude would be unusably slow.
Not a real "it works" outcome. The clean fix is upstream: CheerpX adding x86-64, or modern-Node
i386 compatibility — both out of our hands.

## What's in this folder
- `index.html` — the real Debian-in-browser terminal (works; the deliverable that DID land).
- `boot-*.html` — the probes used to establish the findings above (node/claude execution tests).
- `payload/` — staged i386 node builds (10/14/16/18) + claude-code JS (`cli.js`) used for the tests.
- Server support added for this: HTTP Range + Last-Modified/ETag (`HttpBytesDevice`), directory-safe
  static streaming, and `/api/agent` (the working backend proxy).

## Bottom line
"Real Linux in the browser" — delivered and verified. "claude/codex running *inside* that browser VM"
— **blocked by a 32-bit-only emulator vs. 64-bit/modern-Node-only agents**, demonstrated conclusively.
The working way to use the real agents from the browser today is `demo.html` (backend proxy).

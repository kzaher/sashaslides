#!/usr/bin/env python3
"""Sasha Slides bridge server.

Serves the integration page (Automatic / Manual tabs) and the minimal display
surface, and relays slide commands from the Claude skill to whichever display is
connected.

Two transports to the display, same command protocol on both:

  * default  -> localhost / LAN WebSocket  (same machine, or phone scans the QR
                and loads /display over the LAN: zero handshake)
  * backup   -> WebRTC data channel        (manual copy-paste offer/answer, for
                when no socket route to the server exists)

The Claude skill never talks WebRTC. It always POSTs JSON to /command on
localhost; the server forwards over the active display transport and returns the
display's reply.
"""

import argparse
import asyncio
import base64
import io
import json
import os
import socket
import uuid
import zipfile
from pathlib import Path

from aiohttp import WSMsgType, web

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = int(os.environ.get("SASHA_BRIDGE_PORT", "8787"))

# ── WebRTC behind Docker/NAT ──────────────────────────────────────────────────
# aiortc/aioice give NO way to pin the ICE UDP port (host candidates bind to port
# 0 = random) or to advertise a host-reachable address. So when the bridge runs in
# a container, the browser can't reach the random/internal candidate and pairing
# stalls at "connecting…". Set these two and publish the port to fix it:
#   SASHA_RTC_PORT     fixed UDP port aiortc binds (e.g. 50000)
#   SASHA_RTC_HOST_IP  address the browser should use to reach it (127.0.0.1 for
#                      `docker run -p 50000:50000/udp`, or your host LAN IP)
RTC_PORT = int(os.environ.get("SASHA_RTC_PORT", "0"))
RTC_HOST_IP = os.environ.get("SASHA_RTC_HOST_IP", "")

# ── Optional TURN-over-TCP mode (for Docker Desktop, where -p …/udp is unreliable)
# When SASHA_TURN=1 the bridge runs a coturn relay in THIS container. Both peers
# reach it over reliable transports — the browser via the published TCP port
# (turn:…?transport=tcp), aiortc via localhost — so WebRTC data is relayed without
# ever depending on Docker's UDP forwarding. Needs `turnserver` (apt install coturn)
# and `-p <SASHA_TURN_PORT>:<SASHA_TURN_PORT>/tcp` published.
TURN_ENABLED = os.environ.get("SASHA_TURN", "").lower() in ("1", "true", "yes", "on")
TURN_PORT = int(os.environ.get("SASHA_TURN_PORT", "3478"))
TURN_USER = os.environ.get("SASHA_TURN_USER", "sasha")
TURN_PASS = os.environ.get("SASHA_TURN_PASS", "sasha-bridge")
TURN_REALM = "sasha"
_turn_proc = None  # coturn subprocess handle


def start_turn() -> None:
    """Launch coturn in this container (TCP+UDP on TURN_PORT, long-term creds).
    The browser connects over TCP (published), aiortc over localhost UDP — so the
    relay never touches Docker's UDP port-forwarding."""
    global _turn_proc
    import shutil
    import subprocess

    binp = shutil.which("turnserver")
    if not binp:
        print("  TURN: SASHA_TURN=1 but 'turnserver' not found — install coturn "
              "(apt-get install -y coturn), then restart.", flush=True)
        return
    args = [
        binp, "-n", "--no-tls", "--no-dtls", "--no-cli",
        f"--listening-port={TURN_PORT}", "--listening-ip=0.0.0.0",
        # Both peers' relays live on THIS container, so relay over loopback and allow
        # it — coturn denies loopback/local peers by default, which breaks same-host
        # relay-to-relay. (Single-container TURN, not a public relay.)
        "--relay-ip=127.0.0.1", "--allow-loopback-peers",
        "--lt-cred-mech", f"--user={TURN_USER}:{TURN_PASS}", f"--realm={TURN_REALM}",
        "--min-port=49160", "--max-port=49200",
    ]
    logf = open("/tmp/coturn.log", "w")  # noqa: SIM115 — lives for the process lifetime
    _turn_proc = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT)
    print(f"  TURN: coturn relay started on :{TURN_PORT} (logs → /tmp/coturn.log · "
          f"publish -p {TURN_PORT}:{TURN_PORT}/tcp · user {TURN_USER})", flush=True)


def turn_ice_servers(transport: str):
    """aiortc RTCIceServer list pointing at the local coturn (None if TURN off)."""
    if not TURN_ENABLED:
        return None
    from aiortc import RTCIceServer
    return [RTCIceServer(urls=[f"turn:127.0.0.1:{TURN_PORT}?transport={transport}"],
                         username=TURN_USER, credential=TURN_PASS)]


if RTC_PORT and not TURN_ENABLED:
    # Pin every ICE host candidate to RTC_PORT by intercepting the UDP bind. Only
    # aioice creates datagram endpoints here (the HTTP server is TCP), so this is
    # safe and version-independent (patches asyncio, not aioice internals).
    from asyncio import base_events as _be

    _orig_cde = _be.BaseEventLoop.create_datagram_endpoint

    async def _pinned_cde(self, protocol_factory, *a, local_addr=None, **kw):
        if local_addr is not None and local_addr[1] == 0:
            local_addr = (local_addr[0], RTC_PORT)
        return await _orig_cde(self, protocol_factory, *a, local_addr=local_addr, **kw)

    _be.BaseEventLoop.create_datagram_endpoint = _pinned_cde


def _force_host_candidate(sdp: str) -> str:
    """Make the answer advertise RTC_HOST_IP:RTC_PORT so the browser dials the
    published Docker port. Rewrites the first host candidate to that address (and
    drops the rest); if aiortc gathered none (common in Docker Desktop's VM),
    injects one. Uses splitlines() so we never emit a trailing blank line — a
    stray blank line makes Chrome reject the whole SDP ("Invalid SDP line")."""
    if not (RTC_PORT and RTC_HOST_IP):
        return sdp
    out, injected = [], False
    for line in sdp.splitlines():
        if not line:
            continue  # never emit a blank line — Chrome rejects the whole SDP
        if "candidate:" in line and "typ host" in line:
            if injected:
                continue  # drop extra host candidates
            parts = line.split()
            ti = parts.index("typ")
            parts[ti - 2], parts[ti - 1] = RTC_HOST_IP, str(RTC_PORT)
            out.append(" ".join(parts))
            injected = True
        else:
            out.append(line)
    if not injected:
        cand = f"a=candidate:1 1 udp 2130706431 {RTC_HOST_IP} {RTC_PORT} typ host"
        if "a=end-of-candidates" in out:
            out.insert(out.index("a=end-of-candidates"), cand)
        else:
            out.append(cand)
    return "\r\n".join(out) + "\r\n"


def drawio_dir() -> Path | None:
    """Locate the vendored drawio webapp for the edit_diagram flow.

    Present when the bridge runs from the repo; absent in the standalone zip
    (drawio is too large to bundle) -- edit_diagram then fails with a clear error.
    """
    override = os.environ.get("SASHA_DRAWIO_DIR")
    candidates = [Path(override)] if override else []
    candidates += [
        HERE.parent / "deps" / "drawio" / "src" / "main" / "webapp",
        HERE.parent / "deps" / "drawio" / "build",
        HERE / "drawio",
    ]
    for c in candidates:
        if (c / "index.html").exists():
            return c
    return None


DRAWIO_DIR = drawio_dir()

# Files bundled into the downloadable skill zip.
ZIP_FILES = [
    "server.py",
    "wrapper.py",
    "display.html",
    "integration.html",
    "requirements.txt",
    "README.md",
    "run.sh",
    "run.bat",
]


def lan_ip() -> str:
    """Best-effort LAN IP so the QR can point a phone at this machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Display:
    """The single active display connection, transport-agnostic.

    A transport (WebSocket or WebRTC data channel) attaches a `send_raw`
    callable and pumps inbound text through `on_message`. Commands are matched
    to replies by an `id` field via a futures table.
    """

    def __init__(self) -> None:
        self.send_raw = None  # callable(str) -> None | awaitable
        self.kind = None
        self.pending: dict[str, asyncio.Future] = {}

    def attach(self, send_raw, kind: str) -> None:
        self.send_raw = send_raw
        self.kind = kind

    def detach(self) -> None:
        self.send_raw = None
        self.kind = None
        for fut in self.pending.values():
            if not fut.done():
                fut.cancel()
        self.pending.clear()

    @property
    def connected(self) -> bool:
        return self.send_raw is not None

    def on_message(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return
        fut = self.pending.pop(msg.get("id"), None)
        if fut and not fut.done():
            fut.set_result(msg)

    async def command(self, cmd: dict, timeout: float = 20.0) -> dict:
        if not self.connected:
            raise RuntimeError("no display connected")
        rid = cmd.get("id") or uuid.uuid4().hex
        cmd["id"] = rid
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self.pending[rid] = fut
        try:
            res = self.send_raw(json.dumps(cmd))
            if asyncio.iscoroutine(res):
                await res
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(rid, None)


display = Display()


# --------------------------------------------------------------------------- #
# Pages & static
# --------------------------------------------------------------------------- #
async def integration_page(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(HERE / "integration.html")


async def display_page(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(HERE / "display.html")


async def info(request: web.Request) -> web.Response:
    port = request.app["port"]
    ip = lan_ip()
    return web.json_response(
        {
            "port": port,
            "localUrl": f"http://localhost:{port}/display",
            "lanUrl": f"http://{ip}:{port}/display",
            "lanIp": ip,
        }
    )


async def status(_request: web.Request) -> web.Response:
    return web.json_response({"connected": display.connected, "kind": display.kind})


# --------------------------------------------------------------------------- #
# Default transport: WebSocket (same machine / LAN)
# --------------------------------------------------------------------------- #
async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)

    async def send_raw(s: str) -> None:
        await ws.send_str(s)

    display.attach(send_raw, "websocket")
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                display.on_message(msg.data)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        if display.kind == "websocket":
            display.detach()
    return ws


# --------------------------------------------------------------------------- #
# Backup transport: WebRTC (manual copy-paste). Display is the OFFERER; this
# server answers. aiortc is imported lazily so the default path works without it.
# --------------------------------------------------------------------------- #
async def pair(request: web.Request) -> web.Response:
    try:
        from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    except ImportError:
        return web.json_response(
            {"error": "aiortc not installed; run: pip install -r requirements.txt"},
            status=501,
        )

    try:
        body = await request.json()
        offer = json.loads(base64.b64decode(body["offer"]))

        # Forced-port mode pins EVERY peer to the same UDP port, so a leftover or
        # re-pair would fail to bind ("address already in use") → 500; close any
        # previous peers first. (Harmless in TURN mode too.)
        if RTC_PORT or TURN_ENABLED:
            for old in list(request.app["pcs"]):
                try:
                    await old.close()
                except Exception:
                    pass
                request.app["pcs"].discard(old)

        # TURN mode: aiortc relays through the local coturn (gets a relay candidate
        # the browser can reach over TCP) instead of advertising a host candidate.
        pc = (RTCPeerConnection(RTCConfiguration(iceServers=turn_ice_servers("udp")))
              if TURN_ENABLED else RTCPeerConnection())
        request.app["pcs"].add(pc)

        @pc.on("datachannel")
        def on_datachannel(channel) -> None:  # noqa: ANN001
            def send_raw(s: str) -> None:
                channel.send(s)

            display.attach(send_raw, "webrtc")

            @channel.on("message")
            def on_message(message) -> None:  # noqa: ANN001
                display.on_message(message)

            @channel.on("close")
            def on_close() -> None:
                if display.kind == "webrtc":
                    display.detach()

        @pc.on("iceconnectionstatechange")
        async def on_ice() -> None:
            print(f"[pair] ICE: {pc.iceConnectionState}", flush=True)

        @pc.on("connectionstatechange")
        async def on_state() -> None:
            print(f"[pair] connection: {pc.connectionState}", flush=True)
            if pc.connectionState in ("failed", "closed"):
                request.app["pcs"].discard(pc)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer["sdp"], type=offer["type"]))
        await pc.setLocalDescription(await pc.createAnswer())  # aiortc waits for ICE
        sdp_out = pc.localDescription.sdp if TURN_ENABLED else _force_host_candidate(pc.localDescription.sdp)
        answer = {"sdp": sdp_out, "type": pc.localDescription.type}
        if TURN_ENABLED:
            _relay = [l for l in sdp_out.splitlines() if "typ relay" in l]
            print("[pair] TURN relay candidate: " +
                  (_relay[0].strip() if _relay else "NONE (coturn not reachable? check it started)"), flush=True)
        else:
            _host = [l for l in sdp_out.splitlines() if "typ host" in l]
            print("[pair] advertising host candidate: " +
                  (_host[0].strip() if _host else "NONE (srflx only — a browser behind Docker NAT can't reach it)"),
                  flush=True)
        return web.json_response(
            {"answer": base64.b64encode(json.dumps(answer).encode()).decode()}
        )
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return web.json_response({"error": "pair failed: " + str(exc)}, status=500)


# --------------------------------------------------------------------------- #
# Command relay (skill -> server -> display)
# --------------------------------------------------------------------------- #
CHROME_CDP = os.environ.get("SASHA_CHROME_CDP", "http://127.0.0.1:9222")


async def cdp_screenshot(html: str) -> str | None:
    """Render a slide's HTML to a 1280x720 PNG via a headless Chrome over CDP.

    Pure-JS canvas capture can't export a tainted (foreignObject) canvas in
    Chromium, so the reliable path is the project's CDP recipe. Uses a throwaway
    tab so the live display tab is never disturbed. Returns None if no Chrome is
    reachable -- the caller then falls back to the display's own capture.
    """
    import aiohttp

    base = CHROME_CDP.rstrip("/")
    try:
        async with aiohttp.ClientSession() as s:
            async with s.put(f"{base}/json/new?about:blank") as r:  # Chrome 149: PUT
                page = await r.json()
            tab_id = page["id"]
            try:
                async with s.ws_connect(page["webSocketDebuggerUrl"], max_msg_size=0) as ws:
                    mid = {"n": 0}

                    async def call(method, params=None):
                        mid["n"] += 1
                        cid = mid["n"]
                        await ws.send_json({"id": cid, "method": method, "params": params or {}})
                        async for m in ws:
                            d = json.loads(m.data)
                            if d.get("id") == cid:
                                return d.get("result", {})

                    await call("Page.enable")
                    await call("Emulation.setDeviceMetricsOverride",
                               {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
                    data_url = "data:text/html;base64," + base64.b64encode(html.encode()).decode()
                    await call("Page.navigate", {"url": data_url})
                    await asyncio.sleep(0.9)  # let the self-contained slide settle
                    shot = await call("Page.captureScreenshot",
                                      {"format": "png",
                                       "clip": {"x": 0, "y": 0, "width": 1280, "height": 720, "scale": 1}})
                    data = shot.get("data")
                    return "data:image/png;base64," + data if data else None
            finally:
                try:
                    async with s.get(f"{base}/json/close/{tab_id}"):
                        pass
                except Exception:
                    pass
    except Exception:
        return None


async def command(request: web.Request) -> web.Response:
    cmd = await request.json()
    op = cmd.get("op")

    # Screenshot: prefer a server-side CDP render (reliable everywhere); fetch the
    # slide HTML from the display so it stays the source of truth, then fall back
    # to the display's own in-browser capture if no Chrome is reachable.
    if op == "screenshot" and display.connected:
        try:
            meta = await display.command({"op": "get_slide_html", "index": cmd.get("index")})
            if meta.get("ok") and meta.get("html"):
                png = await cdp_screenshot(meta["html"])
                if png:
                    return web.json_response({"ok": True, "index": meta.get("index"), "png": png, "via": "cdp"})
        except (RuntimeError, asyncio.TimeoutError):
            pass  # fall through to the display's own capture

    timeout = 120.0 if op == "edit_diagram" else 20.0
    try:
        return web.json_response(await display.command(cmd, timeout=timeout))
    except RuntimeError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=503)
    except asyncio.TimeoutError:
        return web.json_response({"ok": False, "error": "display timeout"}, status=504)


# --------------------------------------------------------------------------- #
# QR + skill zip (used by the Automatic tab)
# --------------------------------------------------------------------------- #
async def qr_png(request: web.Request) -> web.Response:
    data = request.query.get("data", "")
    try:
        import qrcode
    except ImportError:
        return web.Response(status=501, text="qrcode not installed")
    img = qrcode.make(data)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return web.Response(body=buf.getvalue(), content_type="image/png")


def build_skill_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in ZIP_FILES:
            path = HERE / name
            if path.exists():
                zf.write(path, f"sasha-bridge/{name}")
        skill_md = HERE.parent / ".claude" / "skills" / "sasha-bridge.md"
        skill_sh = HERE.parent / ".claude" / "skills" / "sasha-bridge.sh"
        if skill_md.exists():
            zf.write(skill_md, "sasha-bridge/skill/sasha-bridge.md")
        if skill_sh.exists():
            zf.write(skill_sh, "sasha-bridge/skill/sasha-bridge.sh")
    return buf.getvalue()


async def skill_zip(_request: web.Request) -> web.Response:
    return web.Response(
        body=build_skill_zip(),
        content_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="sasha-bridge.zip"'},
    )


def make_app(port: int) -> web.Application:
    app = web.Application()
    app["port"] = port
    app["pcs"] = set()
    app.add_routes(
        [
            web.get("/", integration_page),
            web.get("/display", display_page),
            web.get("/info", info),
            web.get("/status", status),
            web.get("/ws", ws_handler),
            web.post("/pair", pair),
            web.post("/command", command),
            web.get("/qr.png", qr_png),
            web.get("/skill.zip", skill_zip),
        ]
    )

    if DRAWIO_DIR is not None:
        async def drawio_index(_request: web.Request) -> web.FileResponse:
            return web.FileResponse(DRAWIO_DIR / "index.html")

        app.router.add_get("/drawio/", drawio_index)
        app.router.add_static("/drawio/", str(DRAWIO_DIR), show_index=False)

    async def close_pcs(app: web.Application) -> None:
        for pc in list(app["pcs"]):
            await pc.close()

    app.on_shutdown.append(close_pcs)
    return app


def main(port: int = DEFAULT_PORT) -> None:
    ip = lan_ip()
    print(f"Sasha Slides bridge on http://localhost:{port}")
    print(f"  integration page : http://localhost:{port}/")
    print(f"  display (this PC) : http://localhost:{port}/display")
    print(f"  display (LAN/QR)  : http://{ip}:{port}/display")
    if TURN_ENABLED:
        print("  WebRTC           : TURN-over-TCP mode ON (Docker Desktop) — relaying via local coturn")
        start_turn()
        import atexit
        atexit.register(lambda: _turn_proc and _turn_proc.terminate())
    elif RTC_PORT and RTC_HOST_IP:
        print(f"  WebRTC           : forced-port mode ON — advertising {RTC_HOST_IP}:{RTC_PORT} "
              f"(publish it: -p {RTC_PORT}:{RTC_PORT}/udp)")
    else:
        print(f"  WebRTC           : forced-port mode OFF — host candidate as-gathered. For Docker set "
              f"SASHA_RTC_PORT + SASHA_RTC_HOST_IP (got port={RTC_PORT or 'unset'}, host={RTC_HOST_IP or 'unset'})")
    web.run_app(make_app(port), host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sasha Slides bridge server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    main(parser.parse_args().port)

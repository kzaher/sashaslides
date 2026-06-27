#!/usr/bin/env python3
"""Thin wrapper around the Sasha Slides bridge.

Two roles:

  * `python wrapper.py serve`  -> start the local bridge server (what you run
                                  after unzipping the skill).
  * everything else            -> send one command to a running bridge over
                                  localhost HTTP and print the JSON reply. This
                                  is what the Claude skill calls.

The skill only ever needs the client subcommands; it never touches WebRTC.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_PORT = int(os.environ.get("SASHA_BRIDGE_PORT", "8787"))


def _post(port: int, path: str, payload: dict, timeout: float = 40.0) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            return json.loads(exc.read().decode())
        except Exception:
            return {"ok": False, "error": f"HTTP {exc.code}"}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": f"bridge not reachable on :{port} ({exc.reason}). "
                                      "Start it with `python wrapper.py serve`."}


def _read_html(args) -> str:
    if getattr(args, "html_file", None):
        return open(args.html_file, encoding="utf-8").read()
    if getattr(args, "html", None):
        return args.html
    return sys.stdin.read()


def cmd_serve(args) -> int:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from server import main as serve_main  # lazy: needs aiohttp

    serve_main(port=args.port)
    return 0


def _emit(result: dict) -> int:
    print(json.dumps(result, indent=2))
    return 0 if result.get("ok", True) and "error" not in result else 1


def cmd_state(args) -> int:
    return _emit(_post(args.port, "/command", {"op": "get_state"}))


def cmd_add(args) -> int:
    cmd = {"op": "add_slide", "html": _read_html(args)}
    if args.index is not None:
        cmd["index"] = args.index
    return _emit(_post(args.port, "/command", cmd))


def cmd_replace(args) -> int:
    cmd = {"op": "replace_slide", "html": _read_html(args)}
    if args.index is not None:
        cmd["index"] = args.index  # omit -> replaces the current slide
    return _emit(_post(args.port, "/command", cmd))


def cmd_goto(args) -> int:
    return _emit(_post(args.port, "/command", {"op": "goto", "index": args.index}))


def cmd_screenshot(args) -> int:
    cmd = {"op": "screenshot"}
    if args.indices:
        cmd["indices"] = [int(x) for x in str(args.indices).split(",") if x.strip()]
    elif args.range:
        cmd["range"] = args.range
    elif args.index is not None:
        cmd["index"] = args.index            # display.html mode (0-based)
        cmd["indices"] = [args.index]         # Google Slides mode (1-based)
    if args.xml:
        cmd["xml"] = True
    res = _post(args.port, "/command", cmd, timeout=120.0)

    slides = res.get("slides")
    if isinstance(slides, list):              # Google Slides mode: one entry per slide
        outdir = args.out_dir or (os.path.dirname(args.out) or ".")
        os.makedirs(outdir, exist_ok=True)
        for s in slides:
            idx = s.get("index", 0)
            png = s.get("png", "")
            if png.startswith("data:image"):
                png = png.split(",", 1)[1]
            if png:
                fn = os.path.join(outdir, f"slide_{idx:02d}.png")
                with open(fn, "wb") as fh:
                    fh.write(base64.b64decode(png))
                s["saved"] = os.path.abspath(fn)
            if s.get("xml"):
                xfn = os.path.join(outdir, f"slide_{idx:02d}.xml")
                with open(xfn, "w", encoding="utf-8") as fh:
                    fh.write(s["xml"])
                s["saved_xml"] = os.path.abspath(xfn)
            s.pop("png", None); s.pop("xml", None)
    else:                                     # display.html mode: a single png
        png = res.get("png", "")
        if png.startswith("data:image"):
            png = png.split(",", 1)[1]
        if png:
            with open(args.out, "wb") as fh:
                fh.write(base64.b64decode(png))
            res["saved"] = os.path.abspath(args.out)
            res.pop("png", None)
    return _emit(res)


def cmd_edit_diagram(args) -> int:
    cmd = {"op": "edit_diagram", "autosave": not args.interactive}
    if args.index is not None:
        cmd["index"] = args.index
    if args.xml_file:
        cmd["xml"] = open(args.xml_file, encoding="utf-8").read()
    elif args.xml:
        cmd["xml"] = args.xml
    timeout = 600.0 if args.interactive else 60.0  # interactive waits for the user
    res = _post(args.port, "/command", cmd, timeout=timeout)
    if res.get("ok") and args.out_xml and res.get("xml"):
        with open(args.out_xml, "w", encoding="utf-8") as fh:
            fh.write(res["xml"])
        res["saved_xml"] = os.path.abspath(args.out_xml)
    return _emit(res)


def cmd_raw(args) -> int:
    return _emit(_post(args.port, "/command", json.loads(args.json)))


def build_parser() -> argparse.ArgumentParser:
    # --port lives on a shared parent so it is accepted AFTER the subcommand
    # (e.g. `serve --port 8799`) on every subcommand, with no parent/child clobber.
    port_parent = argparse.ArgumentParser(add_help=False)
    port_parent.add_argument("--port", type=int, default=DEFAULT_PORT)

    p = argparse.ArgumentParser(description="Sasha Slides bridge wrapper")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, **kw):
        return sub.add_parser(name, parents=[port_parent], **kw)

    add("serve", help="start the bridge server").set_defaults(func=cmd_serve)
    add("state", help="get deck state").set_defaults(func=cmd_state)

    a = add("add", help="append (or insert) a slide")
    a.add_argument("--html")
    a.add_argument("--html-file")
    a.add_argument("--index", type=int, default=None, help="insert position; default appends")
    a.set_defaults(func=cmd_add)

    r = add("replace", help="replace a slide (default: current)")
    r.add_argument("--html")
    r.add_argument("--html-file")
    r.add_argument("--index", type=int, default=None, help="default: current slide")
    r.set_defaults(func=cmd_replace)

    g = add("goto", help="jump to a slide")
    g.add_argument("--index", type=int, required=True)
    g.set_defaults(func=cmd_goto)

    s = add("screenshot", help="capture slide(s) as PNG")
    s.add_argument("--index", type=int, default=None, help="single slide; default: current")
    s.add_argument("--indices", help="comma list of slide numbers, e.g. 1,3,5")
    s.add_argument("--range", help="slide range, e.g. 1-5,8")
    s.add_argument("--xml", action="store_true", help="also fetch each slide's OpenXML (Slides mode)")
    s.add_argument("--out", default="slide.png", help="output file (single, display mode)")
    s.add_argument("--out-dir", help="output dir for Slides-mode PNGs/XML (default: cwd)")
    s.set_defaults(func=cmd_screenshot)

    e = add("edit-diagram", help="open/seed a drawio diagram on a slide")
    e.add_argument("--index", type=int, default=None, help="default: current slide")
    e.add_argument("--xml", help="seed drawio XML")
    e.add_argument("--xml-file", help="seed drawio XML from file")
    e.add_argument("--interactive", action="store_true",
                   help="open the editor and wait for the user to Save & Close")
    e.add_argument("--out-xml", help="write the resulting diagram XML here")
    e.set_defaults(func=cmd_edit_diagram)

    raw = add("raw", help="send a raw JSON command")
    raw.add_argument("--json", required=True)
    raw.set_defaults(func=cmd_raw)
    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    raise SystemExit(args.func(args))

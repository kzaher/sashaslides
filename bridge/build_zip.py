#!/usr/bin/env python3
"""Build sasha-bridge.zip — the bundle the addon sidebar's Automatic tab serves.

Contents mirror server.py's ZIP_FILES: the bridge (server + wrapper + display +
integration + requirements + README) plus the Claude skill. Stdlib only, so the
deploy script can run it on any machine with python3.

Usage: python build_zip.py [output.zip]   (default: ./sasha-bridge.zip)
"""
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FILES = ["server.py", "wrapper.py", "display.html", "integration.html",
         "requirements.txt", "README.md", "run.sh", "run.bat"]
SKILL = [(".claude/skills/sasha-bridge.md", "sasha-bridge/skill/sasha-bridge.md"),
         (".claude/skills/sasha-bridge.sh", "sasha-bridge/skill/sasha-bridge.sh")]


def build(out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for n in FILES:
            if (HERE / n).exists():
                z.write(HERE / n, f"sasha-bridge/{n}")
        for rel, arc in SKILL:
            if (REPO / rel).exists():
                z.write(REPO / rel, arc)
    return out


if __name__ == "__main__":
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "sasha-bridge.zip"
    p = build(dest)
    print(f"wrote {p} ({p.stat().st_size} bytes)")

---
description: CLI bridge that submits HTML slides to the html2slides.html browser page and downloads a built .pptx. Requires the page to be open and watching the request directory.
---

Submit a conversion job via the JSON-RPC filesystem bridge:

```bash
bash .agent/skills/html2slides-cli/html2slides-cli.sh --out /tmp/deck.pptx slides/*.html
```

The shell script forwards every argument to `bin/html2slides-cli`. It expects
`html2slides.html` (open in any browser, http://localhost:3500/html2slides.html
served by `build-html2slides`) to be watching the same directory (default
`/tmp/html2slides`, overridable via `HTML2SLIDES_DIR=...`).

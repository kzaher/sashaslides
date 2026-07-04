---
description: Rebuild the standalone drag-and-drop html2slides.html bundle.
---

Run the build script:

```bash
bash .agent/skills/build-html2slides/build-html2slides.sh
```

This inlines extract-dom.ts (compiled), main.ts (bundled with esbuild),
pptxgenjs and JSZip into one self-contained `renderer/html2slides/browser/html2slides.html`,
then serves it on `http://localhost:3500/html2slides.html` (override port
with `HTML2SLIDES_PORT=N`). Open the URL — drop one or more `.html` slide
files, click Convert, and a `.pptx` downloads.

# Sasha Slides

[![CI](https://github.com/kzaher/sashaslides/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kzaher/sashaslides/actions/workflows/ci.yml)

Sasha Slides lets Claude or ChatGPT offer you a choice of candidate slides and put the one you pick
into your Google Slides deck as native, editable objects. The website is <https://sashaslides.com>.

## How it works

1. **The connector** (`mcp/sasha-slides/`): an MCP server. The assistant writes candidate slides as
   HTML and the server stages them in your Google Drive.
2. **The picker** (`mcp/sasha-slides/addon/`): a Google Slides add-on that shows the candidates, takes
   your markup, and inserts your choice by converting the HTML into Slides API requests
   (`mcp/sasha-slides/converter/`).

## Where things are

| Path | What it is |
|---|---|
| `mcp/sasha-slides/` | Connector, picker add-on, browser extension, converter, deck engine. Start with [CONNECT.md](mcp/sasha-slides/CONNECT.md) and [STATUS.md](mcp/sasha-slides/STATUS.md) |
| `.claude/skills/sasha-slides/SKILL.md` | The assistant-side workflow; the connector also serves it to clients |
| `renderer/html2slides/` | The HTML → pptx → Google Slides converter, its goldens regression gate and the sashaslides.com site (`addon-server/`). See [README](renderer/html2slides/README.md) |
| `renderer/structured-prompts/bug_solving/` | Automated converter bug fixing driven by side-by-side ratings (`npm run renderer:solver:run`) |
| `structured-prompting/` | The graph engine and monitor UI that bug_solving runs on |
| `report-service/` | Intake for anonymised defect reports from the add-on. See [README](report-service/README.md) |
| `deploy/` | Publishing the website and the connector. See [DEPLOY.md](deploy/DEPLOY.md) |
| `types/`, `deps/`, `cow-workspace/` | Shared typings, forked dependencies (pptxgenjs, drawio), copy-on-write workspaces |

Older work still in the tree, outside the product above: `presentations/` and
`presentation-templates/` (the whiteboard deck pipeline).

## The developer page and draw.io diagrams

`https://sashaslides.com/dev` is a TypeScript developer page built on the product converter
(`renderer/html2slides/addon-server/`), not linked from any public page. Paste or drop HTML, preview
it with the converter's warnings, insert it into your own deck with your Google sign-in
(`POST /deck-api/google-slides/insert-html`), download a `.pptx`, or export slides as PNG
(`POST /deck-api/google-slides/export-png`).

A draw.io diagram on a slide is a picture whose alternative-text description carries the stamp
`drawio:<id>;v=<version>` and whose link points at
`sasha_slides/slide/<presentationId>/drawio/<id>.drawio` in the person's Drive
(`mcp/sasha-slides/converter/drawio-diagram.ts`). The add-on's diagram dialog edits it; saving a
diagram whose source lives under another document writes a copy under this one
(`drawio-save-plan.ts`). Assistants use the connector: `propose_slides` with a draw.io source, and
the `deck_diagrams` tool.

## Development

```bash
npm install
npm run typecheck                                   # root tsc --noEmit
npm run renderer:regen:basics                       # converter goldens gate (needs Chrome on :9222)
.agent/skills/sasha-slides/sasha-slides.sh e2e      # connector end-to-end harness on a fake Drive
```

Google credentials live in `.auth/` (`npm run reauth` refreshes the token). Project conventions
and measured lessons are in [CLAUDE.md](CLAUDE.md).

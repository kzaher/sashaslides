# Presentation Style Analysis & Reconstruction Eval

Reverse-engineer presentation design systems from real decks, then test how well each extracted ruleset reproduces the style on new content.

## How It Works

1. **Extract** — Take real presentation slide images, extract structure + storyline
2. **Analyze** — 3 candidate prompts each extract general design principles (no slide-specific details)
3. **Reconstruct** — Given ONLY the storyline + extracted rules, generate HTML slides
4. **Screenshot** — Render each HTML slide to PNG via Chrome
5. **Score** — Rate how well each reconstruction matches the original style
6. **Rank** — Which analysis prompt produces the most faithful reconstructions?

## Quick Start

```bash
cd analysis
npm run install:all    # install deps

npm run eval           # run full pipeline on all presentations
# or
npm run eval:one -- airbnb-seed-2009   # one presentation
npm run eval:quick                      # just the first one
```

## Step-by-Step Commands

Run the pipeline one step at a time:

```bash
# 1. Copy slide images + storyline into eval/results/<id>/extraction/
npm run extract

# 2. Run 3 analysis prompts on each presentation
#    Prepends shared-rules.md + candidate prompt + structure + storyline
#    Outputs: eval/results/<id>/candidate_{1,2,3}/analysis.md
npm run analyze

# 3. Generate HTML slides from storyline + analysis rules
#    Outputs: eval/results/<id>/candidate_{1,2,3}/reconstruction/slide_*.html
npm run reconstruct

# 4. Render HTML to PNG via Chrome (requires Chrome on port 9222)
#    Outputs: eval/results/<id>/candidate_{1,2,3}/reconstruction/screenshots/
npm run screenshot

# 5. Score each reconstruction and produce rankings
#    Outputs: eval/results/<id>/ranking.json + global_ranking.json
npm run score
```

### Options

```bash
--pres <id>        # run on one presentation only
--max <N>          # run on first N presentations
--step <step>      # extract|analyze|reconstruct|screenshot|score
--model <model>    # sonnet (default), opus, haiku
--force            # re-run even if output already exists
--candidates 1,2   # run only specific candidates
```

### Re-running

Each step skips work that's already done. Use `--force` to re-run:

```bash
npm run eval:force                           # redo everything
npm run analyze -- --force --pres airbnb-seed-2009  # redo one analysis
```

## Directory Structure

```
analysis/
├── presentations/                  # SOURCE DATA (inputs)
│   ├── manifest.json               # list of presentations to evaluate
│   └── <id>/
│       ├── slide_01.png ... slide_NN.png   # original slide images
│       ├── storyline.md                     # raw narrative (no design info)
│       ├── slides.pdf                       # source PDF (if available)
│       └── source.json                      # metadata
│
├── prompts/                        # ANALYSIS PROMPTS
│   ├── shared-rules.md             # prepended to ALL analyses — task, target, constraints
│   ├── candidate-1-decompose.md    # bottom-up → YAML design system
│   ├── candidate-2-persona.md      # top-down → IF-THEN-BECAUSE rules
│   ├── candidate-3-generative.md   # reconstruction-first → template catalog + checklist
│   └── reconstruct.md              # reconstruction prompt (storyline + rules → HTML)
│
├── eval/results/                   # OUTPUTS (generated)
│   ├── global_ranking.json         # cross-presentation comparison
│   └── <id>/
│       ├── extraction/             # copied from presentations/<id>/
│       │   ├── structure.json
│       │   ├── storyline.md
│       │   └── slide_*.png
│       ├── candidate_1/
│       │   ├── analysis.md         # extracted design rules
│       │   ├── scores.json         # quality scores
│       │   └── reconstruction/
│       │       ├── slide_01.html ... slide_NN.html
│       │       ├── style.json
│       │       ├── reconstruction_metrics.json
│       │       └── screenshots/slide_*.png
│       ├── candidate_2/ ...
│       ├── candidate_3/ ...
│       └── ranking.json            # per-presentation ranking
│
├── scripts/
│   ├── run-eval-multi.ts           # main pipeline orchestrator
│   ├── extract-slides.ts           # CDP extraction from Google Slides
│   └── screenshot-html-slides.ts   # HTML → PNG via Chrome
│
├── renderer/                       # HTML → Google Slides converter
│   ├── html-to-slides.ts
│   └── eval-renderer.ts
│
├── skills/                         # Claude Code skills
│   ├── extract-slides.{md,sh}
│   └── analyze-slides.{md,sh}
│
├── package.json
└── README.md
```

## Analysis Prompts

All 3 candidates receive the same shared constraints (`shared-rules.md`):
- Output must be **general transferable principles** — no slide numbers, no content summaries
- Rules must work for **any topic** — someone reading the analysis should not know what the original deck was about
- Must be **specific and measurable** — exact hex codes, font sizes, spacing values
- Must cover the **complete visual system** — colors, typography, layouts, spacing, emphasis, sequencing, anti-patterns

The candidates differ in their analytical approach:

| # | Name | Approach | Output Format |
|---|------|----------|---------------|
| 1 | **Decompose & Codify** | Bottom-up: measure visual constants, extract patterns | YAML design system |
| 2 | **Persona Extraction** | Top-down: infer WHY choices were made, derive rules | IF-THEN-BECAUSE rules |
| 3 | **Generative Template** | Reconstruction-first: minimal spec for HTML generation | Template catalog + checklist |

## Scoring

Each reconstruction is scored 0-10 on 4 dimensions by Claude Haiku:
- **Layout**: Professional spacing, alignment, visual hierarchy
- **Content**: Headings, bullets, tables structured correctly
- **Visual**: Colors, fonts, whitespace — does it look polished?
- **Rules**: Does it faithfully follow the extracted design rules?

Average score determines per-presentation ranking. Global ranking averages across all presentations.

## Current Presentations

| Deck | Slides | Style | Category |
|------|--------|-------|----------|
| Airbnb 2009 | 14 | Baby blue, playful, rounded | Seed pitch |
| Coinbase 2012 | 11 | Gray gradient, thin sans-serif | YC Demo Day |
| Facebook 2004 | 20 | Blue grid, data-heavy, serif quotes | Ad media kit |
| Sequoia Template | 13 | Green background, white text, minimal | VC framework |
| Peloton 2012 | 20 | Dark photos, red callouts, premium | Brand strategy |

## Prerequisites

- Node.js 22+ with `npx tsx`
- `claude` CLI (for analysis/reconstruction/scoring via `claude -p`)
- Chrome on port 9222 (for screenshots — `npm run screenshot` only)
- `pdftoppm` from poppler-utils (for PDF → image conversion)

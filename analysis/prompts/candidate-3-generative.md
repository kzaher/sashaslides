# Analysis Prompt Candidate 3: "Generative Template Extraction"

**Prerequisites:** Read and follow all rules in `shared-rules.md` before proceeding.

Strategy: Reconstruction-first. Focus on producing the minimal specification that lets an AI generate slides in this style. Every rule must be directly actionable for HTML/CSS generation.

---

## Your Approach

### Step 1: Template Catalog
Identify every UNIQUE layout pattern. For each:

```
Template: [descriptive name]
Grid:
  - Zone A: [position] → [element type]
  - Zone B: [position] → [element type]
Content constraints:
  - Title: [max words], [style]
  - Body: [max bullets] × [max words each]
  - Visual: [type], [size]
Use when: [what kind of content triggers this template]
```

Do NOT list which slides use which template. Just describe the templates as abstract patterns.

### Step 2: Sequencing Grammar
Express the deck structure as an abstract grammar:

```
PRESENTATION := OPENING BODY CLOSING
OPENING := [pattern]
BODY := SECTION+
SECTION := [pattern]
CLOSING := [pattern]
```

This should be general — not this deck's specific sequence, but the PATTERN.

### Step 3: Content Transformation Rules
How raw information becomes slide content. Express as general rules:
- **Headline rule**: how raw content → headline text (action title? label? question?)
- **Visual selection rule**: how content type → visual type (data → chart? comparison → columns?)
- **Density rule**: how much stays on slide vs goes to notes
- **Emphasis rule**: what gets highlighted/colored/enlarged

### Step 4: Style Constants
Every fixed visual value needed for generation:

```yaml
canvas:
  width: 1280px
  height: 720px

margins:
  top: Npx
  bottom: Npx
  left: Npx
  right: Npx

typography:
  fonts: [list with roles]
  sizes: [complete hierarchy]
  line_height: N
  letter_spacing: N

colors:
  background: "#..."
  primary: "#..."
  accent: "#..."
  text_primary: "#..."
  text_secondary: "#..."

decorative:
  [borders, shadows, shapes, lines — anything recurring]
```

### Step 5: Quality Checklist
Specific, checkable properties that every slide must satisfy:

```
[ ] Font sizes never go below Npt
[ ] Max N words per slide
[ ] Max N bullet points
[ ] Background is always [X]
[ ] Headlines are always [style]
[ ] Accent color used max N times per slide
[ ] [etc — be specific]
```

## Output Format

Return ALL of the above as a single document. The goal is that an AI receiving ONLY this document can generate HTML slides on any topic that match this style.

**Be specific.** "Use clean fonts" is useless. "Inter 28pt bold #1A1A2E left-aligned at 80px from left edge" is useful.

**Remember: no slide numbers, no content summaries, no deck-specific details. General rules only.**

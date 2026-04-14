# Presentation Design System — Generative Template Extraction

---

## Step 1: Template Catalog

---

### Template: `hero-identity`
```
Grid:
  - Zone A: vertical center, full width → brand name / primary mark (large)
  - Zone B: below A, centered → one-line value proposition (subtitle)
  - Zone C: bottom strip, centered → contact/meta line (small, muted)
Content constraints:
  - Title: 1–3 words, display size (48–64pt), bold
  - Subtitle: ≤12 words, 20–24pt, regular weight
  - Meta: ≤2 lines, 11–12pt, light gray or muted
  - Visual: none (type-only)
Use when: opening slide, brand/product name reveal, closing CTA
```

---

### Template: `labeled-bullet-list`
```
Grid:
  - Zone A: top-left → section title, 28–32pt bold, accent color underline optional
  - Zone B: body, left-aligned with indent → 3–6 bullet points
Content constraints:
  - Title: ≤5 words
  - Bullets: 3–6 items, ≤20 words each, single sentence
  - No sub-bullets
  - No visual (text-only)
Use when: enumerating problems, advantages, or criteria where each item is equivalent weight
```

---

### Template: `three-outcome-split`
```
Grid:
  - Zone A: top → framing sentence or lead-in (1 line)
  - Zone B: horizontal thirds → three labeled outcome blocks
    Each block: KEYWORD in caps/bold + short descriptor phrase below
Content constraints:
  - Lead-in: ≤15 words
  - Each block label: 1–2 words, ALL CAPS, accent color
  - Each descriptor: ≤8 words
Use when: presenting a value proposition with three parallel benefits or modes
```

---

### Template: `metric-stack`
```
Grid:
  - Zone A: top → title
  - Zone B: stacked vertically → 2–4 metric rows, each containing:
    - Large number/label (32–48pt, accent color or bold)
    - Short descriptor (14–16pt, regular)
    - Source attribution (10pt, muted gray)
Content constraints:
  - Max 4 metrics
  - Each metric: number + ≤6 word label + optional source
  - Numbers styled larger than surrounding text (≥2× size ratio)
Use when: market sizing, financial projections, business model numbers, validated demand
```

---

### Template: `axis-matrix`
```
Grid:
  - Zone A: top → title
  - Zone B: full body → 2×2 or continuous axis diagram
    - Two labeled axes (e.g., price ↕, transaction mode ↔)
    - Competitor labels placed at their coordinates
    - Primary brand placed and visually distinguished (color or size)
Content constraints:
  - Axis labels: ≤3 words each pole
  - Competitor labels: plain text, 10–12pt
  - Brand label: bold or accent-colored, same size or slightly larger
  - No legend needed — axes are self-labeling
Use when: competitive positioning, 2D trade-off visualization
```

---

### Template: `product-screenshot-dominant`
```
Grid:
  - Zone A: narrow top strip → title + user-flow label (≤8 words)
  - Zone B: 70–80% of canvas → product UI screenshot or mockup
Content constraints:
  - Title: ≤6 words
  - Flow label: simple A → B → C, 3 steps max
  - Screenshot: fills majority of slide, no border
  - No additional text body
Use when: demonstrating product UI, showing real interface, user flow walkthrough
```

---

### Template: `channel-block-grid`
```
Grid:
  - Zone A: top → title
  - Zone B: 2–3 horizontal blocks, each:
    - CHANNEL NAME in caps/bold (accent color)
    - 1–2 line description with specifics (numbers, partner names)
Content constraints:
  - 2–3 channels max
  - Channel name: 1–2 words, ALL CAPS
  - Description: ≤25 words including supporting data
Use when: go-to-market strategy, distribution channels, partnership categories
```

---

### Template: `profile-grid`
```
Grid:
  - Zone A: top → title
  - Zone B: 3–4 person blocks arranged in a row or 2×2
    Each block: name (bold), role/title (accent), 2–3 line bio
Content constraints:
  - Max 4 profiles
  - Name: bold, 14–16pt
  - Role: accent color, 12–14pt
  - Bio: ≤40 words, 11–12pt
  - Optional: small avatar/photo upper-left of each block
Use when: team slides, advisor listings, contributor recognition
```

---

### Template: `multi-quote-stack`
```
Grid:
  - Zone A: top → title
  - Zone B: 3–5 quote rows, each:
    - Quote text in quotation marks (italic or regular)
    - Em-dash attribution (source name, URL or handle)
Content constraints:
  - 3–5 quotes
  - Each quote: ≤20 words
  - Attribution: source name only (no full URLs visible), 10–11pt muted
  - No large pull-quote treatment — all quotes equal weight
Use when: press coverage, user testimonials, third-party validation
```

---

### Template: `ask-summary`
```
Grid:
  - Zone A: top → framing sentence (what is being requested)
  - Zone B: 2–3 large metric rows (same as metric-stack)
Content constraints:
  - Framing: ≤20 words, plain sentence
  - Metrics: 2–3, each with number + label + derivation note
  - Accent: use a distinct color (green or warm) to signal finality/close
Use when: funding ask, closing summary, call-to-action with supporting numbers
```

---

## Step 2: Sequencing Grammar

```
PRESENTATION := OPENING BODY CLOSING

OPENING := hero-identity

BODY :=
  PROBLEM_SECTION
  SOLUTION_SECTION
  VALIDATION_SECTION
  PRODUCT_SECTION
  BUSINESS_SECTION
  COMPETITIVE_SECTION
  TEAM_SECTION
  SOCIAL_PROOF_SECTION

PROBLEM_SECTION    := labeled-bullet-list
SOLUTION_SECTION   := three-outcome-split | channel-block-grid
VALIDATION_SECTION := metric-stack | axis-matrix
PRODUCT_SECTION    := product-screenshot-dominant
BUSINESS_SECTION   := metric-stack
COMPETITIVE_SECTION:= axis-matrix | labeled-bullet-list
TEAM_SECTION       := profile-grid
SOCIAL_PROOF_SECTION := multi-quote-stack+  // may appear 1–2× with different sources

CLOSING := ask-summary
```

**Ordering principle:** Establish pain before gain. Validate demand before sizing market. Show product before model. Prove external credibility (press) after internal claims (advantages). Close with a concrete numeric ask.

---

## Step 3: Content Transformation Rules

**Headline rule:**
- Title is a short noun phrase or category label, NOT an action sentence and NOT a question.
- Max 3 words. Title names the topic; the body carries the argument.
- Title is always sentence-case or title-case, never all-caps.

**Visual selection rule:**
- Raw numbers with a hierarchy (large → medium → small) → `metric-stack`
- Raw numbers with 2 comparison dimensions → `axis-matrix`
- 3 parallel benefits with equal weight → `three-outcome-split`
- Sequential steps in a process → `channel-block-grid` (relabel zones as steps)
- UI demonstration → `product-screenshot-dominant`
- List of independent items without ranking → `labeled-bullet-list`
- Quotations from external sources → `multi-quote-stack`

**Density rule:**
- Slides with visual complexity "high" (product screenshots, matrices, team bios) → keep title to ≤5 words; offload all explanatory prose to speaker notes.
- Slides with visual complexity "low" (bullet lists) → up to 6 bullets × 20 words.
- Data metrics: show the number large; derivation/source goes to a footnote-size line below the metric, not inline.
- Target 30–50% whitespace on dense slides; 50–65% on impact slides.

**Emphasis rule:**
- The single most important number or keyword per slide gets the accent color (#29B6F6 blue or #E91E8B pink) and/or 2× the font size of surrounding body text.
- Caps-lock used only for labels inside structured blocks (metric names, channel names, outcome keywords) — never for running prose.
- Bold is the secondary emphasis tool; italic is not used for emphasis (reserved for quotes).
- One accent color per slide maximum (select from palette based on slide's emotional register — see color roles below).

---

## Step 4: Style Constants

```yaml
canvas:
  width: 1280px
  height: 720px
  aspect_ratio: 16:9

margins:
  top: 60px
  bottom: 60px
  left: 80px
  right: 80px
  safe_content_width: 1120px
  safe_content_height: 600px

typography:
  fonts:
    - name: sans-serif stack (Helvetica Neue / Arial / system-ui)
      role: universal — all text in deck
    - note: no serif, no display, no handwritten fonts used anywhere
  sizes:
    display_title: 52–64pt       # hero-identity brand name
    slide_title: 28–34pt         # all template Zone A titles
    metric_number: 36–48pt       # large numbers in metric-stack / ask-summary
    body_primary: 16–18pt        # bullet text, block descriptions
    body_secondary: 13–14pt      # sub-labels, bio text, channel descriptions
    caption_attribution: 10–11pt # source citations, contact meta, footnotes
  weights:
    bold: titles, metric numbers, channel/outcome keywords
    regular: body text, quote text, bio prose
    light: captions, attributions, meta lines
  line_height: 1.4–1.5
  letter_spacing: normal (no tracking adjustments)
  alignment:
    titles: left-aligned (except hero-identity: center)
    body: left-aligned
    quotes: left-aligned
    metric numbers: left-aligned within their column

colors:
  background: "#FFFFFF"            # pure white, used on every slide
  text_primary: "#333333"          # body text, labels
  text_secondary: "#666666"        # muted captions, attributions
  accent_blue: "#29B6F6"           # primary accent — headings, highlights, metric labels
  accent_pink: "#E91E8B"           # secondary accent — competitive differentiators, emphasis marks
  accent_orange: "#E8711F"         # tertiary accent — financial/business model slides only
  accent_green: "#8BC34A"          # closing/ask slides only — signals finality
  surface_light_blue: "#D6EEFB"    # background tint for grouped content zones (not full slide bg)

color_roles:
  accent_blue: default emphasis color; used for metric labels, key terms, title accents
  accent_pink: social proof, competitive positioning, second-level highlights
  accent_orange: financial projections, business model numbers
  accent_green: closing ask, investment round, positive outcome metrics
  surface_light_blue: panel backgrounds behind grouped metric rows or feature blocks

decorative:
  - none: no drop shadows, no gradients, no rounded card borders
  - dividers: thin 1px horizontal rule (#D6EEFB or #29B6F6 at 30% opacity) below slide title, optional
  - bullet markers: plain solid circle, 6–7px, accent_blue; no dashes, no custom icons
  - emphasis underline on metric numbers: 2px accent-colored border-bottom, optional
  - no background images on any slide (product screenshot template excepted)
  - no decorative illustrations, icons, or clip art
```

---

## Step 5: Quality Checklist

```
[ ] Font size never goes below 10pt (caption minimum)
[ ] Maximum 6 bullet points per slide
[ ] Maximum 20 words per bullet
[ ] Maximum 4 metrics per metric-stack slide
[ ] Maximum 5 quotes per multi-quote-stack slide
[ ] Slide title is always ≤5 words (hero-identity excepted)
[ ] Background is always #FFFFFF — no colored backgrounds, no gradients
[ ] Only one accent color used per slide (blue, pink, orange, or green — not mixed)
[ ] Accent_green used only on closing/ask slide
[ ] ALL CAPS used only for short labels (1–3 words) inside structured blocks, never for full sentences
[ ] No serif fonts anywhere
[ ] No italic except inside quoted text (attribution quotes)
[ ] Whitespace ≥30% on every slide (measure as % of canvas not occupied by text/image bounding boxes)
[ ] Metric numbers are ≥2× the size of their descriptor labels
[ ] Source citations appear at caption size (10–11pt) below the metric, not inline with body text
[ ] Product screenshot occupies ≥65% of canvas height when used
[ ] No sub-bullets (max one level of nesting, and that one level should be flat bullets only)
[ ] Competitive matrix: primary brand visually distinguished from competitors (bold or accent color)
[ ] Profile grid: each person's role is accent-colored; bio is plain body text
[ ] Hero-identity slide: centered alignment only (all other templates: left-aligned)
[ ] Closing/ask slide uses accent_green for at least one metric label to signal register shift
[ ] No decorative elements: no shadows, no gradients, no border-radius cards, no icons
```

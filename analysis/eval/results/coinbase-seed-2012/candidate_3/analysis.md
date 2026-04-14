## Generative Template Extraction: Visual Design System

---

### Step 1: Template Catalog

---

```
Template: hero-with-devices
Grid:
  - Zone A: top-left 40% width, top 35% height → brand logo + tagline (stacked)
  - Zone B: right 60% width, full height OR centered lower 65% → 3 device mockups
    at varying scales (desktop largest, phone mid, tablet smallest), slightly overlapping
Content constraints:
  - Title: 4–6 words, 28–36pt thin sans-serif, dark gray
  - Tagline: 4–6 words, 20–24pt thin sans-serif, secondary gray
  - Visuals: exactly 3 product UI screenshots in device frames (desktop > phone > tablet)
Use when: opening a deck or re-introducing a product mid-deck
```

---

```
Template: icon-trio-statement
Grid:
  - Zone A: top-center, 10% from top → title
  - Zone B: horizontal thirds across center 60% of canvas → 3 evenly-spaced icon+label pairs
    each pair: icon top (~64×64px), label below (1–3 words)
Content constraints:
  - Title: max 6 words, 40–48pt thin sans-serif, centered
  - Icons: flat, single-color, ~64px, one per item
  - Labels: max 3 words each, 28–32pt thin sans-serif, centered under icon
  - Item count: exactly 3
  - Whitespace: 60–65% of canvas; no background fills, no borders
Use when: listing exactly 3 parallel attributes, properties, or pillars
```

---

```
Template: title-full-image
Grid:
  - Zone A: top-left, height ~12% → title
  - Zone B: remaining 85% of canvas → full-width visualization or photo
    image bleeds to left/right margins; ~16px gap below title
Content constraints:
  - Title: max 5 words, 40–48pt thin sans-serif
  - Image: fills zone B completely; must be self-explanatory (no legend text required)
  - No body text; the image carries all meaning
Use when: the slide's claim is proven by a single visual (map, chart, photo)
```

---

```
Template: title-chart-annotation
Grid:
  - Zone A: top-left, 15% height → title
  - Zone B: top-right or below title, 10% height → single key metric in large text
  - Zone C: center 70% of canvas → chart (line chart preferred)
  - Zone D: overlaid on chart peak/key point → 1 bold annotation label
Content constraints:
  - Title: max 4 words, 40–48pt thin sans-serif
  - Key metric: max 8 words, 20–24pt, bold, dark gray
  - Chart: single series, clean axes, no grid lines OR very light grid
  - Annotation: max 5 words + number, 18–22pt bold, placed at chart's most dramatic point
  - No more than 1 annotation per chart
Use when: showing a trend, growth curve, or time-series with a notable number to call out
```

---

```
Template: typographic-cloud
Grid:
  - Zone A: top-center, 12% height → short title
  - Zone B: remaining 80% of canvas → word/phrase cloud arranged organically
    words fill space without strict grid alignment; 3 visual weight levels
Content constraints:
  - Title: max 3 words, 40–48pt thin sans-serif
  - Cloud items: 8–12 items, no icons
  - Large words: 28–32pt, #333333
  - Medium words: 22–26pt, #555555
  - Small words: 16–18pt, #888888
  - No bullets, no borders, no lines
Use when: showing the breadth of a category without ranking; conveying variety and density
```

---

```
Template: two-column-contrast
Grid:
  - Zone A: top-center, 12% height → title
  - Zone B: left 48%, below title → column label + screenshot/UI image (negative/old state)
  - Zone C: right 48%, below title → column label + screenshot/UI image (positive/new state)
  - Gutter: 4% between columns
Content constraints:
  - Title: max 5 words, 40–48pt thin sans-serif
  - Column labels: max 2 words, 20–24pt, left=#888888 (muted), right=#4A90D9 (accent)
  - Each column: 1 screenshot or UI mockup, device-framed if applicable
  - No body copy; columns are entirely visual
Use when: showing a before/after, old/new, or competitor vs. product contrast
```

---

```
Template: centered-analogy
Grid:
  - Zone A: center of canvas, vertically and horizontally → single line or 2-line text block
Content constraints:
  - Total words: max 10
  - Typography: 48–60pt thin sans-serif, centered, generous line-height
  - Two-tone coloring:
      - Primary noun (the thing being introduced): #2E3A5F (navy)
      - Secondary / reference noun: #888888 (muted gray)
      - Structural punctuation (colon, double-colon): #888888
  - No background shapes, no icons, no images
  - Whitespace: 70–80% of canvas
Use when: making a positioning statement via analogy or equivalence; maximum cognitive impact
```

---

```
Template: closing-contact
Grid:
  - Zone A: center-top 60% of canvas → logo + tagline (centered, stacked)
  - Zone B: optional center-right 40% → small scatter plot or data visualization
  - Zone C: full-width horizontal banner, bottom 12% of canvas → contact URL or handle
    banner background: #4A90D9 (accent blue) or #D9534F (red — use once per deck max)
    text: white, 24–28pt, centered
Content constraints:
  - Logo: sized to ~180–220px wide
  - Tagline: max 5 words, 20–24pt thin sans-serif, #555555
  - Optional chart: max 30% of canvas, no title, no axis labels
  - Contact: 1 URL or handle, no other copy
Use when: final slide; must work as a business card — logo + tagline + contact
```

---

### Step 2: Sequencing Grammar

```
PRESENTATION   := OPENING BODY+ CLOSING

OPENING        := hero-with-devices

BODY           := CONTEXT_SECTION+ PROBLEM_SECTION SOLUTION_SECTION POSITIONING TRACTION_SECTION+

CONTEXT_SECTION := icon-trio-statement
                 | title-full-image
                 | title-chart-annotation
                 | typographic-cloud

PROBLEM_SECTION := two-column-contrast
                   -- always exactly ONE; always a contrast (old vs. new, bad vs. good)

SOLUTION_SECTION := hero-with-devices
                    -- same template as OPENING; deliberate echo = product re-introduction after problem

POSITIONING    := centered-analogy
                  -- always exactly ONE; always placed immediately after solution re-introduction
                  -- maximum whitespace moment; deck's quietest slide

TRACTION_SECTION := title-chart-annotation (×N, N ≥ 2)
                    -- each shows a different metric; placed after positioning, before close

CLOSING        := closing-contact
```

**Structural principle:** The deck oscillates between high-density (hero, charts, contrast) and low-density (icon-trio, analogy, cloud) slides. Never place two high-complexity slides consecutively. After each data-heavy or screenshot-heavy slide, insert a typographic or whitespace-dominant slide to give the eye a rest.

---

### Step 3: Content Transformation Rules

**Headline rule:**
Headlines are noun-phrase labels, not action sentences or questions. They name the subject of the slide rather than argue a point. Max 6 words. Never use a verb. Exception: problem slides may use a gerund phrase ("Too Difficult to Use") — the title names the friction, not the solution.

**Visual selection rule:**

| Content type | Visual type |
|---|---|
| Enumerated list of ≤3 parallel attributes | icon-trio (icons replace bullets entirely) |
| A trend over time | single-series line chart |
| Breadth/variety without ranking | typographic word cloud |
| Old state vs. new state | two-column screenshot contrast |
| A single comparison or equivalence | centered-analogy text only |
| Geographic or systemic spread | full-bleed image (map/diagram) |
| Product experience | device-framed screenshot mockup |

**Density rule:**
- 0 slides have more than 3 bullet points
- 0 slides have prose paragraphs
- Charts carry numeric claims; slides carry at most 1 annotation (a single number or phrase) atop the chart
- If there are more than 3 supporting points, use the typographic-cloud template, not a bullet list

**Emphasis rule:**
One emphasis technique per slide maximum. Priority order:
1. Size (the single largest element on the slide carries the message)
2. Color (accent blue `#4A90D9` applied to exactly the one term that matters)
3. Position (top-left anchors the reading path; place the most important element there)
4. Two-tone text (in analogy or centered-statement templates, dark navy vs. muted gray creates emphasis without size change)

Bolding is used only for chart annotations, not for running text. Italics: never used.

---

### Step 4: Style Constants

```yaml
canvas:
  width: 1280px
  height: 720px
  aspect_ratio: "16:9"

margins:
  top: 60px
  bottom: 60px
  left: 80px
  right: 80px
  content_width: 1120px
  content_height: 600px

typography:
  primary_font: "Helvetica Neue"
  fallbacks: ["Arial", "sans-serif"]
  default_weight: 300          # Thin/Light is the default weight; use it everywhere
  emphasis_weight: 700         # Bold used only for chart annotations and contact banner
  sizes:
    display_title: "52–60pt"   # Hero opening title only
    slide_title: "40–48pt"     # All other slide titles
    large_label: "28–36pt"     # Icon trio labels, analogy body text
    body_text: "20–24pt"       # Chart annotations, column labels, taglines
    small_label: "14–18pt"     # Chart axis labels, word-cloud small tier
  line_height: 1.3
  letter_spacing: "-0.02em"
  alignment: "left for titles; center for icon-trio, analogy, closing"

colors:
  background: "#E8ECF0"        # Warm light gray — used on ALL slides; never deviate
  navy: "#2E3A5F"              # Primary emphasis noun in analogy/positioning slides
  blue_dark: "#2E6DB4"         # Section labels, column accent labels
  blue_accent: "#4A90D9"       # Charts, icon colors, banner background, highlight term
  text_primary: "#333333"      # Titles and primary body text
  text_secondary: "#555555"    # Taglines, word-cloud large tier
  text_muted: "#888888"        # Muted column labels, chart axes, word-cloud small tier
  white: "#FFFFFF"             # Inside product UI mockup frames only; never as slide bg
  red_accent: "#D9534F"        # Closing banner only; max 1 use per deck

decorative:
  shadows: "subtle drop-shadow (rgba 0,0,0,0.15) on device mockup frames only"
  borders: none
  cards: none
  background_shapes: none
  chart_line: "#4A90D9, 2–3px stroke"
  chart_area_fill: "#4A90D9 at 20% opacity"
  icon_style: "flat, single-color (#2E6DB4 or #4A90D9), ~64px, no outlines"
  closing_banner: "full-width strip, height 64–72px, background #4A90D9 or #D9534F"

spacing:
  between_title_and_content: "24–32px"
  between_icon_and_label: "12px"
  between_columns_in_contrast: "40px gutter"
  chart_padding: "16px inset from content area edges"
  base_unit: "8px"
```

---

### Step 5: Quality Checklist

```
[ ] Background is #E8ECF0 on every single slide — no exceptions
[ ] Primary font weight is 300 (thin/light) for all titles and body text
[ ] Font size never goes below 14pt on any slide
[ ] Slide title is max 6 words; no verbs except gerund phrases on problem slides
[ ] Whitespace is at minimum 20% of canvas area on every slide
[ ] No slide has more than 3 bullet points — if content requires more, use word-cloud template
[ ] No slide has prose sentences (subject + verb + object constructions in body text)
[ ] Charts have at most 1 annotation label overlaid on the chart area
[ ] Accent blue (#4A90D9) applied to at most 2 distinct elements per slide
[ ] Red (#D9534F) appears at most once in the entire deck (closing banner)
[ ] Device mockups are always in rendered device frames (browser chrome or phone bezel)
[ ] Icon-trio template always uses exactly 3 items — never 2, never 4
[ ] Analogy / centered-statement template has 70%+ whitespace; no images, no icons
[ ] Two-column contrast: left column label is muted (#888888), right is accent (#4A90D9)
[ ] Closing slide has exactly: logo + tagline + 1 contact handle + full-width banner
[ ] High-complexity and low-complexity slides strictly alternate — no two high-complexity slides in sequence
[ ] No italic text anywhere in the deck
[ ] No decorative borders, card backgrounds, or geometric shapes used as decoration
[ ] Every chart uses a single data series; multi-series charts are not part of this style
[ ] Font picker: only Helvetica Neue (or Arial fallback) — no display, serif, or monospace fonts
```

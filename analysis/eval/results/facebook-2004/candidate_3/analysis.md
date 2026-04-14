Now I have all 20 slides. Let me produce the complete design system document.

---

## Visual Design System — Generative Template Extraction

---

### Step 1: Template Catalog

---

**Template: `centered-quote`**
```
Grid:
  - Zone A: top-right corner → brand logo mark, 14pt bold sans
  - Zone B: vertical center, horizontal center (40% width) → attribution line
  - Zone C: 8px below Zone B → quote body text, centered
  - Zone D: 24px below Zone C → closing quotation mark glyph, large (~40pt)
Content constraints:
  - Attribution: 1 line, italic, preceded by a ~100px horizontal rule left of text
  - Quote: max 40 words, normal weight, ~20pt, centered, line-height 1.6
  - No title. No bullets. No visual elements.
Use when: third-party validation, testimony, interstitial credibility beat
```

---

**Template: `title-body-prose`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: top-center, y=80px → title, centered
  - Zone C: y=180px, x=80px–944px → body prose, left-aligned
Content constraints:
  - Title: max 8 words, 30pt normal weight
  - Body: max 65 words, 17pt, line-height 1.7, no bullets
  - No visual elements
Use when: single expository paragraph introducing a concept or stating a fact
```

---

**Template: `title-bullets`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: top-center, y=80px → title, centered
  - Zone C: y=190px, x=80px → bulleted list, left-aligned
Content constraints:
  - Title: max 8 words, 30pt normal weight
  - Bullets: max 4 items × max 20 words each; bullet marker is solid round dot
  - No visual elements
Use when: enumerable items that don't benefit from visual/chart representation
```

---

**Template: `title-subtitle-two-column`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: top-center, y=60px → primary title, 30pt centered
  - Zone C: y=110px, center → secondary label, 20pt italic centered
  - Zone D: y=200px, x=40px, w=45% → left prose or lead-in sentence, bold
  - Zone E: y=200px, x=52%, w=45% → numbered list (1. Label: italic detail)
  - Zone F: bottom strip, y=660px, full width → footnote prose, 12pt centered
Content constraints:
  - Primary title: max 4 words
  - Secondary label: max 4 words, italic
  - Left block: max 25 words, bold
  - Right list: max 3 numbered items, each with bold label + italic description
  - Footnote: max 30 words
Use when: split explanation — context left, enumerated examples right
```

---

**Template: `text-icon-split`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: top-center, y=60px → title, centered, 30pt
  - Zone C: y=160px, x=40px, w=42% → prose paragraphs, left-aligned, 17pt
  - Zone D: y=140px, x=52%, w=44% → outlined rectangle frame containing white-line icon/image
Content constraints:
  - Title: max 6 words
  - Prose: max 60 words, 1–2 paragraphs
  - Visual frame: 1px white border, no fill, corners square; icon inside is white outline only
Use when: concept described in text with a supporting icon/screenshot/diagram
```

---

**Template: `full-bleed-overlay`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: vertical center, x=40px–960px → prose, centered, 17pt
Content constraints:
  - Background: full-bleed photo with dark overlay (blue-black tint, 60% opacity)
  - Text: max 50 words, centered, no title
  - No icons, no bullets
Use when: atmospheric transition — prose that benefits from a sense of place/scale
```

---

**Template: `ghost-icon-with-title-body`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: center of slide → large ghost icon (300–400px, 12–15% opacity white)
  - Zone C: y=100px, center → title, 30pt normal, centered, above ghost icon
  - Zone D: y=220px, x=40px, w=880px → prose, left-aligned, 17pt
Content constraints:
  - Title: max 8 words; may use format "Label - *Italic Phrase*"
  - Body: max 40 words
  - Ghost icon: semantically related, white outline, no fill, very low opacity
Use when: forward-looking or aspirational statement, section preview, milestone announcement
```

---

**Template: `section-divider`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: vertical center, horizontal center → ghost icon (400px, 15% opacity)
  - Zone C: overlaid on Zone B, vertical center → title text, 32pt, centered
Content constraints:
  - Title: max 8 words; format "Category - *Subcategory*" with italic after dash
  - No body text. No bullets. Icon is decorative only.
Use when: major section transition
```

---

**Template: `data-table`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: y=50px, center → title, 28pt, centered
  - Zone C: y=120px, x=40px, w=940px → full-width table
Content constraints:
  - Table: max 4 columns, max 12 rows
  - Header row: light blue tint fill (#C8DCF0), 15pt bold, no borders except bottom rule
  - Data rows: transparent background (blue shows through), 15pt normal, horizontal rule between rows
  - Column pairs: repeated structure (key col + value col) × 2 for space efficiency
Use when: structured reference data with two parallel categories
```

---

**Template: `chart-centered`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: y=40px, center → title, 26pt, centered
  - Zone C: y=80px, center → bold metric headline, 18pt bold, centered
  - Zone D: y=150px, center, 50% of canvas height → chart (pie or bar)
  - Zone E: bottom strip, y=680px, center → source attribution, 12pt italic
Content constraints:
  - Title: max 5 words
  - Headline metric: one bold number or percentage, max 5 words total
  - Chart: monochromatic — white and light blue fills only; no legend box; external callout labels
  - Source note: max 8 words, italic
Use when: single data visualization is the primary message
```

---

**Template: `metric-icon-grid`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: y=40px, center → title, 26pt, centered
  - Zone C: y=80px, center → bold metric headline, 18pt bold, centered
  - Zone D: y=160px → three equal-width icon cards in a horizontal row
    Each card: 1px white outlined rectangle, white-line icon (~120px), label 14pt, bold value 18pt
Content constraints:
  - Exactly 3 cards
  - Each card: icon + 1-line label + 1 bold number/percentage
  - Cards are equal width, equal spacing, x-centered
Use when: presenting 3 parallel metrics with equal emphasis
```

---

**Template: `two-column-bullets`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: y=40px, center → title, bold, 26pt, centered
  - Zone C: y=90px, center → intro sentence, 17pt, centered
  - Zone D: y=200px, x=40px, w=44% → left bullet column
  - Zone E: y=200px, x=52%, w=44% → right bullet column
Content constraints:
  - Title: max 5 words, bold
  - Intro: max 20 words, centered
  - Each column: max 8 bullets × max 4 words each
  - No nested bullets
Use when: long enumerable list that needs two columns to avoid density
```

---

**Template: `contact-split`**
```
Grid:
  - Zone A: top-right → brand logo
  - Zone B: y=70px, center → title, 28pt, centered
  - Zone C: y=180px, x=40px, w=44% → prose paragraphs, 17pt, left-aligned
  - Zone D: y=180px, x=55%, w=35% → circular portrait (180px diameter) + bold name + role/detail below
Content constraints:
  - Title: max 3 words
  - Left prose: max 50 words
  - Portrait: circular crop; name bold 16pt; role/detail normal 14pt; all centered under portrait
Use when: closing slide with a human contact point
```

---

### Step 2: Sequencing Grammar

```
PRESENTATION := OPENING BODY CLOSING

OPENING := centered-quote
  # Lead with external validation before any first-party claim

BODY := SECTION+

SECTION :=
  ghost-icon-with-title-body           # Section intro: declare the topic with atmosphere
  DETAIL_SLIDES+
  [centered-quote]?                    # Optional interstitial quote for pacing/credibility

DETAIL_SLIDES :=
    title-body-prose
  | title-bullets
  | title-subtitle-two-column
  | text-icon-split
  | full-bleed-overlay                 # Used at most once; high visual impact break
  | data-table
  | chart-centered
  | metric-icon-grid
  | two-column-bullets
  | section-divider                    # Major sub-section pivot within a section

CLOSING :=
  contact-split
  | centered-quote                     # End on third-party voice for final impression
```

---

### Step 3: Content Transformation Rules

**Headline rule:**
Titles are noun phrases or label statements, not action verbs or questions. Format: `"Topic - *Descriptive Phrase*"` (regular font + italic after dash) for section-level slides. Plain noun phrase for detail slides. The key proper noun or brand term in body text receives a dotted underline — never bold — on first occurrence.

**Visual selection rule:**
- Single proportional breakdown → `chart-centered` (pie only; monochromatic)
- Exactly 3 parallel metrics with numbers → `metric-icon-grid`
- Structured lookup data (key-value pairs) → `data-table`
- Concept needing illustrative icon → `text-icon-split`
- Enumerable list >8 items → `two-column-bullets`
- Enumerable list ≤4 items → `title-bullets`
- Narrative prose, no list structure → `title-body-prose`
- Emotional/atmospheric beat → `full-bleed-overlay` or `centered-quote`

**Density rule:**
Prose slides carry up to 65 words. Nothing goes to notes — density is managed by limiting slides to one idea only, not by compressing multiple ideas onto one slide. Numbers that appear inline in prose are bolded; all other inline emphasis is avoided.

**Emphasis rule:**
Bold weight is the sole inline emphasis tool. Applied to: standalone metric headlines (one per slide, placed between title and chart/body), key figures embedded in prose, column headers in tables. Italic is used structurally — title suffixes, quote attributions — never for emphasis within body text.

---

### Step 4: Style Constants

```yaml
canvas:
  width: 1024px
  height: 768px
  aspect_ratio: "4:3"

margins:
  top: 80px        # first content element (title) baseline
  bottom: 60px
  left: 80px
  right: 80px
  logo_top: 20px
  logo_right: 24px

typography:
  fonts:
    primary: "Arial, Helvetica, sans-serif"   # all text
    logo: "Arial Black, Impact, sans-serif"   # brand mark only
  sizes:
    logo_mark: 14pt
    title_normal: 30pt
    title_bold: 28pt
    section_subtitle: 20pt
    metric_headline: 18pt
    body_prose: 17pt
    bullets: 17pt
    table_header: 15pt
    table_data: 15pt
    caption_footnote: 12pt
    quote_body: 20pt
    quote_attribution: 17pt
    closing_quotation_mark: 42pt
  weights:
    title: 400           # normal — not bold by default
    title_bold_variant: 700
    body: 400
    emphasis_inline: 700
    logo: 700
  line_height: 1.7
  letter_spacing: 0
  alignment:
    title: center
    body: left
    quote: center
    metric_headline: center

colors:
  background: "#4A6FA5"          # blue-periwinkle, consistent on all non-photo slides
  text_primary: "#FFFFFF"         # all text, all contexts
  text_secondary: "#FFFFFF"       # same — no secondary text color
  table_header_fill: "#C8DCF0"    # pale blue, header row only
  table_header_text: "#2C3E6A"    # dark blue text in header
  chart_fill_primary: "#FFFFFF"   # dominant pie/bar segment
  chart_fill_secondary: "#87CEEB" # minor segments
  ghost_icon: "rgba(255,255,255,0.13)"   # watermark icons
  grid_line: "rgba(255,255,255,0.15)"    # blueprint grid
  icon_stroke: "#FFFFFF"          # outline icons in cards/panels
  panel_border: "rgba(255,255,255,0.50)" # outlined rectangle frames
  horizontal_rule: "rgba(255,255,255,0.60)"  # before quote attributions

decorative:
  blueprint_grid:
    type: crosshatch
    cell_size: 70px
    line_color: "rgba(255,255,255,0.15)"
    line_width: 1px
    coverage: full_slide
  ghost_icon:
    size: 300–400px
    opacity: 0.13
    style: white outline, no fill
    position: center of slide, behind text
  panel_frame:
    border: "1px solid rgba(255,255,255,0.50)"
    background: transparent
    padding: 16px
  portrait_crop:
    shape: circle
    diameter: 180px
    border: none
  dotted_underline:
    style: "2px dotted rgba(255,255,255,0.70)"
    applied_to: brand name on first mention per slide only
  quote_horizontal_rule:
    width: 100px
    height: 1px
    color: "rgba(255,255,255,0.60)"
    position: inline-left of attribution, ~12px gap
```

---

### Step 5: Quality Checklist

```
[ ] Canvas is exactly 1024×768px (4:3)
[ ] Background is #4A6FA5 on every slide except full-bleed-overlay
[ ] Blueprint grid (crosshatch, 70px cells, 15% white opacity) is present on every slide
[ ] Brand logo "[thefacebook]" appears top-right, 14pt bold, 20px from top, 24px from right
[ ] All text is #FFFFFF — no exceptions
[ ] Title font size is 28–30pt, weight 400 (normal), centered
[ ] Bold title variant (weight 700) used only on detail slides, never section intros
[ ] Body text is 17pt, line-height 1.7, left-aligned at x=80px
[ ] Max 65 words of body text on any prose slide
[ ] Max 4 bullet points per slide
[ ] Max 40 words on quote slides
[ ] Section-divider slides carry max 8 words total (title only)
[ ] Ghost icon present on ghost-icon-with-title-body and section-divider templates
[ ] Ghost icon opacity does not exceed 15%
[ ] Inline bold used only for numbers/key metrics embedded in prose, or metric headlines
[ ] Italic used only for: title suffix after dash, quote attribution — never inline emphasis
[ ] Brand name in body text uses dotted underline, not bold
[ ] No color other than white, blue-family, or #C8DCF0 (table headers) appears anywhere
[ ] Pie/bar charts use only white and #87CEEB fills — no color-coded categories
[ ] Chart labels are external callouts — no legend boxes
[ ] Icon panels use 1px white border frame, white outline icons, no fill
[ ] Portrait photos are circular crop only
[ ] Metric headline (bold, centered, between title and chart) present on every data slide
[ ] Source attribution on data slides is 12pt italic, bottom-centered
[ ] Horizontal rule precedes quote attribution on all centered-quote slides
[ ] Closing quotation mark glyph (~42pt) appears at bottom of every centered-quote slide
[ ] No drop shadows on any element
[ ] No rounded corners except circular portrait crops
[ ] No gradient backgrounds (flat color only, photo overlay excluded)
[ ] No left-aligned titles
[ ] No axis labels or grid lines inside charts
[ ] No colored text for emphasis — bold weight only
[ ] Accent color (#C8DCF0 table header tint) appears on at most 1 element per slide
```

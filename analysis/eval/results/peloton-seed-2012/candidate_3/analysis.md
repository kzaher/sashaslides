## Generative Template Extraction: Visual Design System

---

### Step 1: Template Catalog

---

**Template: `full-bleed-cover`**
```
Grid:
  - Zone A: full canvas → full-bleed photography (dark, moody, high-contrast)
  - Zone B: center → large logotype / brand mark in white
Content constraints:
  - Brand mark: 1–3 words, all-caps bold sans-serif, 72–96pt, white
  - No body text
  - Visual: full-bleed photo, darkened via overlay (~40% black), fills 100% canvas
Use when: opening a deck; establishing brand identity before any argument begins
```

---

**Template: `split-photo-toc`**
```
Grid:
  - Zone A: left 45% → full-height lifestyle photography, high drama, accent-lit
  - Zone B: right 55% → white background; section list top-aligned
Content constraints:
  - Section title: 1 word or short phrase, bold italic all-caps, 36–44pt, accent color
  - List items: numbered, 3–5 items max, 28–32pt regular sans-serif, dark text
  - No icons, no sub-bullets
Use when: navigational / table-of-contents moment at the start of a major division
```

---

**Template: `dark-two-column-table`**
```
Grid:
  - Zone A: top → slide title, left-aligned
  - Zone B: left 50% → column 1 with header + bullet list
  - Zone C: right 50% → column 2 with header + bullet list
Content constraints:
  - Title: ≤10 words, bold uppercase, 32–36pt, white
  - Column headers: bold uppercase, 18–22pt, accent color (#F44060)
  - Body bullets: 4–8 per column, 16–18pt, light gray (#CCCCCC)
  - Background: near-black (#1A1A1A)
  - Vertical divider: 1px white/30% opacity between columns
Use when: presenting two parallel attribute sets, segmentation data, or dual-axis frameworks
```

---

**Template: `photo-overlay-three-pillar`**
```
Grid:
  - Zone A: full canvas → lifestyle photography, darkened overlay
  - Zone B: distributed across photo → 3 floating circular icon badges, evenly spaced
  - Zone C: each badge → label above, body text below
Content constraints:
  - Title: bold italic all-caps, 36pt, white, top-left anchored
  - Badges: red circles (#F44060), 120–160px diameter, icon centered
  - Badge labels: bold uppercase, 14pt, white
  - Badge body: regular, 11–13pt, white, max 30 words each
  - Max 3 pillars per slide
Use when: presenting three parallel benefits, promises, or feature categories
```

---

**Template: `white-value-grid`**
```
Grid:
  - Zone A: top → slide title, left-aligned
  - Zone B: 2×3 grid → 6 value cells, equal spacing
Content constraints:
  - Title: bold italic all-caps, 32–36pt, accent color (#F44060)
  - Cell headers: bold, 18–20pt, black (#1A1A1A)
  - Cell descriptions: regular, 14–15pt, medium gray (#555555)
  - Background: white (#FFFFFF)
  - Max 6 cells; each description ≤20 words
  - No borders; whitespace separates cells
Use when: presenting 4–6 parallel named attributes (values, principles, traits)
```

---

**Template: `dark-two-column-comparison`**
```
Grid:
  - Zone A: top → slide title
  - Zone B: left 50% → "positive" list
  - Zone C: right 50% → "negative/contrast" list with strikethrough styling
Content constraints:
  - Title: bold italic all-caps, 32pt, white
  - Left header: bold uppercase, 18pt, white
  - Right header: bold uppercase, 18pt, accent color (#F44060)
  - List items: regular, 15–16pt, white; right column uses CSS text-decoration: line-through
  - 8–14 items per column
  - Background: near-black (#1A1A1A)
Use when: defining brand identity via explicit inclusions and exclusions
```

---

**Template: `white-icon-row`**
```
Grid:
  - Zone A: top → slide title
  - Zone B: 4-column row → circular icon + label pairs, centered
Content constraints:
  - Title: bold italic all-caps, 32pt, black, left-aligned
  - Icons: red circles (#F44060), 100–130px diameter, simple line icon centered
  - Labels: regular sans-serif, 14–16pt, dark gray, centered below each icon
  - Max 4 icons per row
  - Background: white; abundant whitespace (≥50% of canvas)
Use when: presenting anti-patterns, prohibitions, or negatively-framed rules
```

---

**Template: `radial-diagram`**
```
Grid:
  - Zone A: top-left → slide title
  - Zone B: center → concentric circle diagram filling ~70% of canvas width
Content constraints:
  - Title: bold uppercase, 28–32pt, either black (light bg) or white (dark bg)
  - Center circle: accent color fill (#F44060), 1–5 words, bold white
  - Inner ring: divided into 4–8 labeled segments, pale pink (#D4A0A0) fill
  - Outer ring: divided into 4 quadrant groups, white or light fill
  - Text: small caps, 9–11pt, dark gray
  - Background: white (#FFFFFF)
Use when: showing a multi-layer conceptual framework or brand architecture
```

---

**Template: `dark-timeline-scatterplot`**
```
Grid:
  - Zone A: top → slide title
  - Zone B: main area → XY axis with labeled data points along X; circular image thumbnails at each point
Content constraints:
  - Title: bold italic all-caps, 32pt, white
  - Axes: thin white lines, labeled at ends; Y = qualitative spectrum, X = time or category
  - Data labels: bold, 12–14pt, accent color (#F44060)
  - Thumbnails: circular crop, 80–100px diameter
  - Background: near-black (#1A1A1A)
  - Max 5 data points
Use when: showing evolution, shift, or progression over time
```

---

**Template: `full-bleed-callout`**
```
Grid:
  - Zone A: full canvas → lifestyle/product photography (full bleed)
  - Zone B: left or right 35% → large red circle callout bubble
  - Zone C: inside callout → headline + body explanation
Content constraints:
  - Photo: no overlay needed; callout provides contrast
  - Callout circle: #F44060, diameter 280–340px
  - Callout headline: bold uppercase, 18–22pt, white, centered
  - Callout body: regular, 13–15pt, white, max 40 words
  - Brand mark: top-left corner, white, 14pt
Use when: associating a specific brand quality with a visual proof point
```

---

**Template: `dark-press-quote-grid`**
```
Grid:
  - Zone A: top → slide title
  - Zone B: 2×2 grid → four quote blocks, equal cells
Content constraints:
  - Title: bold italic all-caps, 32–36pt, accent color (#F44060)
  - Source labels: bold uppercase, 13pt, #F44060
  - Quote text: regular, 15–17pt, white, max 20 words per quote
  - Dividers: 1px white/20% opacity between cells
  - Background: near-black (#1A1A1A)
  - Max 4 quotes
Use when: establishing third-party credibility via press or external validation
```

---

**Template: `white-testimonial-split`**
```
Grid:
  - Zone A: top → slide title
  - Zone B: two equal columns → one testimonial block each
Content constraints:
  - Title: bold italic all-caps, 32pt, accent color (#F44060)
  - Review headline: bold, 16–18pt, black
  - Review body: regular, 13–14pt, medium gray (#666666), max 60 words
  - Reviewer name: bold, 12pt, #F44060
  - Decorative stars: inline, small, red
  - Background: white (#FFFFFF)
Use when: presenting peer-validation via user or customer voices (positive framing)
```

---

**Template: `dark-single-testimonial`**
```
Grid:
  - Zone A: center → one testimonial block, horizontally centered
  - Zone B: decorative → large star shapes in corners or flanking text
Content constraints:
  - Review headline: bold uppercase, 20–24pt, white
  - Review body: regular, 15–17pt, white, max 80 words
  - Reviewer name: bold, 13pt, #F44060
  - Stars: large decorative shapes, #F44060 or white, non-functional
  - Background: near-black (#1A1A1A)
  - Abundant vertical whitespace (≥30%)
Use when: giving a single testimonial maximal weight and emphasis
```

---

### Step 2: Sequencing Grammar

```
PRESENTATION := OPENING NAVIGATION BODY CLOSING

OPENING := full-bleed-cover

NAVIGATION := split-photo-toc

BODY := SECTION+

SECTION :=
    radial-diagram(highlight=[section-attribute])   // transitions into section via framework callout
    SECTION_CONTENT+

SECTION_CONTENT :=
    full-bleed-callout                              // visual proof of attribute
  | dark-two-column-table                           // structured segmentation data
  | white-value-grid                                // named parallel attributes
  | dark-two-column-comparison                      // identity definition via contrast
  | white-icon-row                                  // anti-pattern declaration
  | dark-timeline-scatterplot                       // evolution or progression
  | dark-press-quote-grid                           // third-party credibility burst
  | white-testimonial-split | dark-single-testimonial  // social proof

CLOSING := full-bleed-callout                       // ends on a brand attribute + visual, not a summary slide
```

**Key structural rules:**
- Every section opens with a reference back to the overall framework (the `radial-diagram` with one quadrant highlighted), then dives into proof.
- Proof sequence within a section: first qualitative/emotional (`full-bleed-callout`), then external validation (`dark-press-quote-grid` or `testimonials`).
- No explicit summary or "thank you" slide. The deck ends mid-argument — on a powerful single image.
- The framework diagram recurs as a navigational device, not as content.

---

### Step 3: Content Transformation Rules

**Headline rule:**
Raw content → bold italic uppercase declarative phrase. Not a question, not a label. Frames the slide as an assertion. 4–8 words max. On dark backgrounds: white. On white backgrounds: accent red (#F44060). Never sentence case.

**Visual selection rule:**
- Named attributes with definitions → `white-value-grid` (the grid IS the visual)
- Parallel benefits or promises → `photo-overlay-three-pillar`
- Inclusions vs. exclusions → `dark-two-column-comparison`
- Rules that must never be broken → `white-icon-row`
- Multi-layer conceptual model → `radial-diagram`
- Directional shift over time → `dark-timeline-scatterplot`
- Brand quality + visual proof → `full-bleed-callout`
- External validation → `dark-press-quote-grid`
- Peer voice → `white-testimonial-split` or `dark-single-testimonial`

**Density rule:**
The slide carries the assertion. All supporting detail goes to speaker notes or handout. A slide never needs to stand alone as a document — it needs to land a single point at a glance. If more than ~40 words appear on a non-table slide, reduce.

**Emphasis rule:**
Exactly one element per slide gets the accent color (#F44060) treatment. This is the most important noun, label, column header, or quote source. Everything else is white or gray. The red draws the eye first, establishing hierarchy before the viewer reads anything else.

---

### Step 4: Style Constants

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
    - family: "Helvetica Neue", Arial, sans-serif
      roles: [all text — this deck uses one typeface family throughout]
  sizes:
    cover_logotype: 72–96pt
    slide_title: 32–36pt
    section_header: 28–32pt
    column_header: 18–22pt
    body_primary: 15–18pt
    body_secondary: 13–15pt
    caption_label: 11–13pt
    diagram_label: 9–11pt
  weights:
    display: 800 (black/extrabold)
    heading: 700 (bold)
    body: 400 (regular)
  style_variants:
    titles_on_dark: bold italic uppercase
    titles_on_light: bold italic uppercase
    column_headers: bold uppercase (no italic)
    body_copy: regular (no italic, no caps)
    callout_headlines: bold uppercase (no italic)
  line_height: 1.3–1.4
  letter_spacing: titles 0.05–0.08em; body 0em

colors:
  background_dark: "#1A1A1A"      # near-black; used for ~60% of slides
  background_light: "#FFFFFF"     # pure white; used for ~40% of slides
  background_deep: "#1A0A30"      # deep purple-black; used rarely for extreme drama
  accent_primary: "#F44060"       # vivid coral-red; THE brand signal color
  accent_secondary: "#7B2FBE"     # purple; appears only in photography, not UI elements
  text_on_dark: "#FFFFFF"         # primary text on dark backgrounds
  text_secondary_dark: "#CCCCCC"  # body/supporting text on dark backgrounds
  text_on_light: "#1A1A1A"        # primary text on white backgrounds
  text_secondary_light: "#555555" # supporting text on white backgrounds
  diagram_fill_mid: "#D4A0A0"     # muted pink; diagram inner rings only
  divider: "rgba(255,255,255,0.2)" # ultra-subtle separators on dark backgrounds

decorative:
  circular_badges:
    fill: "#F44060"
    border: none
    shadow: none
    diameter: 120–340px depending on role (icon badge vs. full callout)
  photo_treatment:
    full_bleed: true
    overlay: "rgba(0,0,0,0.35–0.45)" on dark-theme slides; none on light-theme slides
    crop: rectangular for full-bleed; circular (border-radius: 50%) for timeline thumbnails
  strikethrough:
    style: CSS text-decoration: line-through
    color: inherits text color (white); no separate color
  stars_decorative:
    fill: "#F44060"
    size: 30–60px
    placement: flanking text blocks; non-functional
  dividers:
    weight: 1px
    color: rgba(255,255,255,0.2)
    style: solid
    used_for: column separation only; no horizontal rules between text blocks
  brand_mark:
    position: top-left corner
    size: ~14pt / ~28px tall
    color: white (always, regardless of background)
    present_on: photo-heavy slides only; absent from text-heavy slides
```

---

### Step 5: Quality Checklist

```
[ ] Font never goes below 11pt (diagram labels) or 13pt (body text)
[ ] Slide title never exceeds 10 words; 4–6 words is ideal
[ ] Slide title is always bold uppercase (+ italic on dark slides)
[ ] Maximum 8 bullet points on any list-based slide
[ ] Maximum 40 words total on non-table, non-list slides
[ ] Background alternates between near-black and white — no mid-tone grays
[ ] Accent color (#F44060) applied to exactly ONE element per slide (header, label, or callout)
[ ] No more than 3 colors visible on any single slide (bg + text + accent)
[ ] Full-bleed photos never have borders, drop shadows, or rounded corners (except circular crop)
[ ] Circular callout badges have no border-radius exceptions — always perfect circles
[ ] All-caps applied to: titles, column headers, callout headlines — never to body copy
[ ] Italic used only in slide titles, never in body text
[ ] No gradient fills anywhere — only flat color fills
[ ] No drop shadows on text elements
[ ] No decorative background patterns or textures (only photographic content)
[ ] Whitespace on text-heavy slides: minimum 35% of canvas area
[ ] On full-bleed-callout slides: photo fills 100% canvas; callout circle overlaps photo (no padding frame)
[ ] Timeline data points: maximum 5 nodes; circular image crops only
[ ] Value grids: always 2×N layout; never single-column list
[ ] Press quotes: always attributed with source in accent color; quote text in regular weight (not italic)
[ ] Testimonials: always include reviewer name in accent color; always include review headline in bold
[ ] Diagram slides: always white background; never dark background
[ ] Framework/radial diagram reused verbatim as navigation device — not redrawn per section
[ ] No slide ends with a "Questions?" or "Thank You" placeholder
[ ] Brand mark (if present) always top-left, always white, never resized or recolored
```

---

### Generation Notes for AI Implementors

**The single most important rule:** This style communicates through photography and space, not through text. When in doubt, reduce words and increase photo surface area. Every text element should justify its presence against the alternative of blank space.

**Background rhythm:** Alternate dark → light → dark across the deck at the section level, not the slide level. Sections that need emotional weight use dark; sections that need clarity and enumeration use light.

**The red circle is a signature element.** It appears as (a) small icon badge, (b) large callout bubble, and (c) diagram center. Using it consistently across all three scales creates visual coherence without requiring any other decorative element.

**Never use red for body text.** Accent color is reserved for: column headers, list markers (only when inline with a label), source attribution, and circular fill elements. Body copy is always white or gray.

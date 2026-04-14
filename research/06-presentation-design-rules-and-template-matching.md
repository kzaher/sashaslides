# Presentation Design Rules & Template Matching System

Two parts:
1. **Design rules** — content-to-layout mapping, visual hierarchy, cognitive load. These are the rules an LLM follows when generating slides.
2. **Template preprocessing & matching system** — how to ingest slide decks, extract structural fingerprints, and retrieve the best template for new content.

---

## Part 1: Presentation Design Rules for LLM Slide Generation

### 1.1 Hard Constraints (non-negotiable)

| Rule | Value | Source |
|------|-------|--------|
| Ideas per slide | **1** | Mayer segmenting principle |
| Max words per slide | **30** | Kawasaki / assertion-evidence research |
| Max bullet points | **6** | 6x6 rule |
| Max words per bullet | **6** | 6x6 rule |
| Min font size (body) | **24pt** | Readability at 10ft+ |
| Min font size (headline) | **28pt** | Kawasaki 10/20/30 |
| Headline max length | **2 lines, ~15 words** | McKinsey action-title standard |
| Max colors | **2-4** (primary + accent + 1-2 support) | Design systems research |
| Max fonts | **2** (heading + body) | Typography best practice |
| Max element types per slide | **2** (e.g. text + chart, NOT text + chart + image) | Cognitive load theory |
| Pie chart max slices | **5** | Perceptual accuracy drops beyond 5 |
| Bullet nesting depth | **2 levels max** | Readability |
| Minutes per slide | **1-2** | Pacing research |

### 1.2 Content-to-Layout Mapping

This is the core decision: given content, what slide type should be used?

#### Slide Functional Types

| Functional Type | Content Signal | Layout Description |
|----------------|----------------|-------------------|
| **title** | Opening slide, presentation name | Centered title (large), subtitle below, optional date/author |
| **section-divider** | Transition between major topics, "PART N" markers | Bold title centered, accent color background or divider lines, no body text |
| **assertion-evidence** | A claim backed by one visual (photo, diagram, chart) | Sentence headline (2 lines max) + single visual filling remaining space |
| **bullet-list** | 3-6 parallel items, no visual needed | Action title + 3-6 bullets, left-aligned |
| **two-column** | Comparison, before/after, pros/cons | Title + two equal columns with parallel structure |
| **data-chart** | Quantitative data, trends, distributions | Action title stating the insight + one chart (bar/line/pie/scatter) |
| **diagram** | Process, relationships, structure | Action title + one diagram (flow/hub-spoke/pillars/roadmap/cycle) |
| **image-dominant** | Concept best conveyed visually, emotional emphasis | Full-bleed or 2/3 image + minimal text overlay |
| **quote** | Authority citation, testimonial | Large quote text + attribution + optional photo |
| **table** | Structured comparison across multiple dimensions | Action title + table (max 5 cols, 7 rows) |
| **closing** | End of presentation, call to action | "Thank you" / key takeaway / contact info, centered |
| **key-takeaway** | End of section, reinforcement | Single bold statement summarizing the section |

#### Decision Tree for Layout Selection

```
INPUT: slide content (title, body text, data, images, notes)

1. Is this the first slide?
   → YES: "title"

2. Is this the last slide or contains "thank you" / "questions"?
   → YES: "closing"

3. Does it mark a new section (e.g. "PART", all-caps, no body)?
   → YES: "section-divider"

4. Does it contain structured data (numbers, percentages, time series)?
   → YES: go to CHART SELECTION (§1.3)
   → Layout: "data-chart"

5. Does it describe a process, hierarchy, or relationship structure?
   → YES: go to DIAGRAM SELECTION (§1.4)
   → Layout: "diagram"

6. Does it contain a markdown table?
   → YES: "table"

7. Does it contain a direct quote or attribution?
   → YES: "quote"

8. Does it have exactly 2 contrasting/parallel groups?
   → YES: "two-column"

9. Does body text contain 3-6 parallel items?
   → YES: "bullet-list"

10. Is there a single key insight/statement with no supporting items?
    → YES: "key-takeaway"

11. Default: "assertion-evidence" (sentence headline + best available visual)
```

### 1.3 Chart Type Selection

| Data Pattern | Chart Type | When NOT to Use |
|-------------|-----------|----------------|
| Comparison across categories | **Bar chart** (vertical/horizontal) | Not for time trends; not for < 2 categories |
| Trend over time (3+ points) | **Line chart** | Not for categorical comparison |
| Parts summing to 100% (2-5 parts) | **Pie chart** | Not for > 5 slices; not when slices are similar size |
| Correlation between 2 variables | **Scatter plot** | Not for categorical data |
| Distribution of a single variable | **Histogram** | Not for categorical data |

**Default rule**: when in doubt, use a bar chart. It is strictly more readable than pie in all cases except the simplest 2-3 slice proportions.

### 1.4 Diagram Type Selection

| Content Pattern | Diagram Type |
|----------------|-------------|
| Sequential steps, optionally with decision points | **Flow diagram** |
| Central concept with related subtopics radiating outward | **Hub-and-spoke** |
| Multiple equally-important foundations supporting a goal | **Pillar diagram** |
| Timeline with phases, milestones, or stages | **Roadmap** |
| Hierarchical org structure or taxonomy | **Tree / org chart** |
| Repeating cyclical process | **Cycle diagram** |

### 1.5 Horizontal vs Vertical Section Rules

Slides can divide their body area into **horizontal sections** (columns, side-by-side) or **vertical sections** (rows, stacked top-to-bottom). The wrong orientation makes content harder to scan.

#### When to use horizontal sections (columns)

| Pattern | Example | Why horizontal works |
|---------|---------|---------------------|
| **Comparison / contrast** | Before vs After, Plan A vs Plan B, Pros vs Cons | Eye moves left↔right to compare parallel items at the same vertical level |
| **Text + visual pairing** | Bullet points left, chart/image right | Spatial contiguity (Mayer): related text and visual are adjacent, not separated by scroll distance |
| **2-3 equal-weight items** | Three product features, three team pillars | Items are peers — horizontal arrangement signals equal importance (no "first = most important" bias) |
| **Image gallery / icon row** | Three screenshots, four team photos | Natural left-to-right scan matches reading direction |
| **Key metric + supporting detail** | Big number left, explanation right | The number grabs attention first (left-anchored), context follows naturally |

**Horizontal hard limits:**
- **Max 3 columns.** 4+ columns at 13.33" slide width leaves each column < 3" — too narrow for readable text.
- **Min column width: 3".** Below this, line breaks fragment sentences and bullet points become unreadable.
- **Columns must be equal width** unless one is intentionally dominant (e.g. 60/40 text-visual split). Unequal columns that aren't clearly intentional look like broken layout.

#### When to use vertical sections (stacked rows)

| Pattern | Example | Why vertical works |
|---------|---------|--------------------|
| **Sequential / ordered content** | Step 1 → Step 2 → Step 3, timeline top-to-bottom | Top-to-bottom order matches natural reading flow and implies sequence |
| **Hierarchical importance** | Key takeaway on top, supporting details below | Top = most important (F-pattern reading behavior). The eye hits the top row first. |
| **Title + body + footer** | Headline, then bullets, then source citation | Standard slide anatomy — audiences expect this vertical stack |
| **Dense content that needs full width** | Wide table, long bullet points, paragraph text | Each row gets the full 11"+ safe width — no cramped columns |
| **Mixed element types stacked** | Chart on top, interpretation bullets below | Each element type gets its own horizontal band with appropriate height |

**Vertical hard limits:**
- **Max 3 rows** (excluding title). More than 3 distinct horizontal bands makes the slide feel like a document page, not a slide.
- **Min row height: 1.5".** Below this, text at 24pt gets clipped or elements feel crushed.
- **Top row gets visual priority.** If one row matters most, put it on top — the eye hits it first.

#### When to use neither (single-zone layout)

| Pattern | Layout |
|---------|--------|
| Title slide | Centered single zone |
| Section divider | Centered single zone |
| Key takeaway (one bold statement) | Centered single zone |
| Full-bleed image with text overlay | Single zone (image behind, text floating) |
| Quote | Centered single zone |

**Single-zone slides have the lowest cognitive load.** Use them when the content is one idea that needs no structural subdivision.

#### Decision logic for the generator

```
1. Is content a single statement/title/quote with no subdivision?
   → single-zone (centered)

2. Does content have exactly 2 parallel groups meant for comparison?
   → horizontal (two-column)

3. Does content have 3 equal-weight peer items?
   → horizontal (three-column) IF each item fits in ≤ 3 bullet points
   → vertical (stacked) IF items are too text-heavy for columns

4. Does content have text + one visual (chart, image, diagram)?
   → horizontal (text left, visual right — or visual left for emphasis)

5. Does content have sequential/ordered items?
   → vertical (stacked rows)

6. Does content need full slide width (wide table, long bullets)?
   → vertical (stacked rows)

7. Default: vertical (title on top, body below)
   → This is the safest default because it matches reading flow
     and doesn't risk cramped columns.
```

#### Combining horizontal and vertical

Some slides legitimately have both — e.g. a title row on top (vertical section 1) with two comparison columns below (horizontal subdivision of vertical section 2). Rules for nesting:

- **Max nesting depth: 2.** Title-row + two-column-body is fine. Title-row + two-column-body where each column has sub-rows is too complex for a slide.
- **The outer structure is always vertical** (title on top, body below). Horizontal subdivision happens within a vertical row.
- **Never subdivide a column vertically AND horizontally.** If column A has sub-rows while column B doesn't, the layout feels broken.

### 1.6 Headline Rules (McKinsey Action Title Style)

Bad headlines describe topics. Good headlines state the takeaway.

| Bad (topic label) | Good (action title) |
|-------------------|---------------------|
| "Q3 Revenue Results" | "Q3 revenue grew 22% driven by enterprise expansion" |
| "Customer Feedback" | "NPS jumped 15 points after onboarding redesign" |
| "Market Overview" | "We're #3 in a market consolidating to 2 players" |
| "Next Steps" | "Ship v2 by March to capture the enterprise pipeline" |

Rules:
- **Active voice**, not passive
- **State the "so what"**, not the topic
- **Include a number** when data supports it
- **Max 15 words, max 2 lines**
- The audience should understand the slide's point from the headline alone

### 1.6 Slide Sequencing (Narrative Arc)

| Position | Slide Types | Purpose |
|----------|------------|---------|
| 1 | title | Establish topic, speaker, context |
| 2-3 | assertion-evidence, key-takeaway | **Hook** — surprising fact, bold claim, or question |
| 4-6 | bullet-list, data-chart, two-column | **Problem / Tension** — define the challenge |
| — | section-divider | Mental breathing room |
| 7-15 | assertion-evidence, diagram, data-chart, table | **Solution / Evidence** — core content |
| — | section-divider | Between major sub-topics |
| 16-18 | key-takeaway, data-chart | **Resolution** — proof it works |
| 19 | bullet-list or key-takeaway | **Call to action** — what audience should do |
| 20 | closing | Thank you / contact / Q&A |

**Transition rules:**
- Insert a **section-divider** between every major thematic shift
- End each section with a **key-takeaway** slide before the divider
- Never place two data-heavy slides (chart, table) back-to-back — interleave with assertion or bullet

### 1.7 Cognitive Load Principles (Mayer)

These are the rules that override aesthetic preferences when they conflict:

1. **Multimedia**: words + pictures > words alone. Every key claim gets a visual.
2. **Coherence**: remove anything that doesn't serve the point. No decorative clip art.
3. **Signaling**: use bold, color, arrows to direct attention to what matters.
4. **Redundancy**: do NOT put on screen the exact text the speaker says aloud. Slides complement speech, they don't duplicate it.
5. **Spatial contiguity**: related text and visuals must be physically close on the slide.
6. **Segmenting**: break complex content into smaller slides rather than cramming.
7. **Pre-training**: introduce key terms/concepts before the complex slide that uses them.

### 1.8 Visual Design Constraints

**Alignment grid**: Rule of Thirds (3x3 grid). Place key elements at intersection points.

**Whitespace**: use it to isolate and emphasize. When choosing between adding content and preserving whitespace, preserve whitespace.

**Color usage**:
- One primary color for structure (headings, borders)
- One accent color for emphasis (key numbers, highlights)
- Neutral colors for body text (dark gray, not pure black)
- High contrast between text and background is the #1 readability factor

**Font pairing**:
- Sans-serif for body (readability on screen)
- Heading font can be decorative/serif if it matches the template style
- Never mix more than 2 font families

---

## Part 2: Template Preprocessing & Matching System

### 2.1 System Overview

```
                    PREPROCESSING (offline, per template deck)
                    ==========================================

  Template PPTX/HTML ──→ Slide Extractor ──→ Per-Slide Analysis ──→ Template Index
                              │                      │                    │
                              ▼                      ▼                    ▼
                         Raw elements          Fingerprint per       JSON index file
                         (text, images,        slide: functional     searchable by
                          shapes, tables,      type, element          functional type,
                          charts, layout)      composition,           element composition,
                                               spatial layout,        keyword tags
                                               color palette,
                                               text density


                    MATCHING (runtime, per new slide)
                    ==================================

  New slide content ──→ Content Analyzer ──→ Query Builder ──→ Index Search ──→ Top-K Templates
        │                      │                   │                │                │
        ▼                      ▼                   ▼                ▼                ▼
   Markdown or           Detect functional    Build search       Score against     Return ranked
   structured input      type, count          vector:            all indexed       template slides
                         elements, extract    [type, elements,   slides using      with scores
                         keywords             density, tags]     weighted match
```

### 2.2 Template Preprocessing Pipeline

#### Step 1: Slide Extraction

For each slide in a template deck, extract raw elements:

```typescript
interface ExtractedSlide {
  deckId: string;              // source deck identifier
  slideIndex: number;          // position in deck
  thumbnail: string;           // path to rendered PNG thumbnail

  // Raw elements
  elements: {
    textBoxes: {
      text: string;
      bounds: { x: number; y: number; w: number; h: number }; // inches
      fontSize: number;        // pt
      fontFamily: string;
      fontWeight: "normal" | "bold";
      color: string;           // hex
      role: "title" | "subtitle" | "body" | "label" | "caption";
    }[];
    images: {
      bounds: { x: number; y: number; w: number; h: number };
      areaRatio: number;       // image area / slide area
      altText?: string;
    }[];
    shapes: {
      type: string;            // "rect", "roundRect", "ellipse", "line", "arrow", etc.
      bounds: { x: number; y: number; w: number; h: number };
      fill?: string;
      stroke?: string;
    }[];
    tables: {
      rows: number;
      cols: number;
      bounds: { x: number; y: number; w: number; h: number };
    }[];
    charts: {
      chartType: "bar" | "line" | "pie" | "scatter" | "area";
      bounds: { x: number; y: number; w: number; h: number };
      dataPointCount: number;
    }[];
  };

  // Background
  background: {
    type: "solid" | "image" | "gradient";
    dominantColor: string;
    hasBackgroundImage: boolean;
  };

  // Speaker notes (may contain metadata)
  notes: string;
}
```

**Implementation**: Use `pptxgenjs` for .pptx parsing (or `python-pptx` if TS parsing is insufficient). For HTML-based templates, parse the DOM. Render each slide to PNG via Puppeteer for the thumbnail.

#### Step 2: Fingerprint Generation

Transform each extracted slide into a searchable fingerprint:

```typescript
interface SlideFingerprint {
  // Identity
  deckId: string;
  slideIndex: number;
  thumbnailPath: string;

  // Functional type (from §1.2 decision tree, applied to template content)
  functionalType: FunctionalType;

  // Element composition — what's on the slide
  elementComposition: {
    hasTitle: boolean;
    hasSubtitle: boolean;
    hasBody: boolean;
    hasImage: boolean;
    hasTable: boolean;
    hasChart: boolean;
    hasDiagram: boolean;       // inferred from shape clusters
    hasQuote: boolean;         // inferred from large italic text + attribution
    bulletCount: number;       // 0 if no bullets
    imageCount: number;
    shapeCount: number;
  };

  // Spatial layout — WHERE elements are positioned
  spatialLayout: {
    // Discretize slide into a 3x3 grid (Rule of Thirds)
    // Each cell: what element types occupy it
    grid: ElementType[][];     // 3x3 array of arrays
    // Dominant layout pattern
    pattern: LayoutPattern;
  };

  // Text density
  textDensity: {
    totalWordCount: number;
    titleWordCount: number;
    bodyWordCount: number;
    textAreaRatio: number;     // total text area / slide area
  };

  // Visual style
  style: {
    colorPalette: string[];    // top 3-5 colors
    dominantFontSize: number;
    hasHandwrittenFont: boolean;
    hasBackgroundImage: boolean;
    whitespaceRatio: number;   // 1 - (element area / slide area)
  };

  // Content tags (extracted from template text, for semantic matching)
  contentTags: string[];       // e.g. ["revenue", "quarterly", "comparison"]
}

type FunctionalType =
  | "title"
  | "section-divider"
  | "assertion-evidence"
  | "bullet-list"
  | "two-column"
  | "data-chart"
  | "diagram"
  | "image-dominant"
  | "quote"
  | "table"
  | "closing"
  | "key-takeaway"
  | "blank";

type LayoutPattern =
  | "centered"               // title slide, section divider
  | "top-title-full-body"    // title top, one element fills rest
  | "top-title-left-body"    // title top, content left-aligned
  | "title-left-visual-right"  // 40/60 split
  | "title-right-visual-left"  // 60/40 split (image left)
  | "title-top-two-columns"    // two-column
  | "title-top-grid"           // 2x2 or 3x2 grid of items
  | "full-bleed-image"         // image covers slide, text overlaid
  | "top-heavy"                // most content in top 2/3
  | "bottom-heavy";            // most content in bottom 2/3

type ElementType = "title" | "body" | "image" | "chart" | "table" | "shape" | "empty";
```

**Functional type classification** — apply the decision tree from §1.2 to the template's own content:
- If slide has only a large centered title → `title` or `section-divider`
- If slide has a chart element → `data-chart`
- If slide has a table → `table`
- If slide has many shapes forming a connected structure → `diagram`
- If image area > 50% of slide → `image-dominant`
- If body text has ≥3 bullets → `bullet-list`
- etc.

**Spatial layout classification** — divide the 13.33" x 7.5" slide into a 3x3 grid. For each cell, record which element types have their center or majority area in that cell. Then match against known patterns:
- Title in top-left or top-center + visual in center-right → `title-left-visual-right`
- Title spanning top row + two equal columns below → `title-top-two-columns`
- Single large element centered → `centered`

#### Step 3: Index Storage

Store all fingerprints in a single JSON index file per template collection:

```
templates/
  whiteboard/
    index.json              ← fingerprints for all whiteboard slides
    thumbnails/
      slide_00.png
      slide_01.png
      ...
  corporate-blue/
    index.json
    thumbnails/
      ...
  template-meta.json        ← deck-level metadata (style, font, palette)
```

`index.json` structure:
```json
{
  "deckId": "whiteboard",
  "deckStyle": {
    "fonts": ["Caveat", "Patrick Hand"],
    "palette": ["#1A5276", "#C0392B", "#2C3E50", "#555555"],
    "hasHandwrittenStyle": true
  },
  "slides": [
    { /* SlideFingerprint */ },
    { /* SlideFingerprint */ },
    ...
  ]
}
```

### 2.3 Template Matching Algorithm

At runtime, when generating a new slide from content:

#### Step 1: Analyze New Content

```typescript
interface ContentQuery {
  // From markdown parsing
  title: string;
  body: string[];            // bullet points or paragraphs
  hasTable: boolean;
  tableShape?: { rows: number; cols: number };
  hasData: boolean;          // numbers, percentages detected
  dataType?: "comparison" | "trend" | "proportion" | "distribution";
  hasQuote: boolean;
  hasImage: boolean;

  // Inferred
  functionalType: FunctionalType;   // from decision tree
  wordCount: number;
  bulletCount: number;
  contentTags: string[];            // keywords extracted from title + body
}
```

#### Step 2: Score Each Template Slide

Score every fingerprint in the index against the query. Each dimension gets a weight:

```typescript
function scoreMatch(query: ContentQuery, template: SlideFingerprint): number {
  let score = 0;

  // 1. Functional type match (highest weight — 40%)
  //    Exact match = 1.0, compatible match = 0.5, mismatch = 0.0
  score += 0.40 * functionalTypeScore(query.functionalType, template.functionalType);

  // 2. Element composition match (30%)
  //    Does the template have slots for what the content needs?
  score += 0.30 * elementCompositionScore(query, template.elementComposition);

  // 3. Text density compatibility (15%)
  //    A 5-word key-takeaway shouldn't go into a template designed for 50 words
  score += 0.15 * textDensityScore(query.wordCount, template.textDensity);

  // 4. Content tag overlap (10%)
  //    Semantic similarity between content keywords and template tags
  score += 0.10 * tagOverlapScore(query.contentTags, template.contentTags);

  // 5. Spatial layout preference (5%)
  //    Prefer templates whose layout pattern matches content structure
  score += 0.05 * layoutPatternScore(query, template.spatialLayout.pattern);

  return score;
}
```

**Functional type compatibility matrix** (not just exact match):

| Query Type → | title | section | bullet | data-chart | diagram | table | two-col | image | quote | closing |
|---|---|---|---|---|---|---|---|---|---|---|
| **title template** | 1.0 | 0.3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.5 |
| **section template** | 0.3 | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.3 | 0.3 |
| **bullet template** | 0 | 0 | 1.0 | 0 | 0 | 0 | 0.4 | 0 | 0 | 0 |
| **data-chart template** | 0 | 0 | 0 | 1.0 | 0.3 | 0.2 | 0 | 0 | 0 | 0 |
| **diagram template** | 0 | 0 | 0 | 0.3 | 1.0 | 0 | 0 | 0 | 0 | 0 |
| **table template** | 0 | 0 | 0 | 0.2 | 0 | 1.0 | 0.3 | 0 | 0 | 0 |
| **two-col template** | 0 | 0 | 0.4 | 0 | 0 | 0.3 | 1.0 | 0 | 0 | 0 |
| **image template** | 0 | 0.2 | 0 | 0 | 0 | 0 | 0 | 1.0 | 0.4 | 0 |
| **quote template** | 0 | 0.3 | 0 | 0 | 0 | 0 | 0 | 0.4 | 1.0 | 0 |
| **closing template** | 0.5 | 0.3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.0 |

**Element composition scoring**:
```typescript
function elementCompositionScore(query: ContentQuery, template: ElementComposition): number {
  let matches = 0;
  let total = 0;

  // Penalize if content needs an element the template doesn't have
  if (query.hasTable)  { total++; if (template.hasTable)  matches++; }
  if (query.hasData)   { total++; if (template.hasChart)  matches++; }
  if (query.hasImage)  { total++; if (template.hasImage)  matches++; }
  if (query.bulletCount > 0) {
    total++;
    if (template.bulletCount > 0) matches++;
    // Bonus if bullet counts are similar
    if (Math.abs(query.bulletCount - template.bulletCount) <= 1) matches += 0.5;
    total += 0.5;
  }

  // Penalize if template has elements the content doesn't need (visual clutter)
  if (!query.hasTable && template.hasTable) { total++; } // 0 matches, 1 total = penalty
  if (!query.hasData && template.hasChart)  { total++; }

  return total > 0 ? matches / total : 1.0;
}
```

#### Step 3: Return Top-K

Return the top 3 matching template slides, sorted by score. The generator uses the #1 match as the base layout and adapts it with the new content.

### 2.4 Adaptation Rules (How the Generator Uses the Matched Template)

Once a template slide is matched, the LLM doesn't copy it — it **adapts** it:

1. **Keep the spatial layout** — element positions, sizes, and the grid pattern stay the same
2. **Replace text content** — swap template placeholder text with actual content
3. **Replace chart data** — keep chart type and position, inject new data
4. **Scale text to fit** — if new content is longer, reduce font size (but never below minimums from §1.1)
5. **Drop unused elements** — if template has an image slot but content has no image, replace with whitespace (don't add a random image)
6. **Add needed elements** — if content has a table but template doesn't, fall back to a compatible template or use the default layout for that functional type

### 2.5 Integration with Current SashaSlides Architecture

This maps onto the existing pipeline:

```
slides.md (markdown)
    │
    ▼
Content Parser (existing in generate-pptx.ts)
    │ Outputs: title, body, table, notes, whiteboard flag per slide
    │
    ▼
Content Analyzer (NEW)
    │ Applies §1.2 decision tree to determine functionalType
    │ Extracts contentTags, counts elements, detects data patterns
    │ Outputs: ContentQuery per slide
    │
    ▼
Template Matcher (NEW)
    │ Loads index.json for the active template (e.g. whiteboard)
    │ Scores all indexed slides against each ContentQuery
    │ Outputs: best-match SlideFingerprint per slide
    │
    ▼
Layout Resolver
    │ Merges content + matched template fingerprint
    │ Decides: element positions, sizes, font sizes, chart type
    │ For whiteboard: decides which overlays to use (underline variant, table PNG, showcase PNG)
    │ Outputs: resolved layout specification per slide
    │
    ▼
generate-pptx.ts (existing, enhanced)
    │ Currently: hardcoded layout logic
    │ Enhanced: reads layout specification, positions elements accordingly
    │ Still generates source/render pairs for whiteboard slides
    │
    ▼
.pptx output → upload → Google Slides
```

### 2.6 Preprocessing Script Design

```
presentations/scripts/preprocess-templates.ts

Usage: npx tsx preprocess-templates.ts <template-dir> [--output <index-path>]

Example: npx tsx preprocess-templates.ts ../../presentation-templates/whiteboard/

Steps:
1. Find all .pptx files in template-dir (or render HTML templates to screenshots)
2. For each slide in each deck:
   a. Extract elements (text, shapes, images, tables, charts) with positions
   b. Render to thumbnail PNG
   c. Classify functional type
   d. Compute fingerprint
3. Write index.json + thumbnails/ to template-dir
```

For the **current whiteboard template**, preprocessing would index the 8 showcase types + content slide layouts that `generate-pptx.ts` already knows how to produce. This makes the existing hardcoded knowledge explicit and searchable.

### 2.7 Future: Multi-Template Support

When additional templates are added (e.g. `corporate-blue`, `minimal-dark`):

1. Each template gets its own `index.json` via the preprocessing script
2. The user selects a template style in `slides.md` frontmatter or skill invocation
3. Template Matcher searches only the selected template's index
4. The same content → layout rules apply regardless of template — only the visual style changes

This separates **content structure** (what type of slide, what elements) from **visual style** (colors, fonts, backgrounds, hand-drawn vs clean).

---

## Appendix A: Full Prompt Fragment for LLM Slide Generation

This is a condensed version of Part 1 suitable for inclusion in a Claude system prompt:

```
SLIDE DESIGN RULES — follow these strictly:

HARD LIMITS:
- 1 idea per slide. If you need two takeaways, make two slides.
- Max 30 words per slide (excluding chart labels).
- Max 6 bullets, max 6 words per bullet.
- Headlines: action titles stating the "so what" (not topic labels). Max 15 words, 2 lines.
- Min font: 24pt body, 28pt headlines.
- Max 2 fonts, max 4 colors.

LAYOUT SELECTION (apply in order, first match wins):
1. First slide → title
2. Last slide / "thank you" / "questions" → closing
3. Section marker / all-caps / no body → section-divider
4. Contains data/numbers → data-chart (bar for comparison, line for trend, pie for proportions ≤5 parts)
5. Describes process/hierarchy/relationships → diagram (flow for steps, hub-spoke for central+radial, pillars for foundations, roadmap for timeline)
6. Contains a table → table
7. Contains a quote/attribution → quote
8. Two contrasting groups → two-column
9. 3-6 parallel items → bullet-list
10. Single bold statement → key-takeaway
11. Default → assertion-evidence

CHART RULES:
- Bar: comparing categories. Line: trends over time. Pie: parts of whole (≤5 slices, must sum to 100%).
- When in doubt → bar chart.
- Action title states the data insight, not the chart type.

SEQUENCING:
- Hook (slides 2-3) → Problem (4-6) → section-divider → Solution/Evidence (core) → section-divider → Resolution → Call to action → closing
- Never two data-heavy slides back-to-back.
- End each section with a key-takeaway before the divider.

BODY ORIENTATION (horizontal vs vertical sections):
- Single statement / title / quote → single-zone centered (no subdivision)
- 2 parallel groups for comparison → horizontal (two-column)
- 3 equal-weight peer items (each ≤3 bullets) → horizontal (three-column)
- Text + one visual (chart/image/diagram) → horizontal (text left, visual right)
- Sequential / ordered items → vertical (stacked rows)
- Wide table or long bullets needing full width → vertical (stacked rows)
- Default → vertical (title top, body below) — safest, matches reading flow
- Max 3 columns. Min column width 3". Max 3 body rows. Min row height 1.5".
- Nesting max depth 2: outer is always vertical (title + body), horizontal only inside a row.
- Never subdivide one column vertically while another stays flat.

COGNITIVE LOAD:
- Words + visuals together > words alone (dual coding).
- Remove anything decorative that doesn't serve the point.
- Slide text complements speech — never duplicates what the speaker says.
- Related text and visuals must be physically close on the slide.
```

## Appendix B: Diagram Type Signatures for Template Matching

These are the shape patterns that identify each diagram type during preprocessing:

| Diagram Type | Shape Signature |
|---|---|
| **Flow** | ≥2 roundRect/rect + ≥1 line with arrow endpoint. Shapes arranged left→right or top→bottom. |
| **Hub-spoke** | 1 central ellipse/circle + ≥3 smaller ellipses/circles arranged radially + connecting lines. |
| **Pillars** | ≥2 tall rects of equal width arranged side-by-side + horizontal bars top/bottom. |
| **Roadmap** | ≥3 shapes (roundRect/rect) arranged in a horizontal line + connecting arrows/lines + sublabels. |
| **Cycle** | ≥3 shapes arranged in a circle/ellipse + curved arrows connecting them sequentially. |
| **Tree/Org** | Shapes arranged in hierarchical levels with top-down connecting lines. |
| **Two-column** | 2 large rects or text regions of roughly equal width, side by side. |

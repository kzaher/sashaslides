```yaml
design_system:
  philosophy: >
    Credibility-first, data-backed minimalism. The designer trusts whitespace and
    restraint over decoration. Visual complexity is reserved for proof points
    (charts, tables, product screenshots); claim slides are nearly empty.
    Third-party voices are treated as structural anchors — not testimonials tucked
    at the end, but recurring load-bearing elements that bracket every major section.

  typography:
    heading_font: "Sans-serif (humanist, no decorative serifs)"
    body_font: "Sans-serif; Serif italic reserved exclusively for pull-quote text"
    size_hierarchy:
      - role: "slide_title"
        size: "28–32pt"
        weight: "bold"
        alignment: "left"
      - role: "subtitle / italic-intro"
        size: "18–22pt"
        weight: "normal"
        style: "italic"
        alignment: "left"
      - role: "body"
        size: "14–16pt"
        weight: "normal"
        alignment: "left"
      - role: "pull_quote"
        size: "22–28pt"
        weight: "normal"
        style: "italic"
        font: "serif"
        alignment: "center"
      - role: "data_callout"
        size: "36–48pt"
        weight: "bold"
        alignment: "center"
      - role: "caption / source_attribution"
        size: "11–13pt"
        weight: "normal"
        style: "italic"
        alignment: "right or center"
      - role: "table_cell"
        size: "12–14pt"
        weight: "normal"

  colors:
    primary: "#4A6FA5 — dominant brand/header background, title bars, section headers"
    deep_accent: "#3B5998 — high-emphasis variant of primary; used when stronger saturation needed (e.g. data slides, ad-product slides)"
    light_tint: "#C8DCF0 — table alternating rows, light section fills, image overlay tints"
    very_light_tint: "#E8F0F8 — chart area fills, subtle background differentiation"
    dark_overlay: "#2C3040 — full-bleed image slides; text-legibility overlay on photography"
    background: "#FFFFFF — default slide background"
    body_text: "#1A1A1A or #000000 — primary text on white"
    reversed_text: "#FFFFFF — text on primary/deep-accent/dark-overlay backgrounds"
    additional:
      - "#C8DCF0 on #4A6FA5 — table header contrast pair"
      - "No greens, reds, oranges, or warm neutrals appear anywhere in the palette"

  layout_templates:
    - name: "centered-pull-quote"
      structure: >
        Single zone, vertically and horizontally centered. Serif italic quote text
        occupies center 60% of slide width. Attribution line (em-dash + source name
        + date) sits 1–2 lines below in smaller caption style. Brand mark/logo may
        appear top-left or bottom-right at small scale. No other elements.
      use_when: >
        Opening a presentation, closing a presentation, or bridging two major
        sections. Use to introduce third-party validation before or after a claim.
      constraints: "Max 40 words in quote. Max 12 words in attribution. No bullets, no images, no data."

    - name: "title-statement"
      structure: >
        Top 20% holds a left-aligned bold title on the primary color bar or white.
        Below, a single paragraph of prose body text (no bullets) left-aligned in
        the content zone. Generous bottom margin — bottom 25% of slide is empty.
      use_when: >
        Introducing a concept, making a forward-looking claim, or setting up the
        next proof-point slide.
      constraints: "Max 70 words body text. Zero bullets. No charts or images."

    - name: "text-image-split"
      structure: >
        Vertical split: left ~55% text zone (title + body paragraphs or short
        bullets), right ~45% image/screenshot zone. Image aligns to right edge and
        top/bottom slide edges with no border or drop-shadow. Text zone has standard
        left margin (~0.6 in).
      use_when: "Showing a product or interface alongside explanatory copy."
      constraints: "Max 60 words text. Image must be a real screenshot or photograph, not an icon."

    - name: "full-bleed-with-overlay"
      structure: >
        Full-slide background image covered by a semi-transparent dark overlay
        (#2C3040 at ~70% opacity). White reversed text floats over the overlay —
        title at top-left, body paragraph mid-left. Image subject visible through
        the tint at right/bottom.
      use_when: >
        Maximum visual impact on a transition or reveal slide; when photography
        is available and the point is atmospheric rather than analytical.
      constraints: "Max 50 words. No tables, no charts. Single paragraph only."

    - name: "two-column-prose"
      structure: >
        Title bar across full top. Below: two equal columns of prose text or
        numbered/lettered lists. Column gutter ~0.3 in. Both columns share the same
        top baseline. No column rules or borders.
      use_when: "Enumerating parallel features, options, or attributes that are equal in weight."
      constraints: "Max 50 words per column. Max 8 items per column."

    - name: "two-column-dense-bullets"
      structure: >
        Title bar full-width. Below: two columns of compact bullet lists, items
        ~13pt, tight leading (1.2×). Left column and right column may have unequal
        item counts. No sub-bullets.
      use_when: "Comprehensive enumeration where completeness matters more than narrative flow."
      constraints: "Max 10 bullets per column. Single-line items only. No nested bullets."

    - name: "data-table"
      structure: >
        Title bar. Table occupies 70–80% of content area. Header row in
        #4A6FA5 or #3B5998 with white reversed text. Body rows alternate
        #FFFFFF / #C8DCF0 or #E8F0F8. Left-align text cells, right-align or
        center numeric cells. No outer border, subtle inner row rules only.
      use_when: "Structured records with two or more attributes per row."
      constraints: "Max 15 rows. Max 4 columns. No merged cells."

    - name: "chart-with-callout"
      structure: >
        Title bar. Chart occupies center-left 55% of content zone. Right of chart:
        one or two large bold data-callout numbers (36–48pt) with brief descriptor
        labels (12pt). Source attribution in caption style at bottom-right.
      use_when: "Presenting a key metric with one dominant takeaway number."
      constraints: "Max 1 chart per slide. Max 2 callout numbers. Source line mandatory."

    - name: "metric-icon-grid"
      structure: >
        Title bar. Below: 2–4 metric blocks arranged in a horizontal row or 2×2
        grid. Each block: icon or small visual above, large bold number center,
        descriptor label below. Blocks are equal-width, evenly spaced with no
        borders. Background white or very light tint.
      use_when: "Presenting 2–4 parallel KPIs with equal emphasis."
      constraints: "Max 4 metrics. Each descriptor max 4 words. No prose text outside the grid."

    - name: "section-divider"
      structure: >
        Near-empty slide. Section label in large italic or bold sans-serif, centered
        or left-aligned at vertical midpoint. Optional small decorative image
        (watermark-style) at low opacity. Primary color background or white with
        primary-color title bar.
      use_when: "Marking the transition between major presentation sections."
      constraints: "Max 8 words. No body text. No bullets."

  spacing:
    slide_margins: "Left/right: ~0.6–0.75 in. Top: 0.5 in (below title bar). Bottom: 0.5–0.75 in."
    title_bar_height: "~0.9–1.1 in including padding; background fills full width"
    title_to_body_gap: "0.2–0.3 in between title bar bottom edge and first body element"
    bullet_spacing: "Single spacing within bullets; 0.08–0.12 in between bullet items"
    element_padding: "Body text left-indent from slide edge: 0.6 in. Column gutter: 0.3 in."
    whitespace_targets:
      quote_slides: "≥60% of slide area is empty"
      section_headers: "≥55% empty"
      claim_slides: "40–50% empty"
      dense_data_slides: "20–30% empty (acceptable floor)"

  content_rules:
    max_words_per_slide: 95
    max_bullets: 16 (only in two-column dense layout; standard layouts max 6)
    max_nesting_depth: 1 (no sub-bullets except numbered sub-items as inline prose)
    headline_style: >
      Noun-phrase labels, not action statements or questions. Title names the
      topic or category, never the conclusion. ("User Base Demographics", not
      "Demographics Prove Engagement"). One title per slide, no sub-headline on
      most layouts.
    data_presentation: >
      Numbers appear as large bold callouts next to a simple chart, OR inline
      as bolded figures within prose, OR in a clean alternating-row table.
      No infographics, no icon-heavy data art, no waterfall charts. Dollar figures
      always include unit ($B) inline. Percentages presented as the number only
      (e.g., "65%") not as a sentence.
    emphasis_technique: >
      Size contrast is the primary emphasis tool: a 48pt number next to 14pt body
      text commands attention. Secondary: color reversal — white text on
      #4A6FA5/#3B5998 title bars guarantees title reads first. Italic serif on
      quote slides signals a register shift. NO bold-everything, NO highlight
      boxes, NO callout arrows or annotation bubbles.
    image_treatment: >
      Product screenshots and photographs are used raw — no drop shadows,
      no rounded corners, no frames or borders. Images either fill their zone
      edge-to-edge or sit in a clean split layout. No stock illustration or
      clip-art. One image per slide maximum.
    never_do:
      - "Nested bullets (second-level indented lists)"
      - "More than one chart or table per slide"
      - "Decorative borders, rounded corner boxes, or shadow effects on text boxes"
      - "Gradient backgrounds (solid fills only)"
      - "More than two font families on one slide"
      - "Warm colors (red, orange, yellow, green) anywhere in the palette"
      - "Centered body text (only quotes and large callouts are centered)"
      - "Mixing prose and a chart on the same slide"
      - "Slide numbers, progress bars, or footer text on content slides"
      - "Animations or transition effects (implied by flat design system)"
      - "All-caps body text"
      - "More than 4 columns in a table"

  sequencing:
    opening: >
      Begin with a third-party validation slide (pull-quote layout) before any
      brand or product claim. This establishes credibility through an independent
      voice and creates curiosity before the presenter speaks.
    section_transitions: >
      Insert a pull-quote slide between major content sections approximately every
      4–6 content slides. Quotes come from independent third parties and reinforce
      the just-made argument. Never explain what the quote means — let it stand alone.
    section_headers: >
      Use section-divider layout to explicitly announce new topic areas. Keep label
      to 3–6 words. The divider slide is a visual breath, not a content container.
    content_pacing: >
      Alternate density: after a dense data or two-column slide, follow with a
      low-density claim or quote slide. Never stack two high-complexity slides
      consecutively. Rhythm: claim → proof → validation → claim.
    closing: >
      Close with a third-party pull-quote, not a summary or CTA slide. The final
      impression is an independent voice endorsing the proposition. Any contact or
      next-step information appears on the second-to-last slide, not last.
    proof_sequencing: >
      Introduce a concept in prose first, then show data, then show a quote
      validating the data. The quote always follows the numbers, never precedes them
      (except for the opening which precedes all claims).

  mental_model:
    optimizing_for: >
      Credibility and scan-ability. Every design decision makes it fast to read
      and easy to trust. The audience should be able to absorb the key point of
      each slide in under 5 seconds. If a slide requires more than one read-through,
      it has too much on it.
    own_slide_threshold: >
      Any single metric that is a primary proof point gets its own slide with a
      large callout treatment. If you are tempted to put two "hero numbers" on one
      slide, split them. The exception is parallel KPIs of equal weight (2–4
      metrics) which share a grid layout.
    complexity_limit: >
      A slide is too complex if it requires a legend to decode, if it has more than
      two visual layers (text + chart = 2; text + chart + icons = too many), or if
      it uses color for more than one semantic purpose simultaneously (e.g., color
      as category AND as emphasis at the same time). When in doubt, remove an
      element rather than shrink it.
    brand_voice_in_design: >
      The blue monochromatic palette signals institutional seriousness. The serif
      italic pull-quote font signals editorial credibility (newspapers, journalism).
      The combination of a corporate color system with newspaper-style quotes is
      the core visual tension that gives the deck its character — trustworthy
      institution vouched for by independent press.
```

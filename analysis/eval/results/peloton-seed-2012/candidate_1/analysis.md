```yaml
design_system:
  philosophy: >
    High-contrast duality: the deck alternates between dark, immersive full-bleed
    photography and clean white space slides. Dark slides carry emotional weight and
    brand drama; white slides carry structured logic and frameworks. This rhythm is
    not decorative — it is the primary pacing mechanism. Every slide has one dominant
    element; supporting elements exist only to anchor or explain that one thing.

  typography:
    heading_font: "Bold italic uppercase sans-serif (e.g. Helvetica Neue Heavy Italic,
      or comparable geometric grotesque)"
    body_font: "Regular weight of the same sans-serif family"
    size_hierarchy:
      - role: "slide_title"
        size: "36–44pt"
        weight: "bold"
        style: "italic uppercase"
        color_on_dark: "#FFFFFF"
        color_on_light: "#1A1A1A or #F44060"
      - role: "section_label"
        size: "28–32pt"
        weight: "bold"
        style: "italic uppercase"
        color: "#F44060"
      - role: "callout_heading"
        size: "22–26pt"
        weight: "bold"
        style: "uppercase"
        color: "#FFFFFF (always on colored shape)"
      - role: "body"
        size: "14–16pt"
        weight: "regular"
        style: "sentence case"
        color_on_dark: "#FFFFFF"
        color_on_light: "#333333"
      - role: "caption_label"
        size: "11–13pt"
        weight: "bold"
        style: "uppercase"
        color: "#F44060"
      - role: "diagram_label"
        size: "9–11pt"
        weight: "bold"
        style: "small caps or uppercase"
        color: "#1A1A1A or #FFFFFF depending on background"
    rules:
      - "Titles are ALWAYS bold italic uppercase — never sentence case, never roman"
      - "Body text is ALWAYS regular weight — never bold in paragraphs"
      - "Red (#F44060) is the exclusive typographic accent; no other color is used for emphasis text"
      - "Never mix italic and roman in the same headline"
      - "Strikethrough is a valid typographic device for explicitly negated items"

  colors:
    primary_dark: "#1A1A1A — near-black; default dark background and primary text on white"
    accent_red: "#F44060 — coral-red; ALL emphasis: section titles, column headers, callout shapes, source labels, icon fills, timeline nodes"
    white: "#FFFFFF — all text on dark backgrounds; light slide backgrounds"
    deep_purple_dark: "#1A0A30 — alternate dark background for premium/dramatic photo slides"
    body_gray: "#333333 — secondary text on white backgrounds"
    muted_gray: "#666666 — tertiary labels, captions on white"
    photo_earth: "#8B6040, #8B7355 — appear only within photographic content, not as design choices"
    diagram_pink: "#D4A0A0 — used exclusively for de-emphasized or background segments in circular diagrams"
    secondary_purple: "#7B2FBE — appears only as photographic ambient light, not as a design token"
    rules:
      - "Only two background values exist as intentional design choices: #1A1A1A (or #1A0A30) for dark slides, #FFFFFF for light slides"
      - "The accent color (#F44060) is used in exactly one role per slide — never used for both icons AND text on the same slide"
      - "No gradients in the design system itself; any gradient effect comes from underlying photography"
      - "Do not introduce tertiary colors beyond this palette"

  layout_templates:
    - name: "full-bleed-cover"
      structure: >
        Photograph fills 100% of slide area. Single centered brand mark or wordmark
        in white, vertically centered or offset slightly above center. No other text.
        Dark overlay implicit in photo selection (image is pre-darkened or moody).
      use_when: "Opening slide; section cover with maximum emotional impact"
      constraints: "Zero body text. Logo/mark only. Whitespace: 10% or less (photo dominates)."

    - name: "two-column-split"
      structure: >
        Left column (40–50% width): full-bleed photograph or visual, edge-to-edge
        vertically. Right column (50–60% width): white or dark background with title
        at top and structured content below. Hard vertical edge between columns, no gutter.
      use_when: "Table of contents; structured data with visual grounding; any framework that benefits from spatial separation"
      constraints: "Max 6–8 items in text column. Photo column has no text overlaid."

    - name: "data-table-on-dark"
      structure: >
        Dark (#1A1A1A) full-slide background. Bold uppercase title top-left in white.
        Two or more labeled columns with red (#F44060) column headers in bold uppercase.
        Body items in regular white, left-aligned within columns. Tight row spacing.
      use_when: "Structured comparison data; demographic or attribute lists; any two-axis taxonomy"
      constraints: "Max 2–3 columns. Max 8 rows. No horizontal rules — whitespace separates rows."

    - name: "icon-grid-on-white"
      structure: >
        White background. Bold italic uppercase red title top-left or top-center.
        3–6 items arranged in a grid (2×2, 3×2, or 1×4). Each cell: centered colored
        circular icon (filled #F44060) above a short bold label, with 1–2 sentence
        description below in regular gray. Equal cell widths, generous vertical padding.
      use_when: "Brand values; anti-patterns; any set of named principles that are parallel and equal in hierarchy"
      constraints: "Max 6 items. Labels: 2–4 words. Descriptions: 1–2 sentences max. Whitespace: 40–55%."

    - name: "two-column-contrast-list"
      structure: >
        Dark background. Two columns separated by implied center line (no visible divider).
        Left column: positive list in white regular text. Right column: same-length list
        in lighter gray or white with strikethrough applied to every item.
        Column headers in bold white (positive) and bold red (negative).
      use_when: "Explicit brand identity contrast: what the brand is vs. is not; inclusion/exclusion sets"
      constraints: "Max 12 items per column. Items are single words or 2–3 word phrases only. No body text."

    - name: "circular-callout-over-photo"
      structure: >
        Full-bleed lifestyle or product photograph. Large red filled circle (#F44060,
        diameter 25–35% of slide height) positioned left-center or center, with 1–3
        lines of bold uppercase white text inside. Below the circle or adjacent: 1–3
        sentence explanatory caption in regular white. Brand mark small in corner.
      use_when: "Single principle illustrated by a real-world scene; product-in-context slides"
      constraints: "One callout circle per slide. Max 6 words inside circle. Max 3 sentences caption."

    - name: "concentric-diagram"
      structure: >
        White background. Title top-left. Centered concentric circle diagram:
        innermost circle in red (#F44060), middle ring in light pink (#D4A0A0),
        outer ring divided into quadrant segments alternating white/light gray.
        Labels in small caps or 9pt uppercase black/dark gray. Quadrant labels at
        outer edge in bold uppercase.
      use_when: "Brand architecture frameworks; any nested or layered taxonomy; center-out hierarchy"
      constraints: "Max 4 outer quadrants. Max 4 items per quadrant. Max 4 items in inner ring. No photos."

    - name: "timeline-with-circular-images"
      structure: >
        Dark background. Horizontal or diagonal timeline axis. Nodes marked by small
        red dots or labels. Each node accompanied by a circular-cropped photograph
        (40–60px diameter equivalent). Date labels in red below or above axis.
        Caption text in white regular beneath each photo. Title bold italic top-left in white.
      use_when: "Chronological evolution; before/after progression; any sequence with 3–5 stages"
      constraints: "Max 5 nodes. One photo per node. Max 5 words per caption."

    - name: "press-quotes-grid-on-dark"
      structure: >
        Dark (#1A1A1A) full background. Bold italic uppercase red title top-left.
        2–4 quote blocks arranged in a grid. Each block: quote text in white regular,
        source/outlet name in bold red uppercase below. Subtle dividers or whitespace
        only between blocks. No quote-mark decorative glyphs.
      use_when: "Third-party validation; earned media; any external proof points"
      constraints: "Max 4 quotes. Each quote: 1–2 sentences only. Source label required on every quote."

    - name: "testimonial-card"
      structure: >
        Either white or dark background. Bold italic uppercase red headline at top
        (the review's own title, not a slide title). Body text in regular gray (light bg)
        or regular white (dark bg). Attribution in bold red uppercase at bottom.
        Optional star/decorative element in muted gray. Single or dual card layout.
      use_when: "Social proof; user-generated content; community voice"
      constraints: "Max 2 cards per slide. Review text: max 60 words. Attribution: name + location only."

  spacing:
    slide_dimensions: "1920×1080px (16:9) or equivalent widescreen"
    slide_margins: "60–80px left/right on white slides; 0px on full-bleed photo slides"
    top_margin: "60–80px for title on non-photo slides"
    title_to_body_gap: "24–36px"
    column_gutter: "40–60px between columns on split layouts"
    icon_to_label_gap: "12–16px"
    bullet_line_height: "1.4–1.6× font size"
    between_grid_items: "32–48px vertical, 40–60px horizontal"
    diagram_padding: "Concentric diagram occupies 60–70% of slide height, centered"

  content_rules:
    max_words_per_slide: 80
    max_bullets: 8
    max_nesting_depth: 1
    headline_style: >
      Titles are category labels or single-concept declarations, always in bold italic
      uppercase. Never questions. Never action verbs directing the audience. The title
      names the concept; the visual proves it.
    data_presentation: >
      Structured data appears as labeled columns in tables (never charts or graphs in
      this deck). Quantitative specifics (percentages, dollar amounts, ages) appear
      inline as regular body text — never called out in large display numerals.
      Third-party proof points always carry the source label in red.
    emphasis_technique: >
      Exactly one element per slide receives the accent color (#F44060): either the
      title, or the icon/callout shape, or the column header — never all three.
      Size contrast handles secondary hierarchy; color is reserved for the primary signal.
    background_alternation: >
      Dark and light slides alternate in clusters — typically 2–4 dark slides followed
      by 1–2 white slides. Never more than 4 consecutive slides of the same background
      tone. This alternation is the primary pacing device and must be deliberate.
    never_do:
      - "No before-and-after photo comparisons"
      - "No body text longer than 3 sentences on a single slide"
      - "No more than one typeface family anywhere in the deck"
      - "No colored backgrounds other than #1A1A1A, #1A0A30, or #FFFFFF as the primary field"
      - "No decorative borders, drop shadows, or box outlines on text blocks"
      - "No pie charts, bar charts, or data visualizations — data lives in tables or prose"
      - "No stock illustration or vector line art — photography only for imagery"
      - "No gradient fills applied to design elements (only acceptable within photographs)"
      - "No mixed case in headlines — always full uppercase"
      - "No bullet point symbols (dots, dashes) — use whitespace and alignment alone to separate items"
      - "Never use more than two columns in a text layout"

  sequencing:
    opening: >
      Begin with a full-bleed dark photograph and brand mark only — no claims, no agenda,
      no bullet points. The first slide is purely atmospheric, establishing tone before
      any information is presented.
    structure_reveal: >
      Immediately follow the cover with a light-background contents or navigation slide
      that makes the deck's structure visible. Use a photo on one side, section list on
      the other. This is the only slide where structure is made explicit.
    framework_then_proof: >
      Introduce each major concept as a framework slide (white bg, structured layout),
      then follow with 1–3 dark photo-with-callout slides that prove the concept in
      context. The framework states the logic; the photos create belief.
    diagram_as_anchor: >
      Complex frameworks (multi-level taxonomies, wheels, matrices) appear multiple times
      with progressive highlighting — first as a complete overview, then with specific
      segments emphasized as the narrative reaches that segment. The diagram itself does
      not change; the emphasis layer changes.
    transitions: >
      Section transitions use the complete framework diagram (concentric wheel or matrix)
      with the next section's segment highlighted. This orients the audience within the
      larger structure before diving into detail.
    closing: >
      Close with a social proof or testimonial cluster — third-party voices have the
      final word. The brand does not make the last claim; the community does.
    pacing: >
      3–4 slides per major section. Alternate dense (high whitespace ≤20%) and sparse
      (high whitespace ≥40%) slides within each section. Dark slides are shorter in
      content; white slides carry the structural load.

  mental_model:
    optimizing_for: >
      Emotional conviction over rational argument. Every design choice — the dark
      photography, the single red circle, the alternating rhythm — is engineered to
      make the audience feel the brand before they evaluate it. Data exists to confirm,
      not to persuade.
    own_slide_threshold: >
      Any concept that needs more than 3 bullet points gets its own slide. Any concept
      that needs a photograph to be credible gets its own slide. Concepts that can be
      named in one bold uppercase phrase and shown in one image get one slide.
    complexity_limit: >
      The most complex slide type in this system is the concentric diagram (~20 labeled
      segments). Everything else has ≤8 items. When content exceeds this, it is split
      across sequential slides (progressive disclosure) rather than compressed onto one.
    design_voice: >
      Premium-athletic: the aesthetic is closer to a fashion brand or luxury performance
      product than to a technology or consulting deck. Drama is intentional. White space
      on light slides is generous to the point of feeling expensive. Dark slides are
      immersive to the point of feeling cinematic.
```

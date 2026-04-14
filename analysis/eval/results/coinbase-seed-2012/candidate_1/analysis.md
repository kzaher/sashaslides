```yaml
design_system:
  philosophy: >
    Radical reduction. Every slide earns its existence by communicating exactly
    one idea with the fewest possible visual elements. The designer trades
    completeness for memorability — if a point can't be made with a single
    chart, a three-word phrase, or three icons, it gets its own slide rather
    than being compressed into a list. Whitespace is used aggressively as a
    signal of confidence.

  typography:
    heading_font: "Helvetica Neue Light (or system thin sans-serif fallback)"
    body_font: "Helvetica Neue Light — same family, smaller size"
    size_hierarchy:
      - role: "slide_title"
        size: "36–44pt"
        weight: "light (300)"
        alignment: "center"
        color: "#333333"
      - role: "section_label"
        size: "18–22pt"
        weight: "light (300)"
        color: "#888888"
        alignment: "center"
      - role: "primary_statement"
        size: "32–40pt"
        weight: "light (300)"
        alignment: "center"
        notes: "used for analogy slides or single-idea text slides"
      - role: "body_list_item"
        size: "24–28pt"
        weight: "light (300)"
        alignment: "center or left-of-icon"
      - role: "chart_annotation"
        size: "20–24pt"
        weight: "bold (700)"
        color: "#333333"
        notes: "the one callout that names the key number on a data slide"
      - role: "caption_label"
        size: "12–14pt"
        weight: "light (300)"
        color: "#888888"
      - role: "contact_url"
        size: "22–26pt"
        weight: "bold (700)"
        color: "#FFFFFF"
        notes: "reversed out of accent color banner"
    two_tone_emphasis:
      technique: >
        In analogy or equation-format slides, the subject/brand terms are
        rendered in #2E3A5F (dark navy) and the object/technology terms in
        #888888 (medium gray). No bold, no size change — color alone signals
        the semantic hierarchy.

  colors:
    background: "#E8ECF0 — slide canvas; a cool light gray, never pure white"
    primary_blue: "#4A90D9 — primary accent; charts, icon fills, highlight words in title, CTA banners"
    dark_navy: "#2E3A5F — brand-side terms in analogy slides; deepest text when extra contrast is needed"
    body_text: "#333333 — all slide titles and body text; dark gray, not black"
    secondary_text: "#888888 — labels, section headers, de-emphasized halves of two-tone statements"
    tertiary_gray: "#555555 — mid-weight word-cloud text and supporting labels"
    card_white: "#FFFFFF — background of product screenshots, chart plot areas, inset content regions"
    data_line: "#4A90D9 — all chart series lines and fill areas"
    alert_red: "#D9534F — used at most once per deck; reserved for a single high-urgency callout or closing accent element"
    never_use: "pure #000000 for body text; use #333333 instead"

  layout_templates:
    - name: "centered-icon-list"
      structure: >
        Title centered horizontally at top third. Below it, 2–4 items arranged
        in a horizontal row: each item is an icon (48–64px) centered above a
        short label (1–3 words). Equal horizontal spacing. Entire composition
        centered vertically in the lower two-thirds.
      use_when: "Introducing a fixed, enumerable set of properties or benefits (max 4)"
      constraints: "3 items ideal, never more than 4. Label max 3 words. No sentences. No sub-bullets."

    - name: "title-plus-full-bleed-visual"
      structure: >
        Title at top (10–15% of slide height). Remaining 85–90% occupied by a
        single visual (chart, map, screenshot mosaic). Visual bleeds to left
        and right edges or sits in a light white card with 16px padding.
        No body text — the visual is self-explanatory or a bold annotation
        floats inside it.
      use_when: "A single data visualization or geographic/spatial image is the entire argument"
      constraints: "One visual only. One annotation label maximum (the key number, bolded). No legend prose."

    - name: "two-column-contrast"
      structure: >
        Slide split 50/50 vertically. Left column has a section label in
        #888888 above a screenshot or interface image. Right column mirrors
        the same structure. A thin divider line or simply negative space
        separates them. Title centered above both columns.
      use_when: "Direct before/after, old/new, or competitor/product comparison"
      constraints: "Exactly two columns. One image per column. Column label max 3 words."

    - name: "centered-equation-statement"
      structure: >
        Single line of large text (32–40pt) centered both horizontally and
        vertically. Uses the two-tone color technique: subject terms in dark
        navy, linking/object terms in medium gray. No title, no subtitle, no
        background decoration.
      use_when: "Positioning statement, analogy, or ratio that can be expressed as an equation or proportion"
      constraints: "One line only. No punctuation beyond colons or double-colons. No explanation text on same slide."

    - name: "word-density-cloud"
      structure: >
        Title at top. Remaining space filled with varying-size terms arranged
        organically (not in a grid). Largest terms (24–32pt) represent primary
        categories; smallest (14–18pt) represent secondary. All terms in
        #333333–#555555 range. No icons, no connectors.
      use_when: "Showing breadth of a market, use-case space, or audience segment without implying hierarchy"
      constraints: "8–15 terms. No sentences — noun phrases only. Two size tiers maximum."

    - name: "chart-with-callout"
      structure: >
        Title at top (10–15% height). Chart occupies 70–75% of slide in a
        white card. A single bold text annotation (the headline number or
        growth rate) sits either inside the chart area at the inflection point
        or directly above the chart. No table, no data grid, no legend prose.
      use_when: "Time-series growth data or any single-metric trend"
      constraints: >
        One chart per slide. One annotation (the most important number, bolded).
        X and Y axis labels in caption size only. No gridline labels beyond
        essential scale markers.

    - name: "brand-anchor"
      structure: >
        Logo centered in upper half. Tagline in light sans-serif below logo.
        Multi-device product screenshots arranged in a horizontal or staggered
        arc in lower half. Blue accent element (banner, icon, or underline)
        ties the brand color to the product imagery.
      use_when: "Opening slide or any slide that re-establishes product identity mid-deck"
      constraints: "Logo + tagline + 2–3 device screenshots maximum. No bullet text."

    - name: "closing-contact"
      structure: >
        Brand logo and tagline centered in upper area (same as brand-anchor).
        A full-width accent-color (#4A90D9) banner anchored to the bottom of
        the slide contains the contact handle/URL in white bold text. An
        optional supporting data visual fills the space between logo and banner.
      use_when: "Final slide only"
      constraints: "One contact line. Banner is full-width, bottom-anchored. No 'Thank you' text."

  spacing:
    slide_margins: "Left/right: ~80px (≈0.83in at 1920px width). Top: ~60px. Bottom: ~60px."
    title_to_body_gap: "32–48px between slide title baseline and first content element"
    icon_to_label_gap: "12px between icon bottom and label text"
    horizontal_item_spacing: "Equal gaps; for 3-icon rows ~120–160px between icon centers"
    chart_card_padding: "16px inside white content card"
    whitespace_target:
      low_density_slides: "60–75% of slide area is empty"
      data_slides: "20–30% empty (visual fills the rest)"
      analogy_slides: "70–80% empty"

  background_treatment:
    canvas: "#E8ECF0 flat color — no gradients, no textures, no patterns"
    content_insets: >
      Product screenshots and charts sit inside #FFFFFF cards with subtle
      drop shadows (0 2px 8px rgba(0,0,0,0.10)). The gray canvas surrounds
      these insets as a natural frame.
    accent_banners: >
      Full-width horizontal bands in #4A90D9 used only for closing CTA or
      section demarcation. Never used as a slide background.

  decorative_elements:
    icons: >
      Flat, monochrome, filled icons in #4A90D9 or #333333. 48–64px. Used
      only when pairing with a short label — never decorative.
    shadows: "Subtle box shadows on white inset cards only (see above)"
    dividers: "Absent — negative space separates regions instead of lines"
    borders: "None — no slide borders, no element borders"
    rounded_corners: "Slight rounding (4–8px) on screenshot card edges only"

  content_rules:
    max_words_per_slide: 40
    max_bullets: 3
    max_nesting_depth: 1
    headline_style: >
      Topic labels (noun phrase, no verb) for data slides.
      Declarative problem statement (short sentence) for problem framing.
      Brand name + tagline structure for identity slides.
      No question marks. No colons in titles except for brand:tagline format.
    data_presentation: >
      Single time-series line chart per slide. The chart is the argument;
      one bolded annotation names the key metric. No tables on data slides.
      No pie charts. No bar charts for growth data — lines only.
    emphasis_technique: >
      Isolation: the most important element is made dominant by removing
      everything around it. On text slides, font size differential. On data
      slides, a single bold annotation floats at the peak of the chart.
      On comparison slides, color contrast (dark navy vs. medium gray).
    never_do:
      - "More than 3 bullet points on any single slide"
      - "Two charts or two data visualizations on the same slide"
      - "Paragraph text of any kind (no sentences in body, only labels)"
      - "Pure black (#000000) for text — always use #333333"
      - "Gradient backgrounds or textured backgrounds"
      - "Decorative borders or frames around the slide edge"
      - "Legend boxes on charts — label data directly or use a single annotation"
      - "Title text longer than 8 words"
      - "More than one accent-color banner per slide"
      - "Centered text mixed with left-aligned text on the same slide"
      - "Clip art or stock photography as decorative elements"

  sequencing:
    opening: >
      Lead with the product identity (logo + tagline + multi-device screenshots).
      Establish what the thing IS before explaining why it matters.
      Do not open with a problem statement — credibility first.
    context_block: >
      Follow with 2–3 slides establishing market reality: properties of the
      underlying technology, then a geographic or quantitative scale signal,
      then a growth chart. These slides share visual language (same layout
      family) to read as a continuous block.
    problem_pivot: >
      One slide only. Headline names the problem directly (declarative, present
      tense). Body is a before/after visual contrast — no prose explanation.
    solution_reveal: >
      Return to product screenshots. Mirror the opening brand-anchor layout to
      signal "this is the answer to what you just saw."
    positioning_statement: >
      One isolated analogy slide after the solution. No context, no explanation.
      The analogy stands alone — the audience is trusted to connect it.
    traction_block: >
      Two consecutive chart slides (user metric, then revenue/volume metric).
      Same layout, same annotation style. The repetition signals compounding.
    closing: >
      Return to opening brand identity. Add contact information in the accent
      banner. Optional: include a live-data or activity visualization to imply
      real-time momentum without adding slides.
    pacing: >
      Each slide is exactly one argument. No slide serves as a transition or
      connector — content slides are placed back-to-back. Rhythm is fast.
      An audience member who blinks misses one complete idea.

  mental_model:
    optimizing_for: >
      Signal-to-noise ratio. Every pixel either carries meaning or creates
      breathing room that makes the meaning clearer. There is no decorative
      layer — backgrounds, colors, and type sizes all communicate semantic
      information.
    own_slide_threshold: >
      Any distinct claim gets its own slide. A market size claim and a growth
      chart are two slides, not one. A problem and a solution are two slides.
      The cost of an extra slide is low; the cost of crowding is high.
    complexity_limit: >
      If a visual requires a legend to read, it's too complex. If a bullet
      requires a sub-bullet, split into two slides. If a comparison requires
      more than two columns, reconsider whether comparison is the right format.
      The mental model is: "Could a distracted audience member understand this
      in 3 seconds?" If not, simplify.
```

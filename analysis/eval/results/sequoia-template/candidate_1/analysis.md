```yaml
design_system:
  philosophy: >
    Extreme content-first minimalism. The design is a transparent container
    for the argument — it never competes with the message. Every visual
    decision defaults to subtraction: remove color, remove decoration,
    remove density until only the essential statement remains. The designer's
    complexity threshold is one thought per slide, rendered with maximum air.

  typography:
    heading_font: "System sans-serif (e.g. Arial, Helvetica, or equivalent)"
    body_font: "Same as heading — single typeface throughout"
    size_hierarchy:
      - role: "slide_title"
        size: "36–40pt"
        weight: "bold"
        color: "#5CB85C"
        alignment: "left"
        notes: "Title always renders in accent green; acts as a topic label, not a sentence"
      - role: "body_primary"
        size: "20–24pt"
        weight: "normal"
        color: "#333333"
        alignment: "left"
        notes: "Main instructional or declarative text; never more than 3 lines per item"
      - role: "body_secondary"
        size: "16–18pt"
        weight: "normal"
        color: "#999999"
        alignment: "left"
        notes: "De-emphasized items, optional notes, metadata; muted gray creates visual hierarchy without a size change"
      - role: "caption_or_meta"
        size: "12–14pt"
        weight: "normal"
        color: "#999999"
        alignment: "left or center"
        notes: "Source lines, attribution, administrative text at slide edges"

  colors:
    primary_accent: "#5CB85C — used for: all slide titles, opening/closing backgrounds, primary CTA elements"
    body_text: "#333333 — used for: all primary readable content"
    background: "#FFFFFF — used for: 100% of content slide backgrounds"
    muted: "#999999 — used for: secondary bullets, optional items, metadata, any text that should recede"
    alert: "#FF0000 — used sparingly for: items flagged as optional, warnings, or administrative parentheticals — never for emphasis of key points"
    rule: >
      Only five colors exist in the entire system. Never introduce additional
      hues. Accent green is reserved exclusively for titles and full-bleed
      accent slides (opening/closing). Body slides are white + gray only.

  layout_templates:
    - name: "full-bleed-accent"
      structure: >
        100% accent-color background. Large centered or left-aligned white
        text block (2–4 lines max). Optional secondary line in smaller weight
        below. No decorative elements, no images, no shapes.
      use_when: >
        Opening slide (establishes identity) or closing slide (CTA or
        summary). Also used for major section dividers if the deck is long.
      constraints: "Max 20 words total. No bullets. No body text below the main statement."

    - name: "title-plus-sparse-bullets"
      structure: >
        Accent-colored title flush left at top (~15% from top edge).
        2–3 bullet points in body text below, left-aligned, with generous
        line spacing (~150–180%). Bottom 30–40% of slide is empty white.
      use_when: >
        Any slide where the content is 2–3 parallel directives, questions,
        or sub-points. The canonical workhorse layout.
      constraints: "Max 3 bullets. Max 12 words per bullet. No sub-bullets. No images."

    - name: "title-plus-statement"
      structure: >
        Accent title at top. A single declarative sentence or short paragraph
        centered vertically in the remaining space. 70–80% of slide area is
        whitespace. Nothing else.
      use_when: >
        When the entire slide is a single assertion that must land
        unambiguously. Use when the concept cannot be fragmented into bullets.
      constraints: "Max 25 words in the statement. No bullets, no supporting text, no visuals."

    - name: "title-plus-list"
      structure: >
        Accent title at top. 4–6 bullet points filling the middle two-thirds
        of the slide. Items are parallel in length and grammatical form.
        Still 40–55% whitespace overall.
      use_when: >
        Enumerable items (5+) where all carry equal weight and sequence
        matters (e.g. a roadmap, a checklist, a component list).
      constraints: >
        Max 6 items. Max 8 words per item. Never nest. If items split
        into two categories, use two columns — but prefer splitting into
        two separate slides instead.

    - name: "index-or-agenda"
      structure: >
        Title at top. Numbered or unnumbered list of section labels,
        larger than body text, spread across the slide with high line
        spacing. May include a meta-label in muted gray above the list.
      use_when: "Structural navigation: table of contents, agenda, or flow overview."
      constraints: "Max 10 items. Labels only — no descriptions, no sub-text per item."

  spacing:
    slide_margins: "Left/right ~8–10% of slide width; top ~12–15%; bottom ~10%"
    title_to_body_gap: "~24–32pt vertical gap between title baseline and first bullet"
    bullet_spacing: "~150–180% line height; no tight stacking"
    element_padding: "Nothing touches the edges. Every text block has ≥0.5in clearance from slide boundary."
    whitespace_target: >
      Every content slide targets 55–80% empty space. High whitespace is
      not a side effect — it is the primary visual tool. When a slide feels
      crowded, split it rather than reducing font size or margin.

  content_rules:
    max_words_per_slide: 40
    max_bullets: 6
    max_nesting_depth: 1
    headline_style: >
      Topic labels — short noun phrases (2–4 words), not action statements
      and not full sentences. The title names the territory; the body
      navigates it. Never use a question as a title on content slides.
    data_presentation: >
      No charts or data visualizations in this system. Numbers appear
      inline as plain text within bullets. If a number is important,
      bold it within the sentence — no callout boxes, no big-number
      heroes, no icon arrays.
    emphasis_technique: >
      Structural isolation is the only emphasis tool: a critical idea gets
      its own slide with nothing else on it (title-plus-statement layout).
      Within a bullet list, bold inline text may highlight one key term
      per bullet. Color is never added to emphasize body text — that role
      belongs to whitespace and isolation.
    optional_or_conditional_items: >
      Items that are situational or not required are explicitly labeled
      in muted gray (#999999) or flagged parenthetically "(Not required
      for this presentation)". Never bury optional status — surface it
      visually so the audience calibrates importance immediately.
    never_do:
      - "Add background images, textures, gradients, or patterns to content slides"
      - "Use more than one accent color per slide"
      - "Nest bullets more than one level deep"
      - "Use decorative icons, divider lines, or shapes on content slides"
      - "Write a slide title that is a full sentence"
      - "Use more than five colors across the entire deck"
      - "Shrink font size below 16pt to fit more content — split instead"
      - "Add drop shadows, rounded corners, or borders to text boxes"
      - "Use centered alignment on body text (titles may center on accent slides only)"
      - "Place images or charts alongside text on the same slide"

  sequencing:
    opening: >
      Full-bleed accent slide. Name + essential descriptor only. No
      tagline elaboration, no URL, no social proof. Establishes identity
      in 3–5 words. Transitions immediately to a structural index slide
      that previews the full argument arc.
    transitions: >
      No animated transitions. No visual metaphors linking sections.
      Each new topic is announced by its title alone. Structural breaks
      (major new section) may use another full-bleed accent slide as a
      divider, but this is optional — the title color change is sufficient
      signal.
    closing: >
      Return to full-bleed accent treatment. Contains exactly one call
      to action or closing prompt. May include a secondary muted line
      with contact/resource info. No summary, no recap, no "thank you"
      as the primary text.
    pacing: >
      One concept per slide, no exceptions. If a topic has three aspects,
      it gets three slides. Slides are cheap; cognitive overload is
      expensive. The deck runs long-and-sparse rather than short-and-dense.

  mental_model:
    optimizing_for: >
      Clarity of argument over production value. The presenter is the
      show; the slides are the outline. Design recedes so the spoken
      word can carry full weight. Trust the audience to read sparse text
      without visual scaffolding.
    own_slide_threshold: >
      Any distinct concept, sub-topic, or enumerable category that the
      presenter will dwell on for more than 30 seconds earns its own slide.
      Never combine two ideas on one slide to save space.
    complexity_limit: >
      If a slide requires more than one visual scan to comprehend,
      it is too complex. The test: cover the title and read only the
      body — if the topic is not immediately obvious, restructure.
      Decoration is a signal of insufficient clarity in the content itself.
```

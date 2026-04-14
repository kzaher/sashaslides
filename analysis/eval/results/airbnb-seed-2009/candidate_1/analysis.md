```yaml
design_system:
  philosophy: >
    Radical simplicity. Every slide asks one question and answers it.
    The designer trusts whitespace over density — if a slide can breathe, it should.
    Numbers are the loudest voice; everything else is supporting context.
    Visual hierarchy does the work that bullet styling and decoration would
    otherwise do in a lesser deck.

  typography:
    heading_font: "sans-serif (geometric, e.g. Helvetica Neue or equivalent)"
    body_font: "same sans-serif family as heading — no mixing"
    size_hierarchy:
      - role: "slide_title"
        size: "28–36pt"
        weight: "bold"
        case: "title case"
        color: "primary accent (#29B6F6) or dark (#333333)"
      - role: "section_label"
        size: "11–13pt"
        weight: "bold"
        case: "ALL CAPS"
        color: "accent or dark — used as category tags, not prose"
      - role: "key_metric"
        size: "36–48pt"
        weight: "bold"
        case: "ALL CAPS"
        color: "accent or emphasis color — the single loudest element on the slide"
      - role: "body"
        size: "14–18pt"
        weight: "normal"
        color: "#333333"
      - role: "caption_or_source"
        size: "9–11pt"
        weight: "normal"
        color: "#888888 or muted gray"
        placement: "bottom of slide, left-aligned"

  colors:
    primary_accent: "#29B6F6 — used for: slide titles, highlighted category labels,
      primary data bars, link-like elements, the dominant accent on most slides"
    emphasis: "#E91E8B — used for: secondary callouts, quote attribution marks,
      the most emotionally resonant number or word on a slide; never used for body text"
    data_warm: "#E8711F — used for: financial projections, revenue numbers,
      market-size callouts; signals 'money'"
    data_positive: "#8BC34A — used sparingly; signals growth or confirmation,
      appears only on closing/financial slides"
    body_text: "#333333 — used for all prose body copy"
    background: "#FFFFFF — solid white on every slide; no gradients, no textures"
    tint: "#D6EEFB — very light blue used as a subtle zone background or panel
      behind grouped content; never dominant"

  layout_templates:
    - name: "centered-identity"
      structure: >
        Centered vertically and horizontally. Company name large, tagline below,
        contact line at bottom in small type. Nothing else. 60%+ whitespace.
      use_when: "Opening title slide. One per deck, first position only."
      constraints: "Max 3 lines of text total. No bullets. No imagery beyond logo."

    - name: "title-plus-bullets"
      structure: >
        Bold title at top-left. Body area has 2–4 short bullet points,
        left-aligned, generous line spacing. No sub-bullets.
        55–60% whitespace target.
      use_when: >
        Qualitative points that are roughly equal in weight.
        Problems, advantages, or features that resist being ranked.
      constraints: "Max 4 bullets. Each bullet max 15 words. No nesting."

    - name: "title-plus-labeled-list"
      structure: >
        Bold title at top. Each item has an ALL-CAPS bold label (2–4 words)
        followed by a dash and a short descriptor sentence.
        Labels are colored with accent; descriptors are dark body text.
      use_when: >
        Items that have distinct named categories — go-to-market channels,
        product features, team roles. When labels carry meaning beyond bullets.
      constraints: "Max 5 labeled items. Label ≤ 4 words. Descriptor ≤ 20 words."

    - name: "stacked-metrics"
      structure: >
        Title at top. Body divided into 2–3 metric blocks stacked vertically.
        Each block: large ALL-CAPS bold number or key phrase in accent/warm color
        (36–48pt), immediately followed by a 1-line descriptor in normal body type.
        Optional source citation in 9pt gray below the block.
      use_when: >
        Quantitative data — market size, revenue projections, business model math.
        When numbers ARE the argument and prose would dilute them.
      constraints: "Max 3 metric blocks. No tables. No bar charts. Numbers do the talking."

    - name: "two-axis-matrix"
      structure: >
        Title at top. Center of slide: simple hand-drawn or thin-line cross
        creating 4 quadrants. Axis labels at extremes (top/bottom/left/right)
        in small ALL-CAPS. Competitor labels scattered across quadrants as
        small text. Subject of deck marked distinctly (bolder, accent color,
        or circled) in its quadrant.
      use_when: "Competitive positioning. One slide only."
      constraints: >
        Axes must be conceptual opposites (affordable/expensive, offline/online).
        Max 10 competitor labels. No legend needed.

    - name: "image-dominant"
      structure: >
        Title above or overlaid. Product screenshot or photo fills 60–75%
        of slide area. Minimal text — a short user-flow label or single
        call-to-action phrase. Whitespace collapses to 20–25% on these slides.
      use_when: "Product demonstration. Show, don't describe."
      constraints: "Single image. Max 10 words of supporting text."

    - name: "quote-stack"
      structure: >
        Title at top. 3–4 pull quotes stacked vertically. Each quote:
        opening quotation mark in accent color, quote text in normal body type,
        em dash + attribution (source name in bold or accent) on same line.
        No borders, no speech bubbles, no avatars.
      use_when: >
        Third-party validation — press mentions, user testimonials.
        Always placed after internal claims to provide external confirmation.
      constraints: "Max 4 quotes. Each quote max 20 words. Attribution required."

    - name: "bio-grid"
      structure: >
        Title at top. 2–4 person blocks arranged in a row or 2×2 grid.
        Each block: name in bold, role in ALL-CAPS accent color or normal weight,
        2–4 sentence bio in body type. Optional small headshot above the name block.
      use_when: "Team or advisor slides."
      constraints: "Max 4 people. Bio max 4 sentences. No org chart lines."

  spacing:
    slide_margins: "~0.6–0.9 inches on all sides (approximately 60–90px at 96dpi)"
    title_to_body_gap: "24–32pt below the title before body content begins"
    bullet_spacing: "1.4–1.6× line height; no tight packing"
    metric_block_gap: "32–48pt between stacked metric blocks"
    element_padding: "No box padding or card borders — elements breathe via gap alone"
    whitespace_target: >
      Low-density slides: 55–65%. Medium: 35–50%. High-density (product/team): 20–30%.
      Never exceed the high-density range even on the most content-heavy slides.

  content_rules:
    max_words_per_slide: 80
    max_bullets: 4
    headline_style: >
      Short noun phrase or single action statement. Never a full sentence with a verb.
      Title answers: "What is this slide about?" not "What should you believe?"
    data_presentation: >
      Inline large bold numbers, not charts. Key metric first, descriptor second,
      source citation third (tiny, gray). Use color to distinguish metric tiers
      (total market in one color, addressable in another, projected share in a third).
      Never use pie charts for market-size breakdowns.
    emphasis_technique: >
      The single most important number or phrase on a slide is set 2–3× larger
      than surrounding body text, in an accent color (blue, pink, or orange
      depending on semantic role), and in ALL CAPS. Everything else is normal weight.
      One emphasis item per slide — never two competing focal points.
    never_do:
      - "Dark or colored backgrounds (every slide is white)"
      - "More than 4 bullets on a single slide"
      - "Sub-bullets or nested lists of any depth"
      - "Decorative borders, drop shadows, or card outlines around content"
      - "Mixed font families within a single slide"
      - "Animated transitions or progressive reveals implied by layout"
      - "Footnote-heavy slides — source citations are one line, gray, minimal"
      - "Charts or graphs (bar, line, pie) — use large inline numerics instead"
      - "Clip art, stock icons, or decorative illustration"
      - "More than one image per slide"
      - "Justified or centered body text — always left-align"
      - "Slide numbers visible on the slide face"

  sequencing:
    opening: >
      Identity-first: brand name, one-line tagline, contact. No agenda slide.
      No table of contents. Drop the audience into the brand before any argument.
    transitions: >
      Problem → Solution → Validation → Scale → Product (show) → Business Model →
      Go-to-Market → Competition → Advantages → Team → Social Proof → Ask.
      Each slide answers the implicit question raised by the previous one.
      Section titles are sufficient transitions — no "Next, let's talk about..." headers.
    closing: >
      The final slide is the ask, not a summary. Restate the target metric,
      the funding amount, and the time horizon. Three numbers only.
      End on a forward-looking number, not a recap of past slides.
    pacing: >
      ~14 slides for a complete narrative arc. One idea per slide.
      Never combine problem + solution on one slide.
      Social proof (press / testimonials) appears near the end, after all
      claims have been made — it validates, not introduces.

  mental_model:
    optimizing_for: >
      Investor comprehension speed. Every design decision reduces the time between
      "slide appears" and "key point understood." Whitespace, large numerics,
      and ALL-CAPS labels are all in service of instant scanability.
    own_slide_threshold: >
      Any named concept that requires more than one sentence to introduce gets
      its own slide. Any number large enough to be the headline argument gets
      its own slide. If two concepts share a slide, one is being shortchanged.
    complexity_limit: >
      If a slide requires a legend, it's too complex. If a bullet needs a
      sub-bullet, it needs to be its own slide. If data needs a chart,
      reframe it as 2–3 inline bold numbers instead.
```

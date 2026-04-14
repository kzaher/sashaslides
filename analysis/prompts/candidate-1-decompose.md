# Analysis Prompt Candidate 1: "Decompose & Codify"

**Prerequisites:** Read and follow all rules in `shared-rules.md` before proceeding.

Strategy: Bottom-up. Study the visual patterns across slides, extract atomic rules, synthesize into a coherent design system. Focuses on extractable, measurable properties.

---

## Your Approach

### Step 1: Study (internal, do not output)
Examine all slides to identify recurring patterns. Note what stays constant vs what varies. Count things. Measure things.

### Step 2: Visual Design System
Extract the fixed visual constants:

- **Color palette**: every color and its semantic role (e.g. "headings", "emphasis", "background", "body text", "dividers")
- **Typography system**: font families, the complete size hierarchy (title → subtitle → body → caption → label), weight rules, when italic/bold are used
- **Spacing & layout grid**: margins, padding between elements, alignment rules, gutters
- **Background treatment**: solid/gradient/texture/image, any overlays or patterns
- **Decorative elements**: recurring visual devices (lines, shapes, icons, borders, shadows, rounded corners)

### Step 3: Layout Template Library
Identify the TYPES of layouts used (abstract templates, not slide-specific):

For each layout type:
- Name it descriptively (e.g. "centered-statement", "title-plus-bullets", "data-table")
- Describe the spatial arrangement of zones
- State when this layout should be chosen (what kind of content triggers it)
- Content constraints (max words, max bullets, element limits)

### Step 4: Content Formatting Rules
How content is visually treated:
- **Headline style**: topic labels, action statements, questions, or single words?
- **Text density limits**: max words per slide, max bullets, max nesting depth
- **Data presentation**: tables, charts, inline bold numbers, proportional shapes, icons?
- **Emphasis technique**: how is the key point on each slide made visually dominant?
- **Anti-patterns**: what this style deliberately avoids

### Step 5: Sequencing Principles
General opening, transition, and closing patterns. Pacing rhythm.

### Step 6: Mental Model
The creator's implicit design philosophy — what they optimize for, their complexity threshold.

## Output Format

```yaml
design_system:
  philosophy: "..."
  
  typography:
    heading_font: "..."
    body_font: "..."
    size_hierarchy:
      - role: "slide_title"
        size: "Npt"
        weight: "bold/normal"
      - role: "subtitle"
        size: "Npt"
      - role: "body"
        size: "Npt"
      - role: "caption"
        size: "Npt"

  colors:
    primary: "#XXXXXX — used for: ..."
    accent: "#XXXXXX — used for: ..."
    body_text: "#XXXXXX"
    background: "#XXXXXX"
    additional: []

  layout_templates:
    - name: "..."
      structure: "..."
      use_when: "..."
      constraints: "..."

  spacing:
    slide_margins: "..."
    title_to_body_gap: "..."
    bullet_spacing: "..."
    element_padding: "..."

  content_rules:
    max_words_per_slide: N
    max_bullets: N
    headline_style: "..."
    data_presentation: "..."
    emphasis_technique: "..."
    never_do: ["...", "..."]

  sequencing:
    opening: "..."
    transitions: "..."
    closing: "..."
    pacing: "..."

  mental_model:
    optimizing_for: "..."
    own_slide_threshold: "..."
    complexity_limit: "..."
```

**Remember: no slide numbers, no content summaries, no deck-specific details. General rules only.**

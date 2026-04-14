# Design Persona: The Confident Minimalist

## Core Identity
- **Optimizing for**: Signal-to-noise ratio and investor comprehension speed — every element earns its place
- **Audience model**: Time-pressured sophisticates who pattern-match instantly; they trust confidence over volume
- **Communication mode**: Assertion-first. State the conclusion, then prove it. Never hedge, never over-explain.

---

## Visual System

### Typography

| Role | Spec | Why |
|------|------|-----|
| Primary title | Helvetica Neue Light or equivalent, ~48–60pt, #333333, centered | Lightness signals confidence — only weak design needs heavy weight to demand attention |
| Section label | Same face, 14–16pt, #888888, uppercase or small | Recedes; never competes with the claim |
| Data annotation | Same face, bold, 18–22pt, #333333 | One bold beat per chart — the number the audience must remember |
| Chart axis / label | 10–12pt, #888888 | Infrastructure, not content |
| Analogy / statement | 36–48pt, two-tone: primary noun in #2E3A5F, secondary noun in #888888 | Forces hierarchy without font changes |

**Rule:** One font family, maximum two weights (Light + Bold), never italic. Weight contrast IS the emphasis system.

### Color Palette

| Color | Hex | Role | Emotional Function |
|-------|-----|------|--------------------|
| Accent blue | #4A90D9 | Interactive elements, chart fills, highlighted key term, CTA banner | Trustworthy, technological, liquid |
| Deep navy | #2E6DB4 / #2E3A5F | Primary nouns in analogies, logo weight | Authority, permanence |
| Surface gray | #E8ECF0 | Slide background | Neutral, non-distracting, softer than white |
| Body text | #333333 | All primary text | Near-black — readable without harsh contrast |
| Recede gray | #888888 | Labels, secondary text, subordinate analogy terms | Visually deprioritized |
| Alert red | #D9534F | Closing accent only — used once | Creates closure energy, implies urgency |
| White | #FFFFFF | Card surfaces, chart backgrounds | Lifts content off the gray ground |

**Semantic rule:** Blue = "the thing we control / the system / the product." Gray = "the context / the world / the given." Red = used once, as punctuation.

### Layout Templates

**`full-bleed-product`** — Title top-center, then 2–3 product screenshots filling 60–70% of the slide area, arranged side by side or in device mockups. Use when: proving the product is real and polished.

**`icon-triplet`** — Large centered title, then three icons with single-word labels arranged horizontally with generous equal spacing. No body copy. Use when: listing parallel benefits that each stand alone.

**`dominant-visual`** — Title occupies ≤15% of height, full-width visualization (map, chart, globe) fills remaining space. Use when: one image proves the point faster than words can.

**`chart-with-callout`** — Title top, chart filling 60% of area, single bold annotation overlaid or adjacent stating the punchline number. Use when: showing growth or trend data.

**`centered-statement`** — Single line or short phrase, centered both horizontally and vertically, 75%+ whitespace. Use when: making a conceptual leap that must land without distraction. The emptiness is the emphasis.

**`before-after-split`** — Two columns with a header label each ("Current" / "New") containing visuals (screenshots, terminal images). Use when: the gap between problem and solution can be shown, not told.

**`word-scatter`** — Title plus 8–15 words/phrases in varying font sizes, scattered across the slide, no bullets, no grid. Use when: communicating breadth of a category without implying hierarchy.

**`contact-close`** — Brand mark centered, tagline below, single contact method in a full-width accent-color banner at the bottom. Use when: ending — leaves one thing to write down.

### Spacing & Density

- **Target whitespace:** 40–65% per slide. When a slide drops below 25%, it must be because a visual (screenshot, chart) is doing the heavy lifting — not because text was added.
- **Max text per slide:** 3 bullets at ~6 words each, OR 1 statement at ≤12 words, OR chart labels only. Never both bullets and a chart.
- **Margins:** Consistent implicit margin ~8–10% of slide width on all sides. Nothing bleeds to edge except background color and the closing banner.
- **Element count:** ≤4 distinct visual elements per slide. Title + 3 things, or visual + annotation + title. The "centered-statement" template has 1.
- **Icon size:** When icons appear, they are large (≥64px display equivalent) and carry the semantic weight of a sentence. Small decorative icons are never used.

---

## Decision Framework

```
IF presenting a product's value proposition
THEN show the product interface at full size
BECAUSE seeing beats claiming — a real screenshot is more persuasive than any adjective

IF making a conceptual positioning claim (X is to Y what A is to B)
THEN use centered-statement with maximum whitespace and two-tone color
BECAUSE the idea needs space to breathe; clutter signals the creator doesn't trust the idea

IF showing time-series growth
THEN include exactly one bold annotation (the number the audience must retain) and nothing else
BECAUSE charts with multiple callouts create noise; one number makes one memory

IF a slide's argument can be reduced to three parallel items
THEN represent each with an icon, not a bullet
BECAUSE icons are faster to parse and signal that each item is discrete and equal

IF the argument requires comparison between old state and new state
THEN use a two-column split with visual evidence in each column, not prose descriptions
BECAUSE juxtaposition is the argument; text description of a visual difference is weak

IF complexity must be shown (many use cases, many adopters, many applications)
THEN use word-scatter or a data visualization, never a bulleted list
BECAUSE lists imply a ranking; scatter implies abundance without hierarchy

IF a claim involves a geographic or global pattern
THEN show an actual map or globe visualization, not a text description
BECAUSE "global adoption" means nothing; a globe with concentration spikes means something

IF transitioning from context-setting to product introduction
THEN start a new slide with the product name in the title — no continuation markers
BECAUSE the slide boundary IS the transition; no "therefore" required

IF data shows exponential growth
THEN let the curve be the primary visual and annotate with the surprise metric
BECAUSE hockey-stick shapes are emotionally compelling before the numbers register

IF closing the presentation
THEN show only the brand mark, the one-line value proposition, and one contact method
BECAUSE everything else has been said; repetition at close suggests insecurity

IF choosing background color
THEN use a warm light gray (#E8ECF0 range) rather than pure white
BECAUSE pure white creates harsh contrast and reads as unfinished; gray grounds the content

IF using color to emphasize text
THEN apply accent blue to the single most important noun, leave all else in near-black
BECAUSE one colored word is a pointer; multiple colored words are decoration

IF a slide would require more than 4 visual elements to explain itself
THEN split into two slides, each making one claim
BECAUSE density signals confusion, not thoroughness

IF tempted to add a subtitle under a slide title
THEN resist and fold the nuance into the title itself or cut it
BECAUSE subtitles read as second thoughts

IF showing a metric in context
THEN state the metric first, then show the chart — not the other way around
BECAUSE the number primes the eye to find the right feature in the chart

IF ending a section and beginning another
THEN use a title-only slide with large centered text as a section break
BECAUSE white space between sections gives the audience a breath before the next argument

IF the deck must open
THEN open with the brand name + value proposition + product evidence simultaneously
BECAUSE this audience decides in seconds whether to keep listening — prove you're real immediately
```

---

## Sequencing Architecture

**Opening formula:** Brand + value statement + proof-of-existence (product screenshot). No preamble, no agenda slide, no table of contents.

**Section progression:** Context → Gap → Solution → Validation. Each phase gets 2–3 slides. The context phase establishes that the category matters; it does not yet mention the product. The gap phase shows the problem visually. The solution phase is product-first. Validation is data-only — no claims, just curves.

**Transition between phases:** New title with new conceptual frame. No "transition slides" with arrows or "so..." connectors. The title change IS the transition.

**Analogy placement:** Immediately after product introduction, before traction data. The analogy provides the mental model; traction data then fills it with evidence.

**Closing formula:** Brand mark + tagline (same as opening value statement, word-for-word) + single contact method. Mirror the opening. The deck is a loop, not a line.

---

## Anti-Patterns

- **Never use bullet points as a layout default.** Bullets are a last resort when icons, images, or charts fail. This style uses bullets only when forced by pure-text content with no visual equivalent.
- **Never use more than one typeface.** Font mixing signals indecision.
- **Never use gradient fills, drop shadows, or bevels.** Flat is the entire aesthetic premise.
- **Never use slide numbers or progress indicators.** They remind the audience the presentation will end; this style wants them in the moment.
- **Never put more than one key metric per chart slide.** Multiple annotations = none of them land.
- **Never use decorative or illustrative stock photography.** Only functional visuals: actual product screenshots, real data charts, actual maps.
- **Never use a title that summarizes the slide.** Titles make claims or name the topic; the visual proves the claim. "Our product works" as a title is wasted.
- **Never use red or any warm accent color for anything except a single final punctuation moment.** It will read as an error or warning everywhere else.
- **Never write in complete sentences inside slides.** Fragments and phrases only. Verbs optional.
- **Never animate content within slides.** If seen, every element is visible at once. No reveals, no fly-ins, no emphasis animations.
- **Never explain what the audience is looking at.** Label charts minimally; trust the audience to read. Footnotes, legends, and explanatory captions break the confidence register.

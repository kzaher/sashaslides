# Design Persona: The Credentialed Insider

## Core Identity
- **Optimizing for**: Institutional credibility with an audience that doesn't need to be convinced the space is interesting — only that *this* offering is legitimate and worth money
- **Audience model**: Skeptical decision-makers with budget authority. They've seen many pitches. They respond to proof, not promise. They distrust superlatives and respond to data.
- **Communication mode**: Evidence-first. Every claim is externally validated before the creator speaks in their own voice. The creator is a reliable narrator who steps aside to let numbers and third parties do the persuading.

---

## Visual System

### Typography

| Role | Treatment | Why |
|---|---|---|
| Third-party quote body | Serif italic, ~18–22pt | Signals "this is someone else's voice" — serif = authority of print journalism |
| Quote attribution | Sans-serif, smaller, non-italic | Grounds the quote in verifiable reality; contrast breaks the poetic register |
| Brand/product name in quote context | Sans-serif bold | The product name should never look like editorial text — even inside a quote |
| Section header | Sans-serif, 28–36pt, sentence case, often italic | Italic signals transition/parenthetical — "we're now moving to a new domain" |
| Body text | Sans-serif, 14–16pt, regular weight | Maximizes legibility; nothing competes with the argument |
| Standalone data callout | Sans-serif bold, 36–48pt | Numbers that need to be remembered get visual isolation and weight |
| Table content | Sans-serif, 11–13pt | Tables are reference material, not reading material — compress them |

**Single font family rule**: Use one sans-serif family for all non-quote text. Never mix two sans-serifs. Serif is reserved exclusively for quoted external voices.

### Color Palette

| Color | Hex | Role | Emotional Function |
|---|---|---|---|
| Primary blue | #4A6FA5 | Default background tint, headers, section color | Trust, competence, institutional stability |
| Deep blue | #3B5998 | High-emphasis slides, data slides | Authority, seriousness — used when data must land |
| Light blue wash | #C8DCF0 | Table row alternates, image overlays | Softens data-dense content; keeps it in-family |
| Near-white tint | #E8F0F8 | Chart backgrounds, subtle surface differentiation | Maintains palette coherence without hard contrast |
| White | #FFFFFF | Primary text on dark, primary backgrounds | Clarity |
| Dark navy | #2C3040 | Full-bleed image underlay | Creates drama for product demonstration moments |

**Palette rule**: Strict monochromatic blue system. Zero warm colors, zero accent colors, no green/orange/red. The color system communicates "this is not a startup pitch deck" — it communicates institutional inevitability.

### Layout Templates

**`centered-statement`** — Single claim, centered vertically, 45–65% whitespace. No decoration. Used when the message must land without competition. Trigger: when you have one thing to say and it needs to breathe.

**`quote-full`** — Large italic serif quote centered in 2/3 of the slide, attribution bottom-right. 60–65% whitespace. Logo or brand mark in corner only. Trigger: external validation moment — open, mid-section reset, or close.

**`section-divider`** — Title only, centered or left-aligned, minimal text, 55–65% whitespace, often with a single supporting image at low opacity. Trigger: major topic transition.

**`title-plus-prose`** — Left-aligned title at top, single paragraph body below, no bullets. 30–40% whitespace. Trigger: when the argument needs to flow as a sentence, not a list — when bulleting would fragment coherent logic.

**`text-left-image-right`** — 55% text column left, 45% product/screenshot right, tight vertical margins. 20–30% whitespace. Trigger: when you need to show the thing while explaining it — never put text and image at equal visual weight.

**`full-bleed-product`** — Image fills entire slide, text overlaid on dark region at bottom 20–25%. Trigger: maximum product immersion moment — one per section maximum.

**`data-table`** — Full-width table, alternating light-blue/white rows, header row in primary blue. 20–30% whitespace. Trigger: comparative structured data where rows are equal-weight items.

**`metric-showcase`** — 2–4 metric blocks arranged in a grid, each with a large number + short label. No prose. Trigger: when multiple KPIs must land simultaneously.

**`two-column-feature`** — Two equal columns, each with a short label and 3–8 items. Tight spacing. Trigger: when a list would run too long in single column and items don't have a natural hierarchy.

### Spacing & Density

- **Whitespace target by slide type**: Quote/statement = 60–65%. Section divider = 55–60%. Standard content = 30–40%. Data-dense = 20–30%.
- **Maximum words per slide**: Quotes = 35. Statements = 35. Prose slides = 65. Data/feature lists = 100 (when in two columns).
- **Margins**: Consistent ~8–10% of slide width on left/right. Never bleed text to edge except on full-bleed image slides.
- **Text-to-visual ratio**: Most slides are text-only or text-dominant. Product screenshots appear sparingly — 3–4 times in a 20-slide deck. When used, they occupy at least 40% of slide area or they're not worth including.
- **Bullet discipline**: Bullets only when items are genuinely parallel and unordered. Maximum 4 bullets before switching to two-column layout. Never use sub-bullets.

---

## Decision Framework

**IF** you have external validation for a key claim **THEN** lead with the external voice before making the claim yourself **BECAUSE** the audience trusts third parties more than you, and front-loading credibility earns the right to make first-person assertions later.

**IF** a point can be made in one sentence **THEN** give it a slide to itself with 60%+ whitespace **BECAUSE** visual isolation signals importance — the audience calibrates what to remember by how much space surrounds it.

**IF** you have a number that changes the audience's mental model **THEN** present it as a standalone callout, not buried in prose **BECAUSE** numbers in running text get forgotten; isolated numbers get written down.

**IF** content can be argued in connected sentences **THEN** use prose, not bullets **BECAUSE** bullets fragment continuous logic and create the impression of a list where there's actually an argument.

**IF** you have more than 5 parallel items **THEN** use a table or two-column layout rather than a bullet list **BECAUSE** the audience stops reading after bullet 4; structure implies completeness better than a long list does.

**IF** you're transitioning between major sections **THEN** insert a near-empty section-divider slide **BECAUSE** cognitive reset requires a visual pause — without it, the audience carries the previous section's mental frame into the next one.

**IF** you are making a claim about scale or reach **THEN** follow immediately with a specific number **BECAUSE** abstract size claims (large, significant, growing) activate skepticism; specific numbers activate belief.

**IF** you have product screenshots **THEN** use them in a split-layout, never floating **BECAUSE** a screenshot without a containing structure looks like a draft; a screenshot in a structured layout looks like evidence.

**IF** you need to show comparative/list data **THEN** use a table **BECAUSE** tables imply completeness and precision; bullet lists imply "we thought of some examples."

**IF** the previous slide made an emotional claim **THEN** follow with a data slide **BECAUSE** alternating register (emotional → rational → emotional) maintains engagement better than sustained monotone.

**IF** you are closing the deck **THEN** end with third-party validation, not a call to action **BECAUSE** ending with "contact us" sounds needy; ending with a quote lets the external voice make the final argument for you.

**IF** a slide uses a full-bleed image **THEN** that slide is the only full-bleed slide in its section **BECAUSE** visual maximalism loses impact when repeated — one dramatic slide anchors a section, two makes both feel ordinary.

**IF** the subject matter has institutional associations (universities, publications, professional titles) **THEN** reference those associations explicitly **BECAUSE** borrowed credibility from known institutions transfers to your own credibility.

**IF** you are presenting usage/engagement data **THEN** express it as percentages and absolute numbers simultaneously **BECAUSE** percentages alone feel massaged; absolute numbers alone lack context; both together feel transparent.

**IF** a section introduces a new topic domain **THEN** start with the "why this matters to the audience" before the "what it is" **BECAUSE** the audience doesn't care about your features until they understand why those features serve their interests.

**IF** product complexity risks overwhelming the audience **THEN** sequence features as: overview → one feature per slide at increasing detail **BECAUSE** building from simple to complex lets the audience follow; front-loading complexity loses them early.

**IF** you have a table with more than 8 rows **THEN** introduce it on a prior slide that explains what the table proves **BECAUSE** a table without a framing claim looks like a data dump; with a framing claim it looks like evidence.

**IF** two pieces of content logically belong together but the slide would exceed 65 words **THEN** split them across two slides with the same heading **BECAUSE** density is a signal — an overcrowded slide signals the creator hasn't edited their thinking.

---

## Sequencing Architecture

**Opening formula**: Third-party validation quote → Product definition in one sentence → Product demonstration (show, don't tell).

**Section opening formula**: Near-empty divider slide (label only) → Audience-benefit framing slide → Supporting data or evidence.

**Mid-deck reset**: When credibility needs recharging after a dense data section, insert another third-party quote. This acts as a palette cleanser and re-establishes external validation before the next claims.

**Data section formula**: Single big framing number → breakdown of that number (chart or table) → growth/trajectory evidence.

**Closing formula**: Services/offer summary → pricing/contact → third-party validation quote. Never end on a transactional slide. The final impression must be the product's value, not the ask.

**Pacing rule**: Alternate between high-whitespace and data-dense slides. Never stack more than two data-dense slides consecutively. Never stack more than two near-empty slides consecutively.

---

## Anti-Patterns

**Never use warm colors.** Red, orange, yellow, and green do not exist in this palette. Warmth signals urgency or casualness — this style communicates institutional stability.

**Never use decorative elements.** No dividing lines, no icon sets, no corner flourishes, no gradient overlays, no drop shadows. Every pixel must carry information or serve whitespace.

**Never use more than two font families.** The serif/sans-serif split is the entire typographic system. A third typeface is noise.

**Never mix chart types on a single slide.** One visualization per slide. Combining a bar chart and a callout number on the same slide creates competition for attention.

**Never make the call to action the loudest element.** Contact information and pricing live in restrained, low-emphasis layouts. The product's value should be louder than the ask.

**Never start a section with data.** Data requires context. Open sections with a framing claim or audience-benefit statement; data follows as proof.

**Never use animation metaphors in static slides.** Layouts assume all information arrives simultaneously. Don't build slides that require a sequence to make sense.

**Never put more than one "key takeaway" on a slide.** If two things are both important, they each deserve their own slide. Co-located importance cancels itself out.

**Never use clipart, stock illustrations, or icon libraries.** The only images in this style are product screenshots (evidence) or full-bleed photography. Illustrations break the institutional register.

**Never bold text inside prose for emphasis.** If something needs emphasis, give it its own slide. In-line bolding signals the creator didn't trust the sentence to carry the point.

# Shared Analysis Rules

These rules apply to ALL analysis prompt candidates. They are prepended to every analysis run.

---

## The Task

You are analyzing a presentation to extract its **visual design system** — the set of rules that make it look the way it does.

**Why:** We want to build new presentations on completely different topics that have the same visual quality and style as this one. To do that, we need to understand the design decisions — not the content decisions — that were made.

**Your job:** Study the slides, identify every visual pattern, and write those patterns down as general rules. Think of yourself as a brand designer reverse-engineering a style guide from finished work.

**The target output:** A document that a different AI (which will never see the original slides) can use to generate HTML slides on any topic that look like they came from the same designer. The AI will receive your rules + a raw storyline (just text content, no design info) and must produce styled slides.

## What You Receive

- Screenshots of every slide in a presentation
- Structured content (element positions, text, styles, shapes)
- The extracted storyline (pure narrative, no design info)

## What You Must Output

**General, transferable design principles** that could be applied to build a presentation about ANY topic in the same visual style as the input deck.

## Hard Constraints

1. **NO slide-by-slide descriptions.** Do not walk through individual slides, do not list slide contents, do not reference slide numbers. The slides are your source material — study them, extract patterns, then output only the general rules.

2. **NO content reproduction.** Do not summarize what the presentation is about. Do not reproduce the storyline, the argument structure, or the specific data points. Someone reading your output should have no idea what topic the original presentation covered.

3. **100% transferable.** Every rule you output must work for a completely different topic. Not "use blue for the product name" but "use the accent color for the single most important noun on each slide." Not "open with a press quote" but "open with third-party validation to establish credibility before any claims."

4. **Specific and measurable.** "Use clean design" is useless. "#29B6F6 for all headings, 32pt bold sans-serif, left-aligned at 80px from left edge" is useful. Include exact hex codes, font sizes in pt, spacing in px or inches, percentages for whitespace.

5. **Complete visual system.** Your output must cover ALL of these:
   - Color palette with semantic roles
   - Typography hierarchy (fonts, sizes, weights, when each is used)
   - Layout templates (the distinct spatial arrangements, described generically)
   - Spacing and density rules (margins, padding, whitespace targets)
   - Background and decorative treatments
   - Content density limits (max words, max bullets, max elements)
   - Emphasis techniques (how the most important thing is highlighted)
   - Data visualization approach (how numbers/metrics are presented)
   - Sequencing patterns (how to open, transition, close)
   - Anti-patterns (what this style never does)

6. **Actionable for generation.** A different AI system reading ONLY your output (not the original slides) must be able to generate HTML slides that match the original style. If your rules are too vague to generate from, they're too vague.

7. **No content-derived names.** Template and layout names must describe VISUAL STRUCTURE, never content. Use names like `centered-statement`, `title-plus-bullets`, `two-column-split`, `full-bleed-accent`, `data-table`. NEVER use names like `problem-slide`, `market-size`, `team-page`, `solution-overview` — those leak the original deck's content and can't transfer to a different topic.

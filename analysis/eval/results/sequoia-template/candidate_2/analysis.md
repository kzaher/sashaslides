# Design Persona: The Institutional Minimalist

## Core Identity
- **Optimizing for**: Signal-to-noise ratio; forcing clarity of thought before ornamentation
- **Audience model**: Experienced evaluators with high cognitive load, limited time, strong pattern-recognition for BS — they penalize complexity as a proxy for unclear thinking
- **Communication mode**: Interrogative scaffolding — the deck poses the questions the audience would ask, then answers them in sequence; authority comes from the *structure*, not from visual polish

---

## Visual System

### Typography
- **Primary font**: Sans-serif (system-weight), no decorative faces — communicates directness over aesthetics
- **Title role**: ~28–32pt, medium-to-bold weight, left-aligned, color `#333333` or `#5CB85C` depending on slide type; serves as the *question being answered*, not a headline
- **Body role**: ~16–18pt, regular weight, `#333333`; plain prose or sparse bullets, never decorative
- **Meta/annotation role**: ~12pt, `#999999`; used exclusively for administrative notes, caveats, and optional flags — visually subordinated to signal "you may skip this"
- **No custom typefaces.** The choice of a standard sans-serif is itself a statement: the ideas should carry the slide, not the typography

### Color Palette
| Color | Hex | Role | Emotional Function |
|-------|-----|------|--------------------|
| Signal Green | `#5CB85C` | Primary accent; title bar / cover background / section markers | Authority, forward motion, institutional trust |
| White | `#FFFFFF` | Slide background | Openness, nothing hidden, space for thought |
| Mid Gray | `#999999` | Secondary text, annotations, optional items | Subordination; "read if you need to, skip if not" |
| Dark Charcoal | `#333333` | Body text | Readable authority without the harshness of pure black |
| Alert Red | `#FF0000` | Used sparingly for explicit exclusions or warnings | Interrupts the eye; reserved for "do not do this" signals |

**Palette rule**: 3 colors maximum on any single slide. The accent (green) appears on at most one element per slide — overuse destroys hierarchy.

### Layout Templates

**`full-bleed-accent`** — accent color fills the entire background; large white centered text; used for cover and closing bookends only. No body text. Whitespace ≥ 40%.

**`titled-void`** — white background; green accent bar or colored title at top (~18% of height); body area is nearly empty (65–80% whitespace); one to three short prose lines or bullets. The emptiness is the design — it demands the author fill it only with what is essential.

**`structured-list`** — white background; green title; body contains 4–8 short bullet items at ~16pt; whitespace ~50–55%; used when enumeration is unavoidable and each item has equal weight.

**`closing-cta`** — mirrors the cover: accent background, white type, but adds a secondary action element (smaller text below the main statement). Whitespace ~40%.

### Spacing & Density
- **Whitespace target**: 65–80% of slide area for content slides; never below 40% even on the densest slides
- **Max bullets per slide**: 5, preferably 3
- **Max words per slide**: ~40 in body text (titles excluded)
- **Margins**: generous uniform margins, ~8–10% of slide width on each side; nothing bleeds to the edge except on full-bleed accent slides
- **Text-to-visual ratio**: ~90:10 — this style deliberately avoids decorative imagery; visuals only appear when they replace text that would otherwise require more words
- **Line spacing**: open (≥1.4× line height) — density is the enemy

---

## Decision Framework

1. **IF** a concept can be expressed in one sentence **THEN** give it its own slide with nothing else **BECAUSE** one clear thought per surface trains the audience to treat each slide as a complete unit of meaning

2. **IF** a slide has more than 5 bullets **THEN** split it or cut to 3 **BECAUSE** more than 5 signals the author hasn't decided what matters; the audience reads uncertainty, not thoroughness

3. **IF** a section introduces a new category of question **THEN** open with a titled-void layout before adding detail **BECAUSE** the title alone forces the author to name the question clearly before answering it

4. **IF** content is optional or context-dependent **THEN** mark it explicitly in a subordinated color (#999999) rather than including or excluding it **BECAUSE** the audience should see the full framework and self-select what applies, rather than receiving a pre-filtered version

5. **IF** a prohibition or exclusion exists **THEN** use alert red (#FF0000) for that text only **BECAUSE** one high-contrast interruption anchors all surrounding information; more than one alert destroys hierarchy

6. **IF** the slide is the first or last in the deck **THEN** invert the color scheme (accent background, white text) **BECAUSE** structural bookends signal entry and exit; they are ceremonies, not information

7. **IF** the author is tempted to add an image **THEN** ask whether a phrase would communicate the same thing in fewer cognitive steps **BECAUSE** this style treats visuals as a fallback when language fails, not a default

8. **IF** a concept requires enumeration **THEN** use a flat bulleted list at the same visual weight for each item **BECAUSE** hierarchy within a list implies relative importance the author may not have established; flat lists invite the audience to form their own ranking

9. **IF** a number or metric must appear **THEN** present it as inline prose or a single labeled line, not a chart **BECAUSE** chart complexity implies precision the early-stage context rarely warrants; prose numbers feel like claims, not data theater

10. **IF** emphasis is needed within body text **THEN** achieve it through sentence position (first or last) not bold/italic/color variation **BECAUSE** any secondary typographic treatment adds a visual layer that must be learned; position is universal

11. **IF** a navigational overview is needed **THEN** place it immediately after the cover as a flat list with no styling differences between items **BECAUSE** the structure itself is the credibility signal; color-coding an agenda suggests some sections matter more, which undermines the framework's authority

12. **IF** the closing slide must ask for something **THEN** use the same full-bleed accent treatment as the cover **BECAUSE** symmetry signals the presentation is complete; the ask feels like a natural consequence of the journey, not a separate sales motion

13. **IF** a layout becomes visually complex **THEN** audit whether complexity arises from content ambiguity **BECAUSE** visual complexity in this style is always a symptom of unclear thinking, never a design choice

14. **IF** the deck covers a topic requiring deep expertise **THEN** keep body text at a reading level accessible to an intelligent non-expert **BECAUSE** the audience tests your ability to explain, not just to know

15. **IF** two pieces of information have equal weight **THEN** place them as sequential slides rather than side-by-side columns **BECAUSE** column layouts imply comparison; sequential slides imply independent completeness

16. **IF** a slide must reference material not required for all audiences **THEN** annotate it as optional in the subordinated gray rather than removing it **BECAUSE** showing the full framework and flagging optional items demonstrates thoroughness without demanding cognitive engagement

17. **IF** the background must carry meaning **THEN** use solid color fills only (never gradients, textures, or photography) **BECAUSE** patterned backgrounds compete with text; the slide is a document, not a stage set

18. **IF** brand color appears on a slide **THEN** it appears on exactly one element **BECAUSE** the accent derives all its power from scarcity; used twice it becomes wallpaper

19. **IF** the font conveys no personality **THEN** the content must do all the work **BECAUSE** this is the design's thesis — the style strip-mines decoration to make weak ideas impossible to hide

---

## Sequencing Architecture

**Opening formula**: Full-bleed accent → navigational scaffold (flat list, no styling hierarchy) → content begins. The cover names the author; the scaffold names the questions; content answers them in order.

**Section progression**: Each content section gets exactly one slide per question. The question appears as the title. The answer appears as prose or a flat list. No sub-slides, no "build" sequences.

**Transition formula**: None. No transition slides between sections. The titled-void layout with the next question title *is* the transition — arrival at a new question is self-evident from the title alone.

**Closing formula**: Mirror the cover — full-bleed accent, white type — but shift register from declarative ("here is who we are") to imperative or interrogative ("here is what we need" or "here is what we offer").

**Pacing rule**: Every slide should be completable in 60–90 seconds of speaking. If a slide requires longer, it contains more than one thought.

---

## Anti-Patterns

- **No gradients.** Gradients signal decorative intent; this style is documentary.
- **No photography or illustration as background.** Imagery behind text is always a compromise of legibility for aesthetics — this style refuses the trade.
- **No more than one accent-colored element per slide.** The accent is a pointer, not a paint bucket.
- **No bold or italic within body text.** Emphasis through position, not decoration.
- **No drop shadows, rounded-corner boxes, or card layouts.** These create visual containers that imply relationship; flat text implies independence and forces the author to state relationships explicitly.
- **No chart for a single number.** A lone data point in a pie chart is performance, not communication.
- **No transition animations.** Motion implies show business; this style is a working document.
- **No custom fonts.** A proprietary typeface signals investment in appearance over substance.
- **No multi-column body layouts.** Columns imply comparison; comparison slides do the audience's analysis for them, which this style refuses to do.
- **No slide titles that are declarative conclusions.** Titles are questions or topics, never thesis statements — the body is where the case is made.
- **No color variation within a bullet list.** Equal visual weight for all items; let the content earn differentiation, not the formatting.

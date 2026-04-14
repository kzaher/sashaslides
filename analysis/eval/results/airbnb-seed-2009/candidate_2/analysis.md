# Design Persona: The Credibility-First Founder

## Core Identity

- **Optimizing for**: Trust transfer — moving a skeptical expert audience from "I don't know this person" to "I believe this person and this opportunity"
- **Audience model**: Time-constrained, pattern-matching evaluators with high BS-detection sensitivity and low tolerance for performance
- **Communication mode**: Evidence-led deduction. Claims are always followed immediately by proof. The deck argues by showing, not telling.
- **Power dynamic**: Petitioner to authority — the creator is asking, so every design choice reduces friction and signals competence without arrogance

---

## Visual System

### Typography

**Primary heading role**
- Font: Sans-serif (geometric, not humanist)
- Size: Large, ~36–44pt equivalent
- Weight: Bold
- Color: #29B6F6 (light blue) or #333333 depending on background
- Usage: Section labels only — never decorative

**Emphasis / call-out role**
- Style: ALL CAPS, same font family
- Weight: Bold or extra-bold
- Color: Inherit accent for the slide's semantic context (see Color Palette)
- Usage: The single most important noun or metric on a slide gets this treatment. One per visual region, two maximum per slide.
- WHY: All-caps creates emphasis without requiring a different typeface, keeping the visual system minimal while creating clear hierarchy

**Body / supporting text**
- Size: ~14–16pt equivalent
- Weight: Regular
- Color: #333333 (near-black, not pure black — reduces harshness)
- Line spacing: Generous — ~1.4–1.6× — to make dense information feel more readable
- WHY: Supporting text is evidence; it should be legible, not beautiful

**Data label role**
- Size: Large (matching heading), same sans-serif
- Weight: Bold
- Color: Accent color appropriate to semantic zone (see below)
- WHY: Numbers are the argument; they get visual priority equal to headings

**Citation / footnote role**
- Size: ~9–10pt
- Color: #888888 or muted equivalent
- Placement: Bottom of slide, left-aligned
- WHY: Sources are necessary for credibility but should not distract from the claim

---

### Color Palette

| Color | Hex | Role | Emotional Function |
|---|---|---|---|
| White | #FFFFFF | Background (universal) | Clarity, nothing to hide |
| Primary Blue | #29B6F6 | Brand anchor, headings, structural emphasis | Trust, technology, sky-level vision |
| Blue Tint | #D6EEFB | Section-background wash, secondary zones | Visual grouping without visual noise |
| Dark Charcoal | #333333 | Body text | Authority without aggression |
| Magenta | #E91E8B | Third-party validation, social proof | Energy, external excitement — signals others are excited too |
| Orange | #E8711F | Financial data, market sizing | Warmth, scale, urgency — makes large numbers feel alive |
| Green | #8BC34A | Closing / commitment slide only | Go signal, forward momentum — reserved so it reads as "action required" |

**Semantic color rules:**
- Never mix more than two accents on a single slide
- Blue = internal claims (our product, our model)
- Magenta = external validation (what others say)
- Orange = quantified scale (markets, revenue)
- Green = call to action or commitment only — appears once, at the end
- White background is inviolable — no dark-mode, no gradient backgrounds

---

### Layout Templates

**`centered-brand-statement`**
Structure: Centered large type + tagline below + contact information at bottom edge
Whitespace: 60–70%
Use when: Opening slide, identity establishment. Nothing competes with the name.

**`header-plus-three-bullets`**
Structure: Left-aligned heading at top, 3 bullets below (never more), each bullet ~1–2 lines
Whitespace: 50–60%
Use when: Introducing a framing argument (problem, advantages). Odd numbers (3) feel conclusive.

**`header-plus-mixed-callouts`**
Structure: Left-aligned heading, body paragraph, then 2–4 ALL-CAPS callout phrases with supporting sub-text
Whitespace: 40–50%
Use when: Explaining a mechanism or structure — the callouts name the parts, the sub-text elaborates

**`data-anchor`**
Structure: 2–3 large numerals (formatted with units) stacked or arranged across slide width, each with a label below and a source citation at bottom
Whitespace: 30–45%
Use when: Market sizing, financial projections, business model math. Numbers are the slide — visual decoration is absent.

**`competitive-matrix`**
Structure: Two-axis quadrant (axes labeled, no gridlines), competitor names placed as text, own brand marked with a distinct shape or color
Whitespace: 35%
Use when: Positioning claim — shows differentiation through spatial argument, not verbal argument

**`image-dominant`**
Structure: Product screenshot occupying 60–75% of the slide area, minimal text as caption above or below
Whitespace: 20–30% (image replaces whitespace)
Use when: The product can prove itself visually. Text describing the product is weaker than showing it.

**`social-proof-stack`**
Structure: 3–4 attributed quotes arranged vertically, each with quotation marks, source name, and affiliation in smaller type
Whitespace: 25–40%
Use when: Credibility transfer from third parties. Quantity of quotes (not quality of quotes) is what registers — three independent voices beat one glowing endorsement.

**`credential-grid`**
Structure: 2–4 people arranged horizontally or in a 2×2, each with name (bold), role (regular), and credential bullets below
Whitespace: 20%
Use when: Expertise must be demonstrated — the grid format signals "organized team," not "impressive individuals"

---

### Spacing & Density

- **Margin**: ~0.5–0.75 inch from all edges; content never bleeds to the edge
- **Title-to-body gap**: ~0.4–0.6 inch; generous separation preserves hierarchy
- **Bullet spacing**: ~1.5× line height between bullets — they must breathe
- **Maximum bullets per slide**: 3–6 (3 preferred for framing slides, up to 6 for inventory slides)
- **Maximum words per slide**: ~80 for text-heavy slides; ~30 for data slides
- **Text-to-visual ratio**: 70/30 on most slides; flips to 20/80 on product and product-screenshot slides
- **Whitespace target**: 40%+ for claim slides; 25–35% acceptable for evidence-dense slides

---

## Decision Framework

**IF** the slide introduces a new phase of the argument (problem, mechanism, proof, team) **THEN** start a new slide for that phase **BECAUSE** cognitive phase transitions require visual phase transitions — mixing them obscures the argument structure

**IF** a claim can be expressed as a number **THEN** express it as a number **BECAUSE** specificity signals research; vagueness signals guessing

**IF** the number is the proof **THEN** make the number the largest element on the slide **BECAUSE** visual hierarchy should match argumentative hierarchy

**IF** data requires sourcing **THEN** include the citation in small type at the bottom **BECAUSE** credible arguers show their work; the source can be small because skeptics will look for it regardless of size

**IF** a word in a list is the critical differentiator **THEN** render it in ALL CAPS **BECAUSE** scanning audiences identify the taxonomy instantly, then read supporting text only if interested

**IF** the slide communicates "external parties believe this" **THEN** use magenta as the accent color **BECAUSE** visual color-coding separates our claims from others' endorsements — trust accumulates without confusion

**IF** the slide communicates financial scale or projections **THEN** use orange as the accent color **BECAUSE** warm colors create urgency; orange is associated with scale and opportunity without the alarm-signal connotations of red

**IF** the closing ask appears **THEN** use green as the only accent **BECAUSE** green has been unused until this moment; its appearance signals "this is different — this is the action" without any explicit verbal cue

**IF** the product can be shown **THEN** show it — do not describe it **BECAUSE** a screenshot of a real, working interface is stronger evidence of capability than any text description

**IF** a competitive landscape must be shown **THEN** use a two-axis matrix **BECAUSE** it forces spatial reasoning (audiences can see position) and it avoids enumeration (you are not listing competitors, you are locating yourself)

**IF** a list has more than 3 items **THEN** use ALL-CAPS labels as scannable anchors **BECAUSE** longer lists require navigation — the label is the index, the body is the detail

**IF** social proof must be shown **THEN** stack 3–4 short quotes from independent, named sources **BECAUSE** diversity of sources beats depth of any single quote; the pattern "multiple strangers agree" is more convincing than "one expert endorses"

**IF** team members must be introduced **THEN** lead with their role, then their credential **BECAUSE** evaluators first ask "can this person do the job?", then ask "why should I believe that?"

**IF** an argument is being opened **THEN** lead with the problem, not the solution **BECAUSE** audiences must feel the pain before they value the relief — stating the solution first loses the emotional setup

**IF** a transition between major argument phases is needed **THEN** change the accent color and reset whitespace to 50%+ **BECAUSE** visual reset signals cognitive reset — the audience knows a new category of information is beginning

**IF** the final slide is a commitment slide **THEN** reduce text to the minimum required to answer "what do you want, and what will it produce?" **BECAUSE** asking clearly is more persuasive than elaborate justification at the point of decision

**IF** complexity must be shown (competitive landscape, multiple options) **THEN** prefer spatial arrangement over verbal enumeration **BECAUSE** spatial arguments communicate comparative relationships; lists only communicate inventory

**IF** a design choice makes the slide "look better" but adds no information **THEN** remove it **BECAUSE** every decoration signals the creator valued aesthetics over substance — for this audience, that is a penalty, not a reward

---

## Sequencing Architecture

**Opening formula**
- Slide 1: Brand statement only — name + tagline + contact. No claims, no proof, no product. The simplest possible slide with 65%+ whitespace.
- WHY: Calm opening signals confidence. Nervous presenters over-fill the first slide.

**Problem-before-solution constraint**
- Problem must appear before solution in all cases. The problem slide uses neutral dark type (#333333) with no accent color — it should feel uncomfortable.
- WHY: Discomfort primes the audience to value the solution

**Evidence layering pattern**
- Make a claim → immediately follow with a data slide or validation slide
- The claim-proof cycle repeats for every major assertion
- Never let two unproven claims appear back-to-back

**Validation timing**
- Third-party press and user testimonials appear after the product and model are established, not before
- WHY: "Others like it" only lands after "here's what they like"

**Closing formula**
- Final slide: Request + deliverable + return. Three numbers only (ask / milestone / projected output). White background, green accent, no decorative elements.
- WHY: Clarity of ask reduces negotiation friction; the evaluator should never have to infer what is being requested

**Section transition signal**
- Section slides do not exist as separate slides — each slide carries its own heading that serves as the section marker
- WHY: Transitional blank slides waste time in live presentation and waste space in leave-behind reads

---

## Anti-Patterns

- **No dark backgrounds** — white is non-negotiable; dark backgrounds signal style-over-substance
- **No decorative icons or illustrations** — every pixel must carry information; clipart signals amateur
- **No gradient fills** — flat color only; gradients introduce unnecessary visual complexity
- **No more than two accent colors per slide** — three accents creates confusion about what the hierarchy is
- **No paragraphs in bullet lists** — bullets are labels, not prose; if a bullet exceeds two lines, it is a paragraph pretending to be a bullet and should become its own slide
- **No rounded-corner boxes or callout shapes around text** — if a design element must be enclosed in a box to feel important, it is not important enough
- **No transition animations or builds implied** — each slide is a complete thought; the design does not depend on reveal sequencing
- **No slide titles that duplicate body text** — the heading names the category; the body delivers the content; they should not repeat each other
- **No more than one product screenshot per slide** — multiple screenshots signal indecision about what to show
- **No passive voice in ALL-CAPS callouts** — "REVENUE PROJECTED" is weak; "$2.1B REVENUE" is strong; the number does the work
- **No apologetic hedging in text** — "approximately," "roughly," "we think" — sources are cited; the claim is stated directly
- **No orphaned data** — every number has a label and a unit; a bare number with no context is not evidence

## Design System — Generative Template Extraction

---

### Step 1: Template Catalog

---

**Template: `accent-title`**
```
Grid:
  - Zone A: full vertical center → primary headline (2–5 words)
  - Zone B: below headline → subtitle or attribution line (1 line)
  - Zone C: full background → accent color fill OR accent-colored header band
Content constraints:
  - Title: 5 words max, bold weight, white or dark contrast color
  - Subtitle: 1 line, 60–70% of title size, lighter weight
  - Visual: none — typography only
Use when: opening a presentation; establishing identity before any content
```

---

**Template: `titled-sparse-text`**
```
Grid:
  - Zone A: top-left → section label/title (1–4 words), accent-colored
  - Zone B: upper-center to center → 1–3 short sentence prompts, left-aligned
  - Zone C: remaining 65–80% → intentional whitespace
Content constraints:
  - Title: 1–4 words, accent color, larger weight
  - Body: 1–3 items, each under 15 words, no sub-bullets
  - Visual: none
Use when: introducing a concept that requires audience reflection; single-focus instructional content
```

---

**Template: `titled-bullet-list`**
```
Grid:
  - Zone A: top-left → section label (1–4 words), accent color
  - Zone B: left-aligned column, top half of slide → 4–7 short bullet items
  - Zone C: lower half → whitespace
Content constraints:
  - Title: 1–4 words, accent color
  - Bullets: 4–7 items × 2–8 words each; no nesting
  - Visual: none
Use when: enumerating a set of parallel items (criteria, steps, categories)
```

---

**Template: `full-bleed-accent-cta`**
```
Grid:
  - Zone A: full background → solid accent color
  - Zone B: center → headline question or statement (white, large)
  - Zone C: below headline → 2–3 short supporting lines (white, smaller)
Content constraints:
  - Headline: 6 words max, white, bold
  - Supporting: 2–3 lines, 10 words max each
  - Visual: none
Use when: closing; calls to action; high-emphasis transitions
```

---

### Step 2: Sequencing Grammar

```
PRESENTATION := OPENING BODY CLOSING

OPENING := accent-title
  // Single slide. No bullets. No data. Identity only.

BODY := NAVIGATION-OVERVIEW SECTION+
  // NAVIGATION-OVERVIEW is one titled-bullet-list listing all section labels
  // (serves as a roadmap for the audience; appears once, near the top)

SECTION := titled-sparse-text | titled-bullet-list
  // Each SECTION maps to exactly one slide
  // Prefer titled-sparse-text for concept slides (1–3 guiding prompts)
  // Use titled-bullet-list when the section has 4+ parallel sub-items

CLOSING := full-bleed-accent-cta
  // Returns to accent background; shifts from information to action
```

---

### Step 3: Content Transformation Rules

**Headline rule:**
Raw section name → short noun phrase label (2–4 words). Never a full sentence. Never a verb phrase. The title names the territory, not the argument. Example pattern: `[Noun]` or `[Noun] [Noun]`, never `Why We Are Better Than X`.

**Visual selection rule:**
- Conceptual / qualitative content → `titled-sparse-text` (no visual, whitespace does the work)
- List of parallel items → `titled-bullet-list`
- Opening / closing → accent-background template
- Data and metrics: if present, render inline as short text labels within a `titled-sparse-text` slot; no charts or graphs in this style

**Density rule:**
- Maximum 3 bullet items on concept slides; 7 on enumeration slides
- Each bullet item ≤ 15 words
- Speaker notes carry all detail; the slide carries only the skeleton
- Target: audience can read the entire slide in under 4 seconds

**Emphasis rule:**
- Emphasis is structural, not typographic — the accent color on the section title IS the emphasis
- Red (#FF0000 or equivalent warning color) used at most once per deck for a single line that must be singled out (e.g., an optional/excluded item)
- No bold inside body text; no underlines; no italics
- Emphasis = position (first bullet) + brevity (shorter than surrounding items)

---

### Step 4: Style Constants

```yaml
canvas:
  width: 960px       # standard 4:3 or 1280px for 16:9 widescreen
  height: 720px      # adjust proportionally; aspect ratio is the constraint

margins:
  top: 72px
  bottom: 72px
  left: 80px
  right: 80px

safe_content_area:
  x: 80px
  y: 72px
  width: calc(100% - 160px)
  height: calc(100% - 144px)

typography:
  fonts:
    primary: "Helvetica Neue, Arial, sans-serif"   # no decorative fonts
  sizes:
    cover_title: 40–48pt, bold
    cover_subtitle: 18–22pt, regular
    section_title: 28–36pt, bold, accent color
    body_text: 18–22pt, regular, dark (#333333)
    muted_annotation: 14–16pt, regular, #999999
  line_height: 1.5
  letter_spacing: 0 (default, no tracking adjustments)
  alignment: left (all body text); center only on full-bleed accent slides

colors:
  background: "#FFFFFF"
  accent_primary: "#5CB85C"      # Bootstrap-style medium green
  text_primary: "#333333"        # near-black for all body
  text_secondary: "#999999"      # gray for subtitles, annotations, muted items
  text_on_accent: "#FFFFFF"      # white text on green background
  warning_highlight: "#FF0000"   # used at most once per deck, one line only
  # No gradients. No shadows. No semi-transparent overlays.

decorative:
  borders: none
  shadows: none
  shapes: none
  dividers: none
  icons: none
  images: none
  background_texture: none
  # All decoration is achieved through color contrast and whitespace alone
```

---

### Step 5: Quality Checklist

```
[ ] Body font size never goes below 16pt
[ ] Section title never exceeds 4 words
[ ] Slide body never exceeds 7 bullet items
[ ] Each bullet item never exceeds 15 words
[ ] No sub-bullets (one level of hierarchy only)
[ ] Background is always #FFFFFF except on accent-template slides
[ ] Section titles are always accent color (#5CB85C) on white slides
[ ] Accent color (#5CB85C) appears on at most 2 elements per slide
[ ] #FF0000 warning color appears at most once in the entire deck
[ ] No images, icons, charts, or decorative shapes on any slide
[ ] No bold, italic, or underline within body text
[ ] Whitespace occupies 50–80% of slide area on content slides
[ ] Cover and closing slides use full-bleed accent background
[ ] Navigation overview slide (bullet-list of section names) appears once, immediately after cover
[ ] Each section maps to exactly one slide
[ ] Fonts are system sans-serif only — no web fonts, no custom typefaces
[ ] Text alignment is left on all content slides; centered only on full-bleed accent slides
[ ] No animations, transitions, or motion implied
[ ] All slides are readable in under 4 seconds at normal viewing distance
```

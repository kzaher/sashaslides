# Proposed Architecture: SashaSlides AI Pipeline

Based on research into Manus.im, academic literature, and open source components.

## Design Philosophy

Key insights driving the architecture:
1. **HTML as intermediate format** — Manus validates this, LayoutGPT proves LLMs can generate it, all rendering tools consume it
2. **Edit-based > generate-from-scratch** — PPTAgent (SOTA) shows adapting reference templates beats de novo generation
3. **Multi-stage pipeline > end-to-end** — break the problem into composable, debuggable stages
4. **Aesthetic scoring enables iteration** — render, score, regenerate if below threshold
5. **No training needed for v1** — LayoutGPT/LayoutPrompter show prompting alone achieves strong results

## Architecture Overview

```
User Input (Markdown + style preferences)
         │
         ▼
┌─────────────────────┐
│  1. Content Parser   │  Markdown → structured slide descriptors
│     (existing)       │  Title, body, notes, images, layout hints
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  2. Template Matcher │  Find closest reference slide from library
│     (existing)       │  Score by tag overlap, element count, keywords
└──────────┬──────────┘  PPTAgent-style functional type matching
           │
           ▼
┌─────────────────────┐
│  3. Layout Generator │  ** NEW: LLM-based layout generation **
│     (Claude API)     │  LayoutGPT approach: few-shot HTML/CSS generation
└──────────┬──────────┘  Input: content + template + design system
           │
           ▼
┌─────────────────────┐
│  4. HTML Renderer    │  Generate full HTML/CSS per slide
│     (reveal.js)      │  Apply design system (fonts, colors, spacing)
└──────────┬──────────┘  Inject content into layout structure
           │
           ▼
┌─────────────────────┐
│  5. Visual Render    │  HTML → PNG screenshots
│     (Puppeteer/CDP)  │  Already available in devcontainer
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  6. Quality Scorer   │  ** NEW: Aesthetic evaluation **
│     (CLIP-IQA /      │  Score each slide for visual quality
│      LAION aesthetic) │  Check readability, alignment, contrast
└──────────┬──────────┘
           │
           ▼
       Score OK? ──No──→ Loop back to step 3 with feedback
           │
          Yes
           │
           ▼
┌─────────────────────┐
│  7. Export           │  Final output generation
│     (Slides API /    │  Google Slides via CDP keyboard automation
│      marp-cli /      │  Or PPTX via python-pptx / marp-cli
│      Puppeteer PDF)  │  Or PDF via Puppeteer
└─────────────────────┘
```

## Phase Plan

### Phase 1: HTML-First Pipeline (No Training, No New Models)

**Goal**: Replace Slides API batch updates with HTML slide generation + CDP push

**Components**:
- Claude API (structured output) for content + layout generation
- reveal.js or Marp for HTML slide rendering
- Puppeteer (existing CDP) for screenshots and quality verification
- Existing template matcher + markdown parser

**Key change**: Instead of generating Slides API `batchUpdate` requests, generate HTML/CSS per slide. This is:
- More flexible (full CSS control)
- Easier for LLMs (HTML is well-represented in training data)
- Easier to verify (render + screenshot)
- Validated by Manus's approach

**Prompt engineering strategy** (from LayoutGPT paper):
- Define design system in system prompt: font pairs, color palette, spacing grid
- Few-shot examples of good slides as HTML
- Constraint-based generation: max word counts, hierarchy rules
- Output: complete `<section>` element per slide

### Phase 2: Aesthetic Scoring Loop

**Goal**: Automated quality verification and iteration

**Components**:
- LAION Aesthetic Predictor or CLIP-IQA for visual quality scoring
- Programmatic checks: contrast ratio, text readability, alignment consistency
- Feedback loop: low-scoring slides get regenerated with specific improvement instructions

**Implementation**:
```
render_slide(html) → screenshot → score(screenshot)
if score < threshold:
    feedback = analyze_issues(screenshot)  # Claude vision
    html = regenerate_with_feedback(html, feedback)
    repeat (max 3 iterations)
```

### Phase 3: Template Library & Reference-Based Generation

**Goal**: PPTAgent-style reference slide system

**Components**:
- Index past presentations (extract functional types, content schemas)
- Semantic template matching (embed slides with CLIP, nearest-neighbor retrieval)
- Edit-based generation: find closest reference, adapt it rather than generate from scratch

**Training data**:
- Parse existing PPTX templates (SlidesGo, free templates) with python-pptx
- Extract: layout structure, element positions, text styles, color palettes
- Build a searchable template library indexed by functional type + visual style

### Phase 4: Fine-Tuned Open Source Model

**Goal**: Replace Claude API with a specialized open model for cost/latency reduction

**Components**:
- Fine-tune Llama-3 or Mistral on slide generation task
- Training data: (topic, content, template) → HTML/CSS output pairs
- Use DPO with aesthetic scoring for alignment
- Tools: LLaMA-Factory + TRL

**Data collection**:
1. Use Claude API (Phase 1) to generate thousands of slide examples
2. Score each with aesthetic model
3. Create preference pairs (high-score vs low-score for same content)
4. Fine-tune with DPO on preference data

---

## Comparison: Current vs Proposed

| Aspect | Current (Slides API) | Proposed (HTML-first) |
|--------|---------------------|----------------------|
| **Format** | Google Slides API batch updates | HTML/CSS per slide |
| **Flexibility** | Limited to Slides API capabilities | Full CSS/HTML power |
| **LLM compatibility** | Complex JSON structure | HTML is natural for LLMs |
| **Verification** | Screenshot after push | Render locally before push |
| **Iteration** | Difficult to undo API calls | Re-render HTML instantly |
| **Export** | Google Slides only | PPTX, PDF, Google Slides, web |
| **Quality control** | Manual visual check | Automated aesthetic scoring |

## Recommended First Steps

1. **Try Marp pipeline**: `markdown → marp-cli → PPTX/HTML/PDF`. Simplest possible test. If output quality is acceptable, this is the fastest path.

2. **Build reveal.js template system**: Create 10-15 slide templates as HTML. Test Claude generating content that fills them.

3. **Integrate CLIP-IQA**: Install `pip install clip-iqa`, score rendered slides. Establish quality baselines.

4. **Study PPTAgent code**: Their reference-based generation and PPTEval framework are directly applicable.

---

## Key Technical Decisions

### Why HTML over Slides API?
- Manus generates HTML internally (validated in production)
- LLMs produce better HTML than Slides API JSON (more training data)
- HTML renders perfectly in browser (Puppeteer already available)
- Can convert HTML → PPTX via multiple tools (marp-cli, LibreOffice, python-pptx)
- Iteration is instant (re-render HTML) vs slow (re-push API calls)

### Why reveal.js over Slidev/Marp?
- Most mature ecosystem (67k stars)
- Simplest HTML structure (`<section>` elements)
- PDF export built in via Decktape
- Plugin system for extensions
- Marp is a strong alternative if PPTX export is the primary output

### Why CLIP-IQA over LAION Aesthetic?
- Zero-shot: no training data needed
- Can evaluate specific qualities ("professional", "clean", "readable")
- LAION is lighter weight if binary good/bad scoring suffices
- Recommend trying both and comparing on slide screenshots

### Why Claude API over fine-tuned model (for now)?
- Structured output via tool_use enforces slide schema
- Extended thinking for complex layout reasoning
- Vision for screenshot-based quality feedback
- No training infrastructure needed
- Fine-tune later with generated data (Phase 4)

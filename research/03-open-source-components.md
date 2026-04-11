# Open Source Components for AI Slide Generation

## 1. Presentation Frameworks

### reveal.js (67k+ stars)
- **Link**: https://github.com/hakimel/reveal.js
- **What**: HTML presentation framework. Slides are `<section>` elements. Supports nested slides, speaker notes, PDF export, LaTeX, syntax highlighting, animations.
- **API**: `Reveal.initialize()`, plugin system, postMessage API. Trivially generated from code.
- **Fit**: Best candidate for rendering layer. Generate HTML with LLM, inject into reveal.js, render with Puppeteer.

### Slidev (34k+ stars)
- **Link**: https://github.com/slidevjs/slidev
- **What**: Vue-powered Markdown presentations. Themes, components, code highlighting, Mermaid diagrams, PDF/SPA export.
- **API**: Single Markdown file with `---` separators. YAML frontmatter per slide for layout selection.
- **Fit**: Excellent for developer-facing slides. Markdown-in/slides-out is clean for LLM generation.

### Marp (~8k stars)
- **Link**: https://github.com/marp-team/marp
- **Packages**: `@marp-team/marp-core`, `@marp-team/marp-cli`
- **What**: Markdown to HTML/PDF/PPTX. CSS theme engine. Directives for styling.
- **API**: `marp-cli` CLI or `new Marp().render(markdown)`. **Native PPTX export**.
- **Fit**: Simplest pipeline. LLM generates Markdown + directives, marp-cli renders. PPTX export is a major advantage.

### python-pptx (2.2k+ stars)
- **Link**: https://github.com/scanny/python-pptx
- **What**: Python library for creating/modifying .pptx. Full control over slides, shapes, text, images, charts, tables.
- **Fit**: Critical for native PowerPoint output. Most existing AI slide tools use this.

### PptxGenJS
- **Link**: https://github.com/nicktgn/PptxGenJS
- **What**: JavaScript PPTX generation. Node.js/browser compatible.
- **Fit**: TypeScript pipeline alternative to python-pptx.

---

## 2. Open Source AI Slide Generation Projects

### PPTAgent (SOTA, academic)
- **Link**: https://github.com/icip-cas/PPTAgent
- **Paper**: https://arxiv.org/abs/2501.03936 (EMNLP 2025)
- **What**: Two-stage edit-based approach. Analyzes reference presentations for functional types, then generates editing actions. Includes PPTEval evaluation framework.
- **V2 features** (Dec 2025): Deep Research integration, free-form visual design, text-to-image generation.
- **Fit**: Most academically grounded. Reference architecture for our template-matching approach.

### Presenton
- **Link**: https://github.com/presenton/presenton
- **What**: Open-source AI presentation generator and API. Exports PPTX/PDF.
- **Fit**: Full working system to study as reference implementation.

### presentation-ai
- **Link**: https://github.com/allweonedev/presentation-ai
- **What**: Gamma alternative. Customizable themes, AI-generated content.

### slide-deck-ai
- **Link**: https://github.com/barun-saha/slide-deck-ai
- **What**: Co-create PowerPoint decks with AI.

### slides_generator (ai-forever)
- **Link**: https://github.com/ai-forever/slides_generator
- **What**: Single-prompt PPTX generation framework using LLMs + image generation API.

### OpenManus (general agent)
- **Link**: https://github.com/mannaandpoem/OpenManus
- **What**: Open source Manus alternative — general agent framework, not slide-specific.

---

## 3. Layout Generation Models

### LayoutGPT (NeurIPS 2023) -- NO TRAINING NEEDED
- **Link**: https://github.com/weixi-feng/LayoutGPT
- **What**: LLMs generate layouts as CSS/coordinates via in-context learning. 2D and 3D layouts from text.
- **Fit**: **Most practical approach**. Prompt LLM with slide layout examples, get coordinates. Zero training.

### LayoutDM (CVPR 2023)
- **Link**: https://github.com/CyberAgentAILab/layout-dm
- **What**: Discrete diffusion for controllable layout generation. Trained on Rico, PubLayNet, Magazine.
- **Fit**: Generate slide element positions given desired element set. Needs domain adaptation.

### PosterLlama (2024)
- **Link**: https://github.com/posterllama/PosterLlama
- **What**: Fine-tunes LLaMA for poster/layout generation. Outputs HTML/CSS.
- **Fit**: Very close to slides. Training approach replicable.

### LayoutFormer++ (Microsoft)
- **Link**: https://github.com/microsoft/LayoutGeneration
- **What**: Transformer-based with constraints. Unconditional, category-conditioned, and completion.

---

## 4. Aesthetic Scoring Models

### LAION Aesthetic Predictor -- RECOMMENDED
- **Link**: https://github.com/LAION-AI/aesthetic-predictor
- **Improved**: https://github.com/christophschuhmann/improved-aesthetic-predictor
- **PyPI**: `simple-aesthetics-predictor`
- **What**: CLIP embeddings + linear probe. Predicts aesthetic score 1-10. Lightweight.
- **Trained on**: SAC dataset (5K image-rating pairs), then used to filter LAION-5B.
- **Fit**: Score rendered slides cheaply. Use as reward signal or A/B testing.

### NIMA (Neural Image Assessment)
- **Link**: https://github.com/idealo/image-quality-assessment
- **What**: Predicts distribution of aesthetic ratings. MobileNet/InceptionV2 on AVA dataset.
- **Fit**: Richer output (distribution, not single score). More compute.

### CLIP-IQA -- ZERO-SHOT
- **Link**: https://github.com/IceClear/CLIP-IQA
- **What**: Zero-shot quality + aesthetic assessment via CLIP text prompts.
- **Fit**: Evaluate "professional", "clean", "modern" without any training.

### Programmatic Design Quality (no ML needed)
- **colorjs.io / chroma.js**: Color harmony analysis
- **axe-core**: Accessibility/contrast scoring
- Custom grid-alignment: bounding box analysis for alignment consistency
- Whitespace ratio, font pairing checks, contrast ratio calculations

---

## 5. Rendering & Export Tools

### Puppeteer (89k+ stars)
- **Link**: https://github.com/puppeteer/puppeteer
- **Fit**: Core rendering engine. Already in devcontainer. HTML slides -> PNG/PDF.

### Playwright (69k+ stars)
- **Link**: https://github.com/microsoft/playwright
- **Fit**: Alternative to Puppeteer. Cross-browser. Better API.

### Satori (Vercel, 11k+ stars)
- **Link**: https://github.com/vercel/satori
- **What**: JSX/HTML to SVG. No browser needed. Supports Flexbox, custom fonts.
- **Fit**: Fast server-side thumbnail generation. Limited CSS.

### Decktape (2.2k+ stars)
- **Link**: https://github.com/astefanutti/decktape
- **What**: PDF exporter for reveal.js, Slidev, impress.js.

### Sharp (29k+ stars)
- **Link**: https://github.com/lovell/sharp
- **What**: High-performance Node.js image processing.
- **Fit**: Post-processing rendered slides.

### LibreOffice Headless
- `libreoffice --headless --convert-to pdf presentation.pptx`
- **Fit**: Server-side PPTX-to-PDF/image conversion.

---

## 6. Training Data Sources

| Dataset | Size | Domain | Link |
|---------|------|--------|------|
| **Slideshare-1M** | 977K slides / 31K decks | General presentations | [Stanford](https://exhibits.stanford.edu/data/catalog/mv327tb8364) |
| **PS5K** | 5,873 paper-slide pairs | Academic (CV/NLP/ML) | Used by DOC2PPT |
| **SlideSpeech** | Large | Conference slides + audio | YouTube conferences |
| **SPaSe** | 2,000 slides | Slide segmentation (25 classes) | [KIT](https://cvhci.anthropomatik.kit.edu/~mhaurile/spase/) |
| **Crello** | ~23K templates | Graphic design | [Paper](https://arxiv.org/abs/2108.01249) |
| **PubLayNet** | ~1M pages | Document layout | [GitHub](https://github.com/ibm-aur-nlp/PubLayNet) |
| **RICO** | 66K+ screens | Mobile UI layouts | [interactionmining.org](http://interactionmining.org/rico) |
| **AVA** | 250K images | Aesthetic scores | CVPR 2012 |
| **SlidesGo** | Thousands of templates | Presentation templates | [slidesgo.com](https://slidesgo.com) |
| **Conference slides** | Varies | Academic presentations | NeurIPS/ICML/ACL websites |

### Data Collection Strategy
1. **Free templates**: Download from SlidesGo, SlidesCarnival, Google Slides templates
2. **Parse with python-pptx**: Extract layout structure, element positions, text styles
3. **Academic slides**: Mine conference websites for PDF slides, convert to images
4. **PDF layout detection**: Use existing layout models to extract element positions
5. **Synthetic generation**: Use Claude/GPT to generate slide content, pair with template layouts

---

## 7. Fine-Tuning Approaches

### No Training Needed (v1)
Multi-stage Claude API pipeline:
1. LLM generates structured outline (JSON)
2. LLM generates content per slide
3. Template matching / layout selection
4. LLM generates CSS/styling adjustments
5. Render with Puppeteer
6. Aesthetic scoring, iterate if below threshold

### Structured Output Fine-Tuning (v2)
- Fine-tune Llama-3/Mistral on `(topic, audience) -> slide_json` pairs
- Parse thousands of PPTX into JSON schema, pair with inferred topic/audience
- **Tools**: [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory) (30k+ stars), [axolotl](https://github.com/OpenAccess-AI-Collective/axolotl), [Unsloth](https://github.com/unslothai/unsloth)

### RLHF/DPO with Aesthetic Scoring (v3)
- Generate multiple slide variants
- Score with aesthetic model + readability metrics
- Use DPO (Direct Preference Optimization) to align model
- **Tools**: [TRL](https://github.com/huggingface/trl) for RLHF/DPO training

### Layout-Aware Fine-Tuning (PosterLlama approach)
- Train LLM to output HTML/CSS for slide layouts
- Input: content description + dimensions
- Output: HTML with absolute-positioned elements
- Can use LoRA for efficient fine-tuning

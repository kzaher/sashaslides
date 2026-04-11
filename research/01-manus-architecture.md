# How Manus.im Generates Slides

## Overview

Manus is an autonomous AI agent that generates presentations through an agentic multi-step pipeline. It does **not** use a traditional template engine — instead, it generates **HTML code for each slide** individually, then exports to PPTX/PDF/Google Slides.

## Architecture

### Foundation Models
- **Primary**: Claude 3.5/3.7 Sonnet (Anthropic) for reasoning and content generation
- **Supplementary**: Fine-tuned Alibaba Qwen models
- **Image generation**: Nano Banana Pro (built on Google Gemini 3 Pro) for studio-quality slide images
- Architecture supports "multi-model dynamic invocation" — routes subtasks to specialized models

### Multi-Agent System
- **Planner agent**: Uses Monte Carlo Tree Search (MCTS) for task decomposition
- **Execution agent**: Integrated with browser automation, shell commands, code execution
- **Verification agent**: Reviews and refines output
- Sub-agents are fully capable general-purpose Manus instances (not role-constrained)

### CodeAct Architecture
- Agents generate **executable Python code** as their action mechanism (not JSON tool calls)
- Based on 2024 CodeAct research showing higher success rates than rigid function calling
- Full Python interpreter available — can combine tools, maintain state, process data

### Execution Environment
- Ubuntu Linux VM per session with internet access
- Python 3.10, Node.js 20, headless browser
- Isolated containerization for security

Sources:
- [Architecture Behind Manus AI Agent](https://www.theunwindai.com/p/architecture-behind-manus-ai-agent)
- [Manus AI Technical Deep Dive — DEV Community](https://dev.to/sayed_ali_alkamel/manus-ai-a-technical-deep-dive-into-chinas-first-autonomous-ai-agent-30d3)
- [Reverse engineering gist](https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f)
- [arxiv paper: From Mind to Machine](https://arxiv.org/abs/2505.02024)

## Slide Generation Pipeline

### Step 1: Research & Planning
- User provides topic/prompt via chat, email, Slack, or document connection
- "Wide Research" system deploys sub-agents in parallel to search the web
- Outlines PPT structure and key points for each section
- Drafts content per section backed by sourced intelligence

### Step 2: HTML Code Generation (~6 min)
- **Designs and generates HTML code for each slide**
- This is the longest step in the pipeline
- Each slide is individually coded in HTML/CSS
- For Nano Banana Pro mode: each slide is generated as a single high-resolution image (text, graphics, layouts all in one visual)
- For editable mode: standard HTML slides with individual elements

### Step 3: Refinement
- Reviews and refines content and layout
- Natural language-based editing and regeneration
- Self-correction mechanisms

### Step 4: Export
- PowerPoint (.pptx) — fully editable
- Google Slides — cloud collaboration
- PDF — distribution
- Nano Banana Pro slides are now also editable (recent update)

Sources:
- [Can AI Make PowerPoint Slides? — Manus Blog](https://manus.im/blog/can-manus-create-slides)
- [Manus Slides Documentation](https://manus.im/docs/features/slides)
- [Manus Slides with Nano Banana Pro](https://manus.im/blog/manus-slides-nano-banana-pro)

## Key Technical Insights

### Context Engineering
- **KV-cache optimization** is their primary performance metric
- Stable prompt prefixes to avoid cache invalidation
- Append-only context, explicit cache breakpoints
- Cached tokens cost $0.30/MTok vs $3/MTok uncached (10x difference with Claude Sonnet)
- Average token ratio: ~100:1 (input:output)

### Tool Management
- Context-aware **state machine** masks token logits during decoding
- Preserves KV-cache while constraining action selection
- Tool names use consistent prefixes (`browser_`, `shell_`) for constraint enforcement

### File-System Memory
- File system as externalized context (unlimited size, directly operable)
- Compression strategies are restorable (URLs preserved when content dropped)
- Agents create/update `todo.md` files to push objectives into recent attention span

### Error Recovery
- Failed actions and error traces kept in context (not erased)
- Model implicitly updates beliefs and avoids repeating mistakes
- Structured variation in serialization templates to prevent overfitting

Source: [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

## Nano Banana Pro (Image Generation)

- Built on Google Gemini 3 Pro
- Generates slides as single high-resolution images
- Solves the "AI text rendering" problem — produces crisp, legible text directly on slides
- Creates custom diagrams, illustrations, photorealistic images
- Professional corporate layouts with clear visual hierarchy
- Recently made editable (can modify individual elements after generation)

Sources:
- [Nano Banana Pro Documentation](https://manus.im/docs/integrations/nano-banana-pro)
- [Editable Nano Banana Pro Slides](https://manus.im/blog/edit-slides-created-on-manus-with-nano-banana-pro)

## Comparison with Other AI Slide Tools

| Tool | Approach | Output | Design Quality |
|------|----------|--------|---------------|
| **Manus** | Agent + HTML generation + Nano Banana Pro | PPTX/PDF/GSlides | High (image-rendered) |
| **Gamma.app** | LLM + template system | Web-based slides | Medium-High |
| **Beautiful.ai** | Rule-based smart templates | Web/PPTX | High (constrained) |
| **Tome** | LLM + design system | Web-based | Medium |
| **SlidesAI** | GPT + Google Slides API | Google Slides | Medium |
| **Presenton** | Open source, LLM-based | PPTX/PDF | Medium |
| **PPTAgent** | Academic, reference-based | PPTX | Medium-High |

## Key Takeaway for SashaSlides

Manus's approach validates the **HTML-first generation** strategy:
1. Generate individual slides as HTML/CSS (not PowerPoint XML directly)
2. Use an LLM agent for content + layout decisions
3. Render to images for quality verification
4. Export to PPTX/PDF as final step
5. Use vision models for quality scoring and iteration

The most important architectural insight is that **each slide is coded individually in HTML** — this gives maximum design flexibility compared to template-based approaches.

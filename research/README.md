# AI Slide Generation Research

Research into building an AI-powered slide generation system, inspired by Manus.im and informed by academic literature and open source tools.

## Contents

| File | Description |
|------|-------------|
| [01-manus-architecture.md](01-manus-architecture.md) | How Manus.im generates slides in production |
| [02-academic-literature.md](02-academic-literature.md) | Scientific papers on slide generation, layout models, and visual aesthetics |
| [03-open-source-components.md](03-open-source-components.md) | Open source tools, models, datasets for building a similar system |
| [04-proposed-architecture.md](04-proposed-architecture.md) | Proposed architecture for SashaSlides using open source components |

## Key Findings

1. **Manus generates HTML per slide**, then converts to PPTX. Uses Nano Banana Pro (built on Google Gemini 3 Pro) for image-style slides. Multi-agent architecture with Claude 3.5/3.7 + Qwen models.

2. **Academic frontier** has moved from rule-based (2009-2015) to deep generative layout models (2019-2022) to LLM-based approaches (2023+). Key papers: DOC2PPT, LayoutGPT, LayoutDM, PPTAgent.

3. **Practical approach**: Claude API + reveal.js/Marp templates + Puppeteer rendering + LAION/CLIP aesthetic scoring. No training needed for v1. Fine-tuning Llama-3 with DPO for v2.

---
*Research compiled: 2026-04-10*

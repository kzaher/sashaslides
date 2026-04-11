# Academic Literature Review: AI Slide Generation, Layout Models & Visual Aesthetics

## Summary of Key Trends

| Era | Approach | Key Papers |
|-----|----------|-----------|
| 2009-2015 | Rule-based & early ML | PPSGen, Beamer & Girju |
| 2019-2021 | Deep generative layout models | LayoutGAN, LayoutVAE, LayoutTransformer |
| 2021-2022 | End-to-end neural doc-to-slides | DOC2PPT, D2S |
| 2023-2024 | LLM-based approaches | LayoutGPT, LayoutPrompter, Slide4N, PPTAgent |
| 2023-present | Diffusion models for layout | LayoutDM, LayoutDiffusion |

---

## 1. Automated Slide Generation from Text/Documents

### DOC2PPT: Automatic Presentation Slides Generation from Scientific Documents
- **Authors**: Tsu-Jui Fu, William Yang Wang, Daniel McDuff, Yale Song
- **Year**: 2022 | **Venue**: AAAI 2022
- **Key findings**: End-to-end model generating slides from scientific papers. Cross-modal architecture handles text, figures, and layout jointly. Introduces large-scale dataset of paper-slide pairs.
- **Link**: https://arxiv.org/abs/2101.11796
- **Relevance**: Directly addresses our problem — one of the most cited works in this space.

### D2S: Document-to-Slide Generation Via Query-Based Text Summarization
- **Authors**: Edward Sun, Yufang Hou, Dakuo Wang, Yunfeng Zhang, Irene Li
- **Year**: 2021 | **Venue**: NAACL 2021
- **Key findings**: Frames slide generation as query-based summarization. Uses slide title as query to extract/generate bullet points from source document. Released paper-slide pair dataset.
- **Link**: https://arxiv.org/abs/2105.03664

### PPTAgent: Generating and Evaluating Presentations Beyond Text-to-Slides
- **Authors**: ICIP-CAS group
- **Year**: 2025 | **Venue**: EMNLP 2025
- **Key findings**: Two-stage edit-based approach: (1) analyzes reference presentations to extract slide-level functional types and content schemas, (2) drafts outline and iteratively generates editing actions. Introduces PPTEval for evaluation across Content, Design, and Coherence dimensions. Significantly outperforms existing methods.
- **Link**: https://arxiv.org/abs/2501.03936
- **Code**: https://github.com/icip-cas/PPTAgent
- **Relevance**: Most directly applicable to our template-matching architecture. State-of-the-art.

### DeepPresenter: Environment-Grounded Reflection for Agentic Presentation Generation
- **Year**: 2025
- **Link**: https://arxiv.org/abs/2602.22839
- **Key findings**: Agentic approach to presentation generation with environment-grounded reflection.

### PreGenie: An Agentic Framework for High-quality Visual Presentation Generation
- **Year**: 2025
- **Link**: https://arxiv.org/abs/2505.21660
- **Key findings**: Agentic framework focused on visual quality of generated presentations.

### SlideGen: A Multi-Agent Framework for Automated Slide Generation
- **Year**: 2025
- **Venue**: OpenReview
- **Link**: https://openreview.net/pdf/06887ef399cb4a70a0f039c14979cffcd5e12891.pdf

### PPSGen: Learning-Based Presentation Slides Generation for Academic Papers
- **Authors**: Yue Hu, Liangmin Wan, Qiang Lu
- **Year**: 2015 | **Venue**: IEEE TKDE
- **Key findings**: Extracts key content from academic papers, models relationship between paper sections and slide content.
- **Link**: https://doi.org/10.1109/TKDE.2014.2361484

### Slide4N: Creating Presentation Slides from Computational Notebooks with Human-AI Collaboration
- **Authors**: Fengjie Wang et al.
- **Year**: 2023 | **Venue**: CHI 2023
- **Key findings**: LLMs help generate slides from Jupyter notebooks. Human-in-the-loop refinement. Shows the effectiveness of multi-stage LLM pipeline.
- **Link**: https://doi.org/10.1145/3544548.3580753

### PPTC Benchmark: Evaluating LLMs for PowerPoint Task Completion
- **Authors**: Yiduo Guo et al.
- **Year**: 2024
- **Key findings**: Benchmark for evaluating LLMs on PowerPoint manipulation tasks — tests ability to create and modify slides programmatically.
- **Link**: https://arxiv.org/abs/2311.01767

### Talk to Your Slides: Efficient Slide Editing Agent with Large Language Models
- **Year**: 2025
- **Link**: https://arxiv.org/abs/2505.11604

### SlideSpawn: An Automatic Slides Generation System for Research Publications
- **Year**: 2024
- **Link**: https://arxiv.org/abs/2411.17719

### SciDuet: Large-Scale Dataset for Slide-Paper Matching
- **Year**: 2022 | **Venue**: ACL Findings
- **Key findings**: Large-scale dataset pairing academic papers with presentation slides.

### TalkSumm: Dataset for Slide-Talk Alignment
- **Authors**: Guy Lev et al.
- **Year**: 2019 | **Venue**: ACL 2019
- **Link**: https://arxiv.org/abs/1906.01461

---

## 2. Layout Generation and Design Automation

### LayoutGPT: Compositional Visual Planning and Generation with LLMs
- **Authors**: Weixi Feng, Wanrong Zhu, Tsu-Jui Fu et al.
- **Year**: 2023 | **Venue**: NeurIPS 2023
- **Key findings**: Uses LLMs (GPT-3.5/4) to generate 2D and 3D layouts from text in CSS-style format. Shows LLMs have implicit layout knowledge. No fine-tuning needed.
- **Link**: https://arxiv.org/abs/2305.15393
- **Code**: https://github.com/weixi-feng/LayoutGPT
- **Relevance**: Directly applicable — prompt LLM with slide layout examples, get coordinates back.

### LayoutPrompter: Awaken the Design Ability of Large Language Models
- **Authors**: Jiawei Lin et al.
- **Year**: 2023 | **Venue**: NeurIPS 2023
- **Key findings**: In-context learning with LLMs for layout generation. LLMs generate high-quality layouts through careful prompting without fine-tuning.
- **Link**: https://arxiv.org/abs/2311.06495
- **Relevance**: Shows prompting alone can achieve strong layout generation results.

### LayoutDM: Discrete Diffusion Model for Controllable Layout Generation
- **Authors**: Inoue et al.
- **Year**: 2023 | **Venue**: CVPR 2023
- **Key findings**: Discrete diffusion for layout generation. Supports conditional generation with various constraints. State-of-the-art on multiple benchmarks.
- **Link**: https://arxiv.org/abs/2303.08137
- **Code**: https://github.com/CyberAgentAILab/layout-dm

### LayoutGAN: Generating Graphic Layouts with Wireframe Discriminators
- **Authors**: Jianan Li et al.
- **Year**: 2019 | **Venue**: ICLR 2019
- **Key findings**: First GAN-based layout generation. Wireframe discriminator evaluates spatial arrangement. Generates layouts as bounding box sets.
- **Link**: https://arxiv.org/abs/1901.06767

### LayoutTransformer: Layout Generation and Completion with Self-Attention
- **Authors**: Kamal Gupta et al.
- **Year**: 2021 | **Venue**: ICCV 2021
- **Key findings**: Autoregressive Transformer for layout generation as sequences. Handles unconditional and completion. Outperforms GANs.
- **Link**: https://arxiv.org/abs/2006.14615

### BLT: Bidirectional Layout Transformer for Controllable Layout Generation
- **Authors**: Kong et al.
- **Year**: 2022 | **Venue**: ECCV 2022
- **Key findings**: Bidirectional Transformer with discrete diffusion for controllable layout generation.
- **Link**: https://arxiv.org/abs/2112.05112

### LayoutVAE: Stochastic Scene Layout Generation from a Label Set
- **Authors**: Akash Abdu Jyothi et al.
- **Year**: 2019 | **Venue**: ICCV 2019
- **Link**: https://arxiv.org/abs/1907.10719

### Variational Transformer Networks for Layout Generation
- **Authors**: Diego Martin Arroyo et al.
- **Year**: 2021 | **Venue**: CVPR 2021
- **Link**: https://arxiv.org/abs/2104.02416

### LayoutFormer++: Conditional Layout Generation via Constraint Serialization
- **Authors**: Jiang et al.
- **Year**: 2023 | **Venue**: CVPR 2023
- **Code**: https://github.com/microsoft/LayoutGeneration

### Content-Aware Generative Modeling of Graphic Design Layouts
- **Authors**: Xinru Zheng et al.
- **Year**: 2019 | **Venue**: ACM TOG (SIGGRAPH)
- **Key findings**: Conditional GAN for graphic design layouts considering content semantics.
- **Link**: https://doi.org/10.1145/3306346.3322971

### PosterLlama: Bridging Design Ability of LLMs to Content-Aware Layout Generation
- **Year**: 2024
- **Key findings**: Fine-tunes LLaMA for poster/layout generation. Outputs HTML/CSS coordinates.
- **Code**: https://github.com/posterllama/PosterLlama
- **Relevance**: Very close to slide generation — approach can be replicated for slides.

---

## 3. Visual Aesthetics Models and Scoring

### NIMA: Neural Image Assessment
- **Authors**: Hossein Talebi, Peyman Milanfar (Google Research)
- **Year**: 2018 | **Venue**: IEEE TIP
- **Key findings**: Predicts aesthetic and technical quality score distributions using CNNs. Captures subjective variation in preferences. Widely-used baseline.
- **Link**: https://arxiv.org/abs/1709.05424
- **Trained on**: AVA dataset (255K images, rated by 200+ photographers)

### CLIP-IQA: Exploring CLIP for Blind Image Quality Assessment
- **Year**: 2023 | **Venue**: AAAI 2023
- **Key findings**: Zero-shot/few-shot image quality and aesthetic assessment via CLIP. Can assess qualities like "professional", "clean", "modern" via text prompts.
- **Code**: https://github.com/IceClear/CLIP-IQA
- **Relevance**: Can evaluate slide aesthetics without training.

### LAION Aesthetic Predictor
- **Key findings**: CLIP embeddings + linear probe predicts aesthetic score (1-10). Trained on SAC dataset (5K image-rating pairs), then used to filter LAION-5B into aesthetic subsets.
- **Code**: https://github.com/LAION-AI/aesthetic-predictor
- **Improved version**: https://github.com/christophschuhmann/improved-aesthetic-predictor
- **Relevance**: Lightweight aesthetic scorer for rendered slides. 10x cost reduction vs full model.

### MUSIQ: Multi-Scale Image Quality Transformer
- **Authors**: Junjie Ke et al.
- **Year**: 2021 | **Venue**: ICCV 2021
- **Key findings**: Transformer-based IQA handling arbitrary resolution. SOTA on multiple benchmarks.
- **Link**: https://arxiv.org/abs/2108.05997

### Learning Visual Importance for Graphic Designs and Data Visualizations
- **Authors**: Zoya Bylinskii et al.
- **Year**: 2017 | **Venue**: UIST 2017
- **Key findings**: Predicts visual importance maps for graphic designs — which elements attract attention first.
- **Link**: https://arxiv.org/abs/1708.02660

### AVA: Aesthetic Visual Analysis Dataset
- **Authors**: Naila Murray et al.
- **Year**: 2012 | **Venue**: CVPR 2012
- **Key findings**: ~250K images with aesthetic scores. Standard benchmark for aesthetic assessment.

### Color Compatibility from Large Datasets
- **Authors**: Peter O'Donovan et al.
- **Year**: 2011 | **Venue**: ACM SIGGRAPH
- **Key findings**: Learns color compatibility models. Useful for automatic color scheme selection.

### DesignScape: Design with Interactive Layout Suggestions
- **Authors**: Peter O'Donovan et al.
- **Year**: 2015 | **Venue**: CHI 2015
- **Key findings**: Energy-based models score layouts and suggest refinements interactively.
- **Link**: https://doi.org/10.1145/2702123.2702149

---

## 4. Key Datasets

| Dataset | Domain | Size | Source | Notes |
|---------|--------|------|--------|-------|
| **PS5K** | Paper-slide pairs | 5,873 pairs | Academic proceedings | CV/NLP/ML papers |
| **SciDuet** | Paper-slide pairs | ~5K pairs | Academic | With alignment annotations |
| **DOC2PPT** | Paper-slide pairs | ~5K papers | Academic | Multi-modal |
| **Slideshare-1M** | General slides | 977K slides (31K decks) | SlideShare API | [Stanford](https://exhibits.stanford.edu/data/catalog/mv327tb8364) |
| **SPaSe** | Slide segmentation | 2,000 slides | Academic | 25 pixel-wise classes |
| **SlideSpeech** | Slides + audio | Large | YouTube conferences | Multi-modal |
| **Crello** | Graphic designs | ~23K templates | VistaCreate | Rich element annotations |
| **PubLayNet** | Document layouts | ~1M pages | PubMed | [GitHub](https://github.com/ibm-aur-nlp/PubLayNet) |
| **RICO** | UI layouts | ~66K screens | Mobile apps | Transfer learning |
| **AVA** | Image aesthetics | ~250K images | DPChallenge | Aesthetic scores |
| **Magazine** | Magazine layouts | ~4K pages | Various | Multi-element |
| **CGL** | Graphic layouts | ~60K | Canva | Layout annotations |

---

## 5. Conclusions for SashaSlides

### Most Relevant Papers (must-read)
1. **PPTAgent** (2025) — closest to our architecture, edit-based approach with reference slides
2. **LayoutGPT** (2023) — proves LLMs can generate layouts via prompting alone
3. **DOC2PPT** (2022) — end-to-end neural slide generation baseline
4. **LAION Aesthetic Predictor** — practical quality scoring for slide images
5. **PosterLlama** (2024) — fine-tuning LLMs for HTML/CSS layout output

### Key Insights from Literature
- **LLMs have implicit layout knowledge** (LayoutGPT, LayoutPrompter) — no fine-tuning needed for decent layouts
- **Edit-based > generate-from-scratch** (PPTAgent) — adapting reference templates beats generating de novo
- **Multi-stage pipelines outperform end-to-end** — outline first, then content, then layout, then render
- **Aesthetic scoring enables iteration** — render, score, re-generate if below threshold
- **HTML/CSS is the best intermediate format** — both LLMs and rendering engines handle it well

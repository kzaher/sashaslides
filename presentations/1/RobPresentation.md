# Rob's Presentation — Gemini Search Q2 Update

**Status:** Created and pushed to Google Slides
**Presentation URL:** https://docs.google.com/presentation/d/1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY/edit
**Date:** April 2026

## Structure (19 slides)

### Title (1 slide)
1. **Gemini Search: Q2 Update for Rob** — Search Triggering & Optimization Team

### Part 1: Real-Time Search Signals (4 slides)
2. Agenda
3. Section header
4. The Problem: Stale Triggering — under-triggering during breaking news, over-triggering on stable facts
5. What We Built: Three Real-Time Signals — QFS, Trending Topic Overlay, Staleness Detector
6. Results — Freshness accuracy 72%→91%, trigger rate -8%, CSAT +3.2pts

### Part 2: Latency & Cost Optimizations (5 slides)
7. Section header
8. Skip SGM for Short Queries — -180ms p50 on 41% queries, -38% SGM costs
9. Small Models for First-Step Thinking — -320ms first-token, Flash plan matches 97.8%
10. Fewer Search Results to Model — -45% grounding context, top 5 default
11. Combined Impact — P50 2.8s→2.1s (-25%), cost -39%

### Part 3: World Cup 2026 Generative UI (7 slides)
12. Section header
13. The Opportunity — first World Cup with Gemini, 5-10x traffic
14. Generative UI: How It Works — model generates UI spec, not just text
15. What We're Building — live match, pre/post match, tournament dashboards
16. Personalization & Localization — team detection, RTL, time zones
17. Timeline: 61 Days to Kickoff — milestones through June 11
18. Risks & Asks for Rob — latency, accuracy, scale, 2 FTE ask

### Closing (1 slide)
19. Thank You

## Files

| File | Purpose |
|------|---------|
| `content.md` | Raw content with full detail for each topic |
| `slides.md` | Slide-by-slide markdown (input to push script) |
| `RobPresentation.md` | This file — overview and status |
| `screenshots/` | Visual verification screenshots |

## Scripts

| Script | Purpose |
|--------|---------|
| `/push-slides` | Push slides.md to Google Slides via Chrome keyboard automation |
| `/screenshot-slides` | Screenshot all slides from a presentation |
| `presentations/scripts/goto-slide.ts` | Navigate to a specific slide and screenshot |

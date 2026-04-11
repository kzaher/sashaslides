# Gemini Search Integration — Update for Rob

**Presenter:** Search Triggering & Optimization Team
**Audience:** Director Rob
**Date:** April 2026

---

## Topic 1: Real-Time Search Signals Improving Gemini Triggering

### The Problem We Solved

Gemini's search triggering was operating on stale signals. When a user asked "What's happening with the stock market right now?", the triggering model had no awareness of whether markets were actually volatile at that moment. It treated every query the same — either triggering search or not based purely on the query text and static features.

This created two failure modes:
- **Under-triggering:** During breaking news, Gemini would confidently answer with outdated training data because the query didn't look like it "needed" search.
- **Over-triggering:** For stable factual queries ("Who wrote Hamlet?"), we'd waste a search roundtrip because the model couldn't distinguish time-sensitive from time-stable queries.

### What We Built

We now pipe real-time signals from Google Search infrastructure directly into Gemini's search triggering decision:

1. **Query Freshness Score (QFS):** A signal from Search that indicates how much the top results for a query cluster have changed in the last N hours. High QFS = the world is actively changing on this topic.

2. **Trending Topic Overlay:** We tap into Google Trends real-time pipeline. If a query touches a trending entity, we boost the triggering probability. Example: "earthquake" on a normal day vs. the day a 7.2 hits Turkey — totally different triggering behavior.

3. **Search Result Staleness Detector:** Before Gemini commits to a no-search answer, we do a lightweight check: "Would the top-1 Search result for this query be materially different from what was in training data?" If yes, trigger search.

### Results

- **Freshness accuracy** improved from 72% to 91% on our eval set (queries where the correct answer changed in the last 24h)
- **Search trigger rate** actually went DOWN 8% overall — we're triggering less but smarter
- **Latency impact:** +12ms p50 for the signal fetch, but net-neutral because we eliminated ~15% of unnecessary search roundtrips
- **User satisfaction (CSAT):** +3.2 points on time-sensitive queries in our live experiment (statistically significant, p < 0.01)

### Key Insight

The counterintuitive finding: giving the model MORE information about the world actually reduced total search calls. The model was over-triggering on ambiguous queries because it had no way to assess "do I actually need fresh data here?" Now it can.

---

## Topic 2: Latency & Cost Optimizations

### Optimization 1: Skipping the Search Generation Model for Short Queries

**Before:** Every query that triggered search went through a two-step process:
1. Search Generation Model (SGM) reformulates the user query into an optimized search query
2. That reformulated query goes to Search

**The insight:** For short queries (< 8 tokens), the SGM almost always returns the original query verbatim. We analyzed 30 days of logs:
- Queries < 8 tokens: SGM output matched input 94.2% of the time
- When it didn't match, the reformulation was marginal (adding "2026" to a date query, etc.)

**What we did:** For queries under 8 tokens, we skip the SGM entirely and pass the user's query directly to Search.

**Impact:**
- Saved ~180ms p50 latency on 41% of search-triggered queries
- Reduced SGM serving costs by 38%
- Quality regression: -0.1% on short query search relevance (within noise, not statistically significant)

### Optimization 2: Small Models for First-Step Thinking

**Before:** Gemini's "thinking" phase (chain-of-thought reasoning before responding) used the full model for every step, even the initial planning step.

**The insight:** The first thinking step is almost always a structural decision: "This is a coding question, I need to write code" or "This needs search + synthesis." It doesn't require the full model's capacity.

**What we did:** We route the first thinking step to Gemini Flash (our smallest model), which produces a structured plan. Only the execution steps use the full model.

**Impact:**
- Reduced first-token latency by ~320ms on multi-step reasoning queries
- Cost reduction: ~22% fewer full-model tokens per reasoning query
- Quality: No measurable regression on our reasoning benchmarks. The plan produced by Flash is simple enough that it matches the full model's plan 97.8% of the time.

### Optimization 3: Reducing Search Results Fed to the Model

**Before:** We sent the top 10 search results (title + snippet + extracted content) to the model for grounding. That's a LOT of tokens.

**The insight:** Results 7-10 almost never contributed to the final answer. We did an ablation study:
- Top 5 results: 98.4% answer quality retained
- Top 3 results: 96.1% answer quality retained
- Top 10 (baseline): 100%

**What we did:** Default to top 5 results. For complex queries (detected by the thinking step), expand to 7. Never send more than 7.

**Impact:**
- Reduced grounding context by ~45% average
- Saved ~150ms on response generation (fewer tokens to process)
- Cost savings: substantial — grounding tokens were our single largest serving cost
- Quality: -1.6% on deep research queries, but +0.8% on simple factual queries (less noise = less confusion)

### Combined Impact of All Three Optimizations

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| P50 Latency (search queries) | 2.8s | 2.1s | -25% |
| P90 Latency (search queries) | 5.2s | 3.8s | -27% |
| Serving cost per search query | $X | $0.61X | -39% |
| Answer quality (overall) | baseline | -0.3% | negligible |

---

## Topic 3: World Cup 2026 — Generative UI Effort

### Context

FIFA World Cup 2026 kicks off June 11 in US/Canada/Mexico. This is the first World Cup where Gemini will be a primary interface for hundreds of millions of users. Search historically sees 5-10x traffic spikes during World Cup matches.

### What Are SIs (Search Integrations)?

For this effort, SIs are special-purpose integrations that detect World Cup-related queries and dynamically change how Gemini renders its response. Instead of plain text, we generate rich, interactive UI components.

### The Generative UI Approach

Traditional approach: Engineers manually design every possible sports card layout.
Our approach: The model GENERATES the UI specification as part of its response.

How it works:
1. User asks a World Cup question
2. Gemini recognizes it's a sports/World Cup query (via SI classification)
3. The model generates a structured response that includes UI directives — not just text, but layout instructions
4. A rendering engine on the client interprets these directives into rich components

### What We're Building

**Live Match Experience:**
- Real-time score cards with team crests, live minute marker
- Key event timeline (goals, cards, substitutions) that updates live
- Possession/shot stats that animate as the match progresses
- Model-generated tactical commentary ("France is pressing high on the left flank, creating 2v1 overloads")

**Pre-Match & Post-Match:**
- AI-generated match previews with head-to-head stats, form analysis
- Predicted lineups with explanation of tactical choices
- Post-match generated highlights summary with key moments linked to video timestamps

**Tournament Overview:**
- Interactive bracket that the model updates and annotates
- Group standings with qualification scenarios explained in natural language
- Player stats dashboards generated on-demand

**Personalization:**
- If we know the user's favorite team (from Search history signals), the UI adapts: their team's matches are highlighted, news is prioritized
- Language-aware rendering: Arabic users get RTL layouts, score cards show local time zones

### Timeline

| Milestone | Date | Status |
|-----------|------|--------|
| SI classification model trained | April 15 | In progress |
| Generative UI renderer v1 | April 30 | In progress |
| Live score card integration | May 15 | Not started |
| Internal dogfood | May 20 | Not started |
| Gradual external rollout | June 1 | Not started |
| World Cup kickoff | June 11 | — |

### Risks & Asks

- **Latency risk:** Generative UI adds a rendering step. We need the UI renderer to be < 50ms. Currently at 80ms — optimization in progress.
- **Accuracy risk:** Live scores MUST be correct. We're double-sourcing from Sports Data API + Search livescores. Any discrepancy falls back to text-only.
- **Scale risk:** We expect 10x normal Gemini traffic during marquee matches (US vs Mexico, Brazil vs Argentina). Need Rob's support for a pre-provisioning request to SRE.
- **Ask:** We need 2 additional FTEs from the rendering team for the May sprint. Can Rob help prioritize?

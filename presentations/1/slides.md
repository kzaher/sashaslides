# Gemini Search: Q2 Update for Rob
> whiteboard=1
> Search Triggering & Optimization Team | April 2026

---

## Agenda
> whiteboard=1
- Real-Time Search Signals → Smarter Triggering
- Three Latency & Cost Optimizations
- World Cup 2026: Generative UI

---

# PART 1
# Real-Time Signals for Search Triggering
> whiteboard=1

---

## The Problem: Stale Triggering
> whiteboard=1
- Triggering model had NO awareness of world state
- Under-triggering during breaking news — Gemini answers confidently with stale data
- Over-triggering on stable facts — wasting search roundtrips on "Who wrote Hamlet?"
> We were flying blind. The model couldn't tell if the world changed since training.

---

## What We Built: Three Real-Time Signals
> whiteboard=1

**Query Freshness Score (QFS)**
How much have top results changed in the last N hours?

**Trending Topic Overlay**
Google Trends real-time pipeline → boost triggering for trending entities

**Staleness Detector**
Lightweight check: "Would top-1 result differ from training data?"

> These signals flow directly from Search infra into Gemini's triggering decision.

---

## Results: Less Triggering, Better Answers
> whiteboard=1

| Metric | Before | After |
|--------|--------|-------|
| Freshness accuracy | 72% | **91%** |
| Search trigger rate | baseline | **-8%** |
| Latency (p50) | baseline | **+12ms** (net-neutral) |
| CSAT (time-sensitive) | baseline | **+3.2 pts** (p<0.01) |

**Key insight:** More information about the world → FEWER search calls.
The model was over-triggering because it couldn't assess "do I need fresh data?"

---

# PART 2
# Latency & Cost Optimizations
> whiteboard=1

---

## Optimization 1: Skip SGM for Short Queries
> whiteboard=1

**Before:** Every search query → Search Generation Model → reformulated query → Search

**Discovery:** For queries < 8 tokens, SGM returns the original query 94.2% of the time

**Fix:** Skip SGM entirely for short queries, pass directly to Search

| Impact | Value |
|--------|-------|
| Latency saved | **-180ms p50** on 41% of queries |
| SGM cost reduction | **-38%** |
| Quality regression | **-0.1%** (not significant) |

---

## Optimization 2: Small Models for First-Step Thinking
> whiteboard=1

**Before:** Full Gemini model for every thinking step, including initial planning

**Discovery:** First step is always structural: "This needs code" or "This needs search"

**Fix:** Route first thinking step to Gemini Flash → only execution uses full model

| Impact | Value |
|--------|-------|
| First-token latency | **-320ms** on reasoning queries |
| Full-model tokens | **-22%** per reasoning query |
| Plan match rate | **97.8%** (Flash vs Full) |

---

## Optimization 3: Fewer Search Results to Model
> whiteboard=1

**Before:** Top 10 results sent to model for grounding (massive token count)

**Discovery:** Results 7-10 almost never contribute to final answer

**Fix:** Default to top 5, expand to 7 for complex queries. Never more than 7.

| Impact | Value |
|--------|-------|
| Grounding context | **-45%** average |
| Response generation | **-150ms** |
| Quality (simple queries) | **+0.8%** (less noise) |
| Quality (deep research) | **-1.6%** (acceptable) |

---

## Combined Optimization Impact
> whiteboard=1

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| P50 Latency | 2.8s | **2.1s** | **-25%** |
| P90 Latency | 5.2s | **3.8s** | **-27%** |
| Serving cost/query | $X | **$0.61X** | **-39%** |
| Answer quality | baseline | -0.3% | negligible |

**Bottom line:** 25% faster, 39% cheaper, same quality.

---

# PART 3
# World Cup 2026: Generative UI
> whiteboard=1

---

## The Opportunity
> whiteboard=1

- FIFA World Cup kicks off **June 11** — US/Canada/Mexico
- First World Cup where Gemini is a primary user interface
- Search sees **5-10x traffic spikes** during matches
- Hundreds of millions of users will ask Gemini about the World Cup

---

## Generative UI: How It Works
> whiteboard=1

**Old way:** Engineers manually design every sports card layout

**Our way:** The model GENERATES the UI specification

1. User asks a World Cup question
2. SI classification detects sports/World Cup intent
3. Model generates response WITH UI directives (layout instructions)
4. Client rendering engine interprets directives into rich components

> The model becomes the designer. Infinite layouts, zero manual design.

---

## What We're Building
> whiteboard=1

**Live Match**
- Real-time score cards with crests & live minute
- Event timeline (goals, cards, subs) — updates live
- Animated possession/shot stats
- AI tactical commentary

**Pre/Post Match**
- AI match previews with head-to-head stats
- Predicted lineups with tactical explanations
- Highlights summary linked to video timestamps

**Tournament**
- Interactive bracket with AI annotations
- Group standings with qualification scenarios in natural language
- On-demand player stats dashboards

---

## Personalization & Localization
> whiteboard=1

**Team Personalization**
- Detect user's favorite team from Search history
- Highlight their matches, prioritize their news

**Language-Aware Rendering**
- RTL layouts for Arabic users
- Local time zones on score cards
- Localized player/team names

---

## Timeline: 61 Days to Kickoff
> whiteboard=1

| Milestone | Date | Status |
|-----------|------|--------|
| SI classification model | Apr 15 | In progress |
| Generative UI renderer v1 | Apr 30 | In progress |
| Live score card integration | May 15 | Not started |
| Internal dogfood | May 20 | Not started |
| Gradual external rollout | Jun 1 | Not started |
| **World Cup kickoff** | **Jun 11** | — |

---

## Risks & Asks for Rob
> whiteboard=1

**Risks**
- Latency: UI renderer at 80ms, need < 50ms — optimizing now
- Accuracy: Live scores double-sourced (Sports Data API + Search). Mismatch → text fallback
- Scale: 10x traffic during marquee matches (US v Mexico, Brazil v Argentina)

**Asks**
1. Support our pre-provisioning request to SRE for World Cup traffic
2. 2 additional FTEs from the rendering team for the May sprint

---

## Thank You
> whiteboard=1
> Questions?

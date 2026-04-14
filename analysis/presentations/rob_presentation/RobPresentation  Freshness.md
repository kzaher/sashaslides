Original Link: https://docs.google.com/document/d/1n_x3gAsZAQ5_oUzEuSEHKTc15XQqKF93tV-3nm5MUsI/edit

Request for presentation from Sasha


1. We should present Johan's work. Recap search triggering slide. Explain the solution and challenges. How we collabed with search. Show wins and explain impact. Next steps, ETA and hero wins for hivemind

2. Optimization launches. High-level schemas of what was done and impact

3. World cup deep dive. To work together with Dmitry. What we are LEing, how we collab with search, challenges and plans


# Content

- Realtime signals for search triggering
- Optimization launches
- World cup 2026

# Real-time signals for search triggering


Illustration with ratios of search traffic covered with fraction [covered by realtime search](https://screenshot.googleplex.com/45Kf8NwVCEHe3xc) signals in the upper part of slide. Table from the picture:


| **Forced search by KITE** |
| --- |
| 2.5-3.5% |
| **Suppressed by KITE** |
| 4-5% |
| **Forced by real time signals** |
| 0.007% |
| **Doesn’t call search natively** |
| 74-79% |
| **Calls search natively** |
| 14-18% |


“Address freshness losses in the Gemini App by reusing search signals to create a trends and news aware search triggering”


Example of losses:

- “What is 67”
- “who shot down the F-15 eject” (Iran conflict)
## Real-time signals for search triggering overview

| **Signal Source** | **Availability** | **Time Window** | **Affected Traffic** | **Effectiveness & Limitations** |
| --- | --- | --- | --- | --- |
| RealtimeBoostServlet | Currently available | 2–3 Days | ~30% | - breaking news spikes - longer natural language queries. |
| Hivemind | Currently available | hours to year |  |  |
| KomodoNavboost | Currently available | days | ~30% | Keyword based |
| World Context | Requires new RPC | periodic | event entities | - elections or sports tournaments. |
| Trends Signals | Requires new RPC, may not have capacity to serve us | 1 year | ~all fact-seeking traffic | - High coverage - QPS limits |
| QueryResultBlockingService.Resolve | Requires new RPC | all | ~80% | ? |

## Real-time signals for search: Short term plan - RTB

Picture of search on one left side as source of signals, signals in the middle (following table) and GeminiApp logo on the right side (but with no connection to signals except RTB connected with GeminiApp), this is the list of signals:


| **Signal Source** |
| --- |
| RealtimeBoostServlet |
| Hivemind |
| KomodoNavboost |
| World Context |
| Trends Signals |
| QueryResultBlockingService.Resolve |

*Above is the base part slide which will be reused in further slides.*


ETA 1 week (shown in bottom right corner of upper image)


- LE finished. ✅
- Cost analysis done 
    - Relative search triggering increase in agency 0.04% overall. ✅
    - No statistically significant impact on TPU, as [per demand graph](https://demand.corp.google.com/experiment/106138187?version_id=experiment_analysis_beam2026011&selected_tab=3). ✅
- **Current status:** asking launch approval [go/geminiapp-rfc-3133](http://go/geminiapp-rfc-3133)
## Real-time signals for search: Short term plan - RTB W/L analysis

Upper part is the same as in the slide before.


Bottom part:


Samples from logs

- Wins (base misses the relevant recent events)
    - “who is Gucci that is being kidnapped”
    - “who shot down the F-15 eject”
    - “Pooh shiesty arrest”
- Losses
    - No quality losses, only overtriggering (<0.03864% relative search triggering increase)
## Real-time signals for search: Longer Term Plan Unified Freshness Signal

Upper part is the same as in the slide before, but ETA 3.5  weeks (shown in bottom right corner of upper image)

## Collaboration with @robruenes, @vchtchetkine

- UnifiedSignal endpoint is ready. ✅ 
- Calling RPC in Agency is code complete (dark launch). ✅
    - Running LE: ETA today (this will be stale)
- Logging unified signal LE: ETA 1 week
- Working E2E and triggering search LE: 2.5 weeks
- Launch: ETA  3.5 weeks
- RFC: WIP
## Real-time signals for search: Optional - Using Short Term HiveMind Signals

Upper part is the same as in the slide before with ETA has “?” (because it’s not known should we do this).


- Exploring using long term HiveMind signals not covered by unified signal.
    - Collaboration with @robruenes, @vchtchetkine
- Needs to be reevaluated after unified signal experimentation.
## Real-time signals for search: Challenges

- **Evaluation Blocker**
    - inability to build a static ground-truth 
    - reliance on building a high-quality autorater
- **Search signal degradation**
    - Quality depends on length
    - Targeting 80% of prompts
- **Legal**
    - DMA 5(2)
    - Using signals directly from Search.
    - Blocking logs evaluation
- **Small Targeted Slice**
    - < 0.1% of traffic
    - Creates data mining and eval difficulty
    - Disproportional reputational damage
# Optimizations

There were 3 major projects:

- Reducing Max Search Results from 20 to 10
- Fast Path for freshness seeking prompts
- Fast Model for First Turn on Pro (Freshness slice)
## Optimizations: Max Search Results from 20 to 10

Some image

- Google search -> search results (trimmed from 20 to 10) -> then fork arrows:
    - Original model context image with larger part marked (and entire context rectangle larger)
    - Smaller part of llm model context with smaller part marked (and entire context rectangle smaller)
- Collaboration of  with  and @egoregor
- Impact:
    - Reduces TPU usage 5.9K GXUs
- Current Status: Launched [go/geminiapp-rfc-3062](http://go/geminiapp-rfc-3062).
## Optimizations: Fast Path for freshness seeking prompts (Freshness slice)

These are 2 slides. The first one contains the top half of the image below with the current state. On the second slide the entire image presents (in the same location to give the illusion of animation) with the content below.

First search query is set to be identical to the user prompt for the targeted slice

[screenshot](https://screenshot.googleplex.com/7srD8L5Bx54WvQv)

Impact:

- Saves 2.5 GXUs
- Latency on impacted slice
    - Fast: -34% p50 (1.1s), -13% average latency
    - Thinking: -7.3% p50 (0.9s), -7% average latency 
    - Pro: -12.91% p50 (-2.7s), -8.62% average latency
Status: Approved (pending rampup) [go/geminiapp-rfc-3115](http://go/geminiapp-rfc-3115)

## Optimizations: Fast Model for First Turn on Pro (Freshness slice)


These are 2 slides. The first one contains the top half of the image below with the current state. On the second slide the entire image presents (in the same location to give the illusion of animation) with the content below.


Replace first model call with a fast model to generate Google search tool query for the first step on the pro model on the target slice.


[screenshot](https://screenshot.googleplex.com/7tDXMyXuK55TxqE)


Impact

- Pro (on target freshness slice):
    - Quality neutral in LE (thumbs up/down, DAU)
    - -12% p50 (-2.7s), -10.87% average latency (-2.8s)
    - -15% TPU, -617 GXUs
        - 617 GXU saved
- Current status: Approved (code complete) [go/geminiapp-rfc-3116](http://go/geminiapp-rfc-3116), [go/geminiapp-rfc-3095](http://goto.google.com/geminiapp-rfc-3095), [go/geminiapp-rfc-3132](http://go/geminiapp-rfc-3132)

# World Cup + Soccer Experience Overview

We can use [this picture](https://docs.google.com/presentation/d/1kmuKKoNJQU2f-fgzuHSdwwno3jTSbyG3Tx99uVSmTaQ/edit?slide=id.g3d3bb341e59_31_414#slide=id.g3d3bb341e59_31_414) for the right side of the overview slide.


Enhance the Gemini World Cup and soccer experience:

- Card improvements ✅
- 1P KG data for grounding ✅
- Generative UI Elements **ETA Next week**
- Supporting video elements **ETA Next week**
- General quality looses **ETA 3 weeks**

Bento + Response + Video (stacked vertically as response sections on the left side of the slide)

## Cards improvements

[Pictures](https://screenshot.googleplex.com/9qFHYWgiTJZg8NG) with the right side showing response below the card with further clarification of what the card presents.

[go/geminiapp-rfc-3193](http://go/geminiapp-rfc-3193) 


## World Cup: Collaborations

- New Mini Vertical Workstream
- Collaboration with @robruenes, @vchtchetkine
    - PM @angsun
    - UI @haibinqi
    - 1P KG data @ninamerlin, @wmensah
    - UX @ckellner
    - AIM PM @angsun
    - Search Classifiers (for triggering) @benchesnut, @runningen
    - Partnerships/Licensing Video from FIFA @mbrischke, @mrnagrath
## World Cup: Risks

- **GenUI/Visual Components:** Prompt negatively interacting with quality metrics.
    - Remedy: Prompt optimization
- **Latency impact:**
    - Remedy: Implicit image and video retrieval.
- **Agency Launch Uncertainty:** Only focusing on agency stack.
    - Remedy: Back porting to old stack ~week
## World Cup: LE Plan

- Targeted LE Date 2026-05-08
- Based on Olympics experience two LEs are planned:
    - 1P Data grounding only LE
    - 1P Data + Generative UI + Video
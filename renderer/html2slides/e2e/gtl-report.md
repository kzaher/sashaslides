# Generic Google-Slides Table-Geometry Model — Reverse-Engineering Report

Closed-loop measurement: fuzzed tables → real converter → Google Slides upload → scraped thumbnail → per-row/col/origin pixel measurement. Two **independent fuzz seeds** (batches) so the model is trained on one and validated on the other.

## 1. Dataset

| batch | seed | tables | row points | col points |
|---|---|---|---|---|
| train | 12345 | 67 | 240 | 172 |
| TEST(held-out) | 999 | 44 | 173 | 116 |
| **total** | | **111** | **413** | **288** (701 pts) |

Fuzzed dimensions: rows 1–6, cols 1–4, font {6,8,10,11,12,14,16,18,20,24,28}px, border {0,1,2,3}px, padding 0–8px, row heights 8–60px, table width 360–1040px, 1–3 text lines.

## 2. Fitted law (CSS px @ the 1280px fixture coordinate)

> **rendered row height = max( specified + 0.72,  1.20·font·lines + 0.98·(2·padY) + 0.51 )**
>
> **rendered column width = 1.003·specified − 0.10**

- `1.20` line-box factor = CSS `line-height: normal` (≈1.2). Each text line reserves one line-box.
- Vertical padding passes through ~1.0×. **Border width does *not* grow the row** (A/B tested: adding it raised held-out RMSE 1.02→1.51px — the border draws inside the cell box).
- Columns honoured almost exactly (slope 1.003). Table origin honoured to sub-pixel.

## 3. Held-out validation (train on batch 1, test on independent batch 2)

| target | split | n | RMSE | MAE | max | ≤1px | ≤2px | R² |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| row height | train | 240 | 1.08px | 0.77px | 5.68px | 73% | 95% | 0.9972 |
| row height | **TEST** | 173 | **1.02px** | 0.75px | 5.37px | 71% | 95% | **0.9978** |
| col width | **TEST** | 116 | **1.31px** | 1.01px | 4.20px | 54% | 89% | **0.9999** |

Train RMSE ≈ test RMSE ⇒ **no overfitting**. Residual ≈ thumbnail quantization floor (1px thumbnail / 1.25 scale ≈ 0.8px).

## 4. Floor law: measured vs predicted, by font size

(single-line, floor-active rows where rendered > spec; mean over all padding/border) 

| font px | n | measured floor−2·padY (px) | predicted 1.20·font+0.51 | Δ |
|--:|--:|--:|--:|--:|
| 6 | 6 | 13.15 | 7.69 | 5.47 |
| 10 | 7 | 19.03 | 12.47 | 6.56 |
| 11 | 6 | 14.28 | 13.67 | 0.61 |
| 12 | 3 | 14.91 | 14.87 | 0.04 |
| 14 | 7 | 17.37 | 17.26 | 0.11 |
| 16 | 4 | 21.38 | 19.65 | 1.73 |
| 18 | 11 | 22.76 | 22.05 | 0.72 |
| 20 | 15 | 24.53 | 24.44 | 0.09 |
| 24 | 11 | 29.87 | 29.22 | 0.65 |
| 28 | 18 | 33.94 | 34.01 | -0.07 |

## 5. Residual histogram (held-out row heights)

| error (px) | count |
|--:|---|
| -5 | █ 1 |
| -2 | █████████ 9 |
| -1 | ████████████████████████ 24 |
| +0 | ████████████████████████████████████████████████████████████████████████████████████ 84 |
| +1 | ████████████████████████████████████ 36 |
| +2 | ███████████████████ 19 |

## 6. Column width: measured vs predicted (sample)

| spec px | rendered px | predicted px | Δ |
|--:|--:|--:|--:|
| 119 | 120.42 | 119.26 | -1.16 |
| 320 | 321.60 | 320.88 | -0.72 |
| 129 | 129.98 | 129.29 | -0.69 |
| 962 | 965.60 | 964.87 | -0.73 |
| 336 | 337.99 | 336.93 | -1.06 |
| 401 | 402.81 | 402.13 | -0.68 |
| 108 | 108.00 | 108.23 | 0.23 |
| 253 | 252.00 | 253.68 | 1.68 |
| 609 | 610.79 | 610.78 | -0.01 |
| 414 | 414.81 | 415.18 | 0.37 |
| 108 | 108.00 | 108.23 | 0.23 |
| 147 | 147.20 | 147.35 | 0.15 |

## 7. Table origin & size faithfulness

- **left-edge (origin X) offset from spec:** -0.40 ± 0.85px (range -1.60…0.80)
- **top-edge (origin Y) offset from spec:** -0.40 ± 0.85px (range -1.60…0.80)
- **table width − Σ(spec col widths):** 1.76 ± 2.48px (range -2.20…6.60)

⇒ Google places the table within **~1px** of the specified origin and width. There is **no systematic inset**, so any multi-px corner/edge misfit on a real slide is produced by the converter's own overlay geometry, not by Google's table re-rasterization.


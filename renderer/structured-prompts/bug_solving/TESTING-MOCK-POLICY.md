# bug_solving test mock policy

**Tests may mock ONLY three things — and NOTHING else:**

| | What | How to mock it | Notes |
|---|---|---|---|
| **(H)** | **Human rating** (you clicking Good/Bad) | `greenCluster(...)`, `writeRatingOutcome(...)`, or rating-outcome marker files | The single human ask; provided as the merge's *input*. |
| **(L)** | **The LLM call** | `mockLlm(reply, {tag})` → a **real** `IO` that intercepts only `claude`/`codex` spawns | Everything else (bash, git, fs, clock, log) runs for real via `realIO`. |
| **(R)** | **The Google-Slides recording** (`record-rendering --mode full`) | `recordingFromContent(...)` / `recordingSeam(...)` → a `MergeRenderSeam` injected via `realLlmMergeOps({ render })` | Only the render *output* is synthesized; it's driven by the REAL overlay content. |

Everything else runs **for real**: COW overlays, the filesystem, git, the clock,
shells, the **regression gate**, promote, and the demote **ledger** (pointed at a
temp dir — a config, not a mock). Each mock takes an optional `tag` to identify
*where* the mocked call comes from.

The kit lives in [`test-support.ts`](./test-support.ts). There is no other mock
surface — no `MockIO` matcher walls for `now`/`log`/`bash`/`git`/`writeFileSync`,
and no scripted `ops.retest`.

## Per-test audit (merge/gate surface)

| Test file | (H) human | (L) LLM | (R) recording | Real (not mocked) |
|---|:---:|:---:|:---:|---|
| `merge-e2e.test.ts` | ✅ green clusters / marker | ✅ `mockLlm` | ✅ `recordingFromContent` | gate, overlays, promote, **real ledger**, all-at-once→sequential, git/fs/clock/shells |
| `overlay-lifecycle.e2e.test.ts` (C1, R1) | ✅ markers | ✅ `mockLlm` | ✅ `recordingFromContent` | gate, overlays, promote, **real ledger (temp)**, `resumeMerge`, reaping |
| `regression-gate.test.ts` | n/a | n/a | ✅ plain `RenderRecord` data into the pure gate | pure gate/adapter logic |
| `stability.test.ts` | n/a | n/a | ✅ injected `record` fn (the recording seam) | `classifyStability` logic |
| `rating-*.test.ts`, `wait-for-ratings`, `accept-orchestration` | ✅ rating files / injected verdict | n/a | n/a | gate/marker/ledger logic |

## What changed to get here
- **Deleted** `llm-merge.e2e.test.ts` — it scripted the entire `ops.retest` (a
  forbidden mock of the gate). Its real-gate coverage now lives in `merge-e2e`.
- **`regression-gate.test.ts`** — dropped the wire-through half (it used a
  `MockIO` matcher wall for `now`/`bash`/`git`/`fs` + captured demote); kept the
  pure gate unit tests. The full merge-through-the-gate lives in `merge-e2e`.
- **`overlay-lifecycle.e2e.test.ts`** — C1/R1 converted from scripted `ops.retest`
  + `MockIO` to the real gate via the kit (real ledger → temp dir).
- **`realLlmMergeOps`** gained an optional `render` seam (unset in production =
  real recording) so the recording is the *only* injectable-for-tests point.

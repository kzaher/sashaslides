/**
 * Eval item + result types.
 *
 * The 100-item set is split 50/50:
 *   - visual: VLM looks at a slide screenshot and answers a question
 *   - action: VLM produces code / JSON / a plan
 *
 * Each item has a declarative `expected` that the scorer interprets. We avoid
 * LLM-as-judge wherever possible (deterministic scoring = reproducible ranks)
 * but use a rubric judge for subjective tasks (aesthetic scoring, rewrites).
 */

export type EvalCategory = "visual" | "action";

export type EvalSubcategory =
  // visual
  | "ocr"
  | "layout_classify"
  | "chart_read"
  | "style_detect"
  | "element_count"
  | "diff_detect"
  | "aesthetic_score"
  // action
  | "generate_html"
  | "pick_layout"
  | "write_pptxgenjs"
  | "fix_bug"
  | "edit_op"
  | "agent_plan"
  | "rewrite_content";

export type Difficulty = "easy" | "medium" | "hard";

/** What the item shows the model as input. */
export type EvalInput = Readonly<{
  /** The user message. */
  prompt: string;
  /**
   * Inline HTML that the harness will render to a PNG before the call.
   * The rendered image is fed to the model as the prompt's image attachment.
   */
  slideHtml?: string;
  /** Second slide for diff-detect tasks. */
  slideHtmlB?: string;
  /** Raw code snippet for bug-fix tasks. */
  code?: string;
  /** Arbitrary context appended to the prompt. */
  context?: Readonly<Record<string, unknown>>;
}>;

/**
 * Declarative expectations. The scorer picks the strictest available mode.
 * All optional — an item may combine several (e.g., containsAll + codeRuns).
 */
export type EvalExpected = Readonly<{
  /** Case-insensitive substring match against the model's text output. */
  containsAll?: readonly string[];
  /** At least one of these substrings must appear. */
  containsAny?: readonly string[];
  /** Substring that must NOT appear (catches hallucinations). */
  containsNone?: readonly string[];
  /** Output must parse as JSON. */
  isJson?: boolean;
  /** After JSON-parsing, this key path must resolve to one of these values. */
  jsonPathEquals?: Readonly<{ path: string; values: readonly (string | number | boolean)[] }>;
  /** Output must be runnable TypeScript / JavaScript (wrapped in async fn). */
  codeRuns?: boolean;
  /** For numeric answers (aesthetic score, chart values): tolerance range. */
  numericRange?: readonly [number, number];
  /** Rubric fed to the LLM judge when no deterministic mode is enough. */
  rubric?: string;
  /** Exact match after trimming. */
  exact?: string;
}>;

export type EvalItem = Readonly<{
  id: string;
  category: EvalCategory;
  subcategory: EvalSubcategory;
  difficulty: Difficulty;
  /** One-line description shown in eval output. */
  description: string;
  input: EvalInput;
  expected: EvalExpected;
  /** Max tokens in the model's response. */
  maxTokens?: number;
  /** Per-item timeout. */
  timeoutMs?: number;
}>;

export type ItemResult = Readonly<{
  itemId: string;
  /** 0 or 1 under deterministic scoring, 0..1 under rubric scoring. */
  score: number;
  /** Human-readable reason — populated on failures. */
  reason: string;
  /** Full text of the model's response. */
  response: string;
  /** Latency for this single item, in ms. */
  latencyMs: number;
  /** Prompt + completion tokens. */
  usage: Readonly<{ promptTokens: number; completionTokens: number }>;
  /** Cache stats. */
  prefixHitTokens: number;
  imageCacheHit: boolean;
}>;

export type ModelReport = Readonly<{
  modelId: string;
  modelDisplayName: string;
  startedAt: string; // ISO
  finishedAt: string;
  results: readonly ItemResult[];
  /** Aggregate scores. */
  summary: Readonly<{
    total: number;
    passed: number;
    failed: number;
    scoreMean: number;
    byCategory: Readonly<Record<EvalCategory, { total: number; scoreMean: number }>>;
    bySubcategory: Readonly<Record<string, { total: number; scoreMean: number }>>;
    totalLatencyMs: number;
    totalTokens: number;
    avgPrefixHitRate: number;
  }>;
}>;

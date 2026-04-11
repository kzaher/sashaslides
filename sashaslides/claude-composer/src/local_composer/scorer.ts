/**
 * Scorer — applies an EvalItem's declarative `expected` to a model response.
 *
 * Deterministic modes are preferred (exact / contains / JSON / numericRange)
 * so eval runs are reproducible. Code-runs uses a sandboxed function
 * construction to verify syntactic validity; it does not actually execute
 * pptxgenjs — it only checks the snippet parses as JS.
 */

import type { EvalExpected, EvalItem, ItemResult } from "./eval-types.js";

export type ScoreOutcome = Readonly<{ score: number; reason: string }>;

export function scoreResponse(item: EvalItem, response: string): ScoreOutcome {
  const exp = item.expected;
  const text = response.trim();
  const textLc = text.toLowerCase();

  // Aggregate multiple checks — start at 1.0 and fail closed.
  let score = 1;
  const reasons: string[] = [];

  if (exp.exact !== undefined) {
    if (text !== exp.exact) {
      score = 0;
      reasons.push(`expected exact="${exp.exact}", got "${text.slice(0, 64)}"`);
    }
  }

  if (exp.containsAll) {
    for (const s of exp.containsAll) {
      if (!textLc.includes(s.toLowerCase())) {
        score = 0;
        reasons.push(`missing required substring "${s}"`);
      }
    }
  }

  if (exp.containsAny) {
    const anyHit = exp.containsAny.some((s) => textLc.includes(s.toLowerCase()));
    if (!anyHit) {
      score = 0;
      reasons.push(`none of ${exp.containsAny.length} alternatives present`);
    }
  }

  if (exp.containsNone) {
    for (const s of exp.containsNone) {
      if (textLc.includes(s.toLowerCase())) {
        score = 0;
        reasons.push(`forbidden substring "${s}" present`);
      }
    }
  }

  if (exp.isJson) {
    try {
      JSON.parse(stripFences(text));
    } catch {
      score = 0;
      reasons.push("output is not valid JSON");
    }
  }

  if (exp.jsonPathEquals) {
    try {
      const parsed = JSON.parse(stripFences(text));
      const v = getPath(parsed, exp.jsonPathEquals.path);
      if (!exp.jsonPathEquals.values.some((target) => target === v)) {
        score = 0;
        reasons.push(`JSON path "${exp.jsonPathEquals.path}" = ${JSON.stringify(v)} not in expected values`);
      }
    } catch {
      score = 0;
      reasons.push("could not parse JSON for path check");
    }
  }

  if (exp.codeRuns) {
    if (!isSyntacticallyValidJs(stripFences(text))) {
      score = 0;
      reasons.push("code snippet does not parse as JavaScript");
    }
  }

  if (exp.numericRange) {
    const n = extractNumber(text);
    const [lo, hi] = exp.numericRange;
    if (n === null) {
      score = 0;
      reasons.push("no number extracted from output");
    } else if (n < lo || n > hi) {
      score = 0;
      reasons.push(`number ${n} outside [${lo}, ${hi}]`);
    }
  }

  return {
    score,
    reason: score === 1 ? "ok" : reasons.join("; "),
  };
}

/** Strip ```lang\n ... \n``` fences if present. */
export function stripFences(s: string): string {
  const m = s.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s.trim();
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Extract the first integer or float from a string. */
export function extractNumber(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Check if a string parses as JavaScript. Uses `new Function`, which throws
 * on syntax errors but does not execute the body. This is a strict subset of
 * real "would it run with pptxgenjs" but catches the common bug classes we
 * care about (typos, missing braces, unterminated strings).
 */
export function isSyntacticallyValidJs(code: string): boolean {
  try {
    // Wrap in an async function so `await` at the top level is legal.
    // eslint-disable-next-line no-new-func
    new Function("pptx", "slide", `return (async () => { ${code} })()`);
    return true;
  } catch {
    return false;
  }
}

/** Build a full ItemResult from a response + adapter metadata. */
export function makeItemResult(
  item: EvalItem,
  response: string,
  meta: Readonly<{
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    prefixHitTokens: number;
    imageCacheHit: boolean;
  }>,
): ItemResult {
  const { score, reason } = scoreResponse(item, response);
  return {
    itemId: item.id,
    score,
    reason,
    response,
    latencyMs: meta.latencyMs,
    usage: { promptTokens: meta.promptTokens, completionTokens: meta.completionTokens },
    prefixHitTokens: meta.prefixHitTokens,
    imageCacheHit: meta.imageCacheHit,
  };
}

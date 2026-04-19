/**
 * Cross-cutting types used by multiple modules. Per-API option shapes live
 * next to their implementations:
 *   - CommonSendArguments, SendOptions, SendFormattedOptions → session.ts
 *   - InterruptException, StructuredError                    → errors.ts
 */

/** `T` on success, `{error: string}` on failure. Produced by materializeError. */
export type Result<T> = T | { error: string };

/** Claude CLI model aliases passed to `claude --model`. */
export type ClaudeModel = "haiku" | "sonnet" | "opus";

/**
 * Sugar namespace so user code can write `Claude.haiku` / `Claude.switchOpus`
 * matching the README spec.
 */
export const Claude = {
  haiku: "haiku" as ClaudeModel,
  sonnet: "sonnet" as ClaudeModel,
  opus: "opus" as ClaudeModel,
  switchHaiku: "haiku" as ClaudeModel,
  switchSonnet: "sonnet" as ClaudeModel,
  switchOpus: "opus" as ClaudeModel,
} as const;

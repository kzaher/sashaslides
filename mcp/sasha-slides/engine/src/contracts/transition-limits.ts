// THE SCRIPTED TRANSITION LIMITS, apart from transition-protocol.ts because that file also declares
// the runner's browser types (`Window`, `Keyframe`, `Animation`): the connector's compiler (ES2022,
// no DOM library) must read the same numbers when `deck_write_transition` refuses a script the
// presenter would never load, and a restated copy could drift. transition-protocol.ts re-exports it.

/** The limits the host enforces; every one has a named fallback (`TransitionFallbackReason`). */
export const TRANSITION_LIMITS = {
  /** From frame creation to `runnerReady`. A warm spare runner is kept while the show has scripted transitions. */
  runnerReadyTimeoutMilliseconds: 3000,
  /**
   * From the decision to transition to `prepared`: INCLUDES the host gathering font and asset bytes
   * and rendering both slides' markup, then the runner decoding fonts and images and evaluating the
   * script.
   */
  prepareTimeoutMilliseconds: 2000,
  pingIntervalMilliseconds: 250,
  /** A ping unanswered this long, counted while the host page is visible: stalled. */
  stallTimeoutMilliseconds: 2000,
  /** A transition's declared duration is clamped to [0, this]. */
  maximumDurationMilliseconds: 8000,
  /** After the declared duration, how long the host waits for `finished`. */
  finishGraceMilliseconds: 1000,
  /** The fade the host substitutes (reduced motion, unapproved or missing script). */
  substituteFadeMilliseconds: 150,
  maximumScriptBytes: 256 * 1024,
  maximumStylesheetBytes: 64 * 1024,
  maximumOverlayMarkupBytes: 64 * 1024,
  /** Per slide; a larger slide falls back (`slideTooLarge`): the presenter cuts to it. */
  maximumSlideMarkupBytes: 2 * 1024 * 1024,
  /** All asset and font bytes of one run together. */
  maximumTransferredBytes: 32 * 1024 * 1024,
  maximumLogMessagesPerRun: 50,
  maximumLogMessageLength: 500,
} as const;

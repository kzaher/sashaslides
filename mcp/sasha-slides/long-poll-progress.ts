/**
 * Keeping a long poll alive in the client's eyes.
 *
 * `await_pick` and `await_feedback` are the two tools that deliberately block for minutes.
 * A Model Context Protocol client enforces its own per-request timeout, and the measured
 * default is 60 s: a real client (`e2e/sasha-listener.ts`, attached over stdio) killed a
 * 420 s `await_feedback` with `McpError -32001  data: { timeout: 60000 }` while the server
 * was still happily polling Drive. The only thing that resets that timer is a
 * `notifications/progress` carrying the request's own `progressToken`.
 *
 * So progress here is not telemetry. It is what makes the long poll usable at all, and it is
 * also the honest answer to "is anything happening?" - each notification reports the poll
 * count and the elapsed time, which is exactly what the sidebar's waiting notice shows.
 */

/** The `progressToken` the client minted for this request, if it asked for progress at all. */
export type ProgressRequestMeta = Readonly<{ progressToken?: string | number | undefined }>;

/**
 * The slice of the SDK's `RequestHandlerExtra` this needs.
 *
 * Narrow on purpose: taking the whole `RequestHandlerExtra` would drag its generics (and a
 * transport) into every test that wants to prove a notification was sent.
 */
export type ProgressSink = Readonly<{
  _meta?: ProgressRequestMeta | undefined;
  sendNotification: (
    notification: Readonly<{
      method: "notifications/progress";
      params: Readonly<{
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      }>;
    }>,
  ) => Promise<void>;
}>;

/** What one poll of a long-polling tool reports back. */
export type PollProgress = Readonly<{ polls: number; elapsedMs: number }>;

/**
 * An `onPoll` callback that notifies the client, or a no-op when it did not ask.
 *
 * A client that sends no `progressToken` has not opted in, and the protocol forbids guessing
 * one - so the wait still works, it just cannot outlive that client's own timeout.
 *
 * `progress` is the elapsed milliseconds against `total` = the wait's budget, which is both
 * monotonic (as the protocol requires) and a genuine fraction the client can render.
 */
export function pollProgressReporter(
  options: Readonly<{
    extra: ProgressSink;
    timeoutMs: number;
    /** What the user is being waited on, for the notification's human-readable message. */
    describe: (progress: PollProgress) => string;
    /** Where to report a notification that could not be delivered. */
    warn: (message: string) => void;
  }>,
): (progress: PollProgress) => void {
  const { extra, timeoutMs, describe, warn } = options;
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  return (progress) => {
    // Fire-and-forget: a poll must not be held up by the notification, and a client that
    // vanished mid-wait is not this tool's failure - the wait's own deadline still ends it.
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: Math.min(progress.elapsedMs, timeoutMs),
          total: timeoutMs,
          message: describe(progress),
        },
      })
      .catch((cause: unknown) => {
        warn(`progress notification failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
  };
}

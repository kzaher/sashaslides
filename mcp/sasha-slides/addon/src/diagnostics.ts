/**
 * What the sidebar can honestly say about its own session when something fails.
 *
 * This exists because a host-level failure ("a server error occurred while reading from
 * storage") tells the user nothing and tells a maintainer even less. Three separate theories
 * about one such failure were wrong, each costing a round trip, because the one fact that
 * would have settled it -- which Google account slot the add-on is running under -- was only
 * visible inside the user's own browser.
 *
 * Everything here is derived from strings the sandbox can already see. It reads no tokens,
 * no account names and no document content.
 */

export type SessionDiagnostics = Readonly<{
  /**
   * The `/u/<n>/` account slot, read from the sandbox's own host.
   *
   * HtmlService serves the panel from a host shaped
   * `n-<opaque>-<slot>lu-script.googleusercontent.com`, so slot 0 is the browser's default
   * Google account and anything higher means the add-on is running as a non-default account
   * in a multi-account browser -- the classic cause of Apps Script refusing to load a bound
   * script. Null means the host did not match, which is itself worth reporting rather than
   * guessing a zero.
   */
  accountSlot: number | null;
  /** Whether the page believes it is being looked at; Docs ignores input when it is not. */
  visible: boolean;
  /** Browser storage can be partitioned or blocked in a third-party frame. */
  storageUsable: boolean;
  at: string;
}>;

/** `n-xxxx-0lu-script.googleusercontent.com` -> 0. Null when the host is not that shape. */
export function accountSlotOf(href: string): number | null {
  const matched = /-(\d+)lu-script\.googleusercontent\.com/.exec(href);
  const digits = matched?.[1];
  if (digits === undefined) return null;
  const slot = Number.parseInt(digits, 10);
  return Number.isSafeInteger(slot) && slot >= 0 ? slot : null;
}

export function collectDiagnostics(
  options: Readonly<{
    href: string;
    visibilityState: string;
    readStorage: () => boolean;
    now: () => Date;
  }>,
): SessionDiagnostics {
  return {
    accountSlot: accountSlotOf(options.href),
    visible: options.visibilityState === "visible",
    storageUsable: options.readStorage(),
    at: options.now().toISOString(),
  };
}

/** One copyable line. Deliberately boring: it is going to be pasted into a chat window. */
export function describeDiagnostics(diagnostics: SessionDiagnostics): string {
  const slot =
    diagnostics.accountSlot === null
      ? "account slot unknown"
      : `account slot ${diagnostics.accountSlot}${diagnostics.accountSlot === 0 ? "" : " (NOT the browser default)"}`;
  return [
    slot,
    diagnostics.visible ? "visible" : "not visible",
    diagnostics.storageUsable ? "storage ok" : "storage blocked",
    diagnostics.at,
  ].join(" · ");
}

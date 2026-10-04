// CROSS-ORIGIN ACCESS, and an honest account of what it buys.
//
// THE PROBLEM. The add-on's panel is an Apps Script `HtmlService` page. Its origin is shaped
// `https://n-<opaque>-<slot>lu-script.googleusercontent.com` -- and note where the dots are: the
// whole of `n-<opaque>-<slot>lu-script` is ONE DNS label under `googleusercontent.com`. The opaque
// part is generated per session and per deployment, so an allowlist of exact origins is impossible,
// and `Access-Control-Allow-Origin: *` would mean every page on the internet.
//
// So the policy is a HOST PATTERN with a single-label wildcard: `*-script.googleusercontent.com`.
// The `-script` tail of the label is what distinguishes an Apps Script sandbox from the rest of
// `googleusercontent.com`, which also serves Drive thumbnails, profile photos and every other piece
// of Google-hosted user content (`lh3.googleusercontent.com` and friends). Matching the bare suffix
// would have let all of those in; matching the label tail does not.
//
// On top of the pattern the origin must parse, be exactly its own serialised origin (no path, no
// trailing slash, no port, no userinfo, no case tricks), and be `https:`. `Vary: Origin` goes on
// every response so a cache can never serve one origin's permission to another.
// `Access-Control-Allow-Credentials` is NEVER sent: this service has no cookies and no session, and
// reflecting an origin *with* credentials is precisely how a reflected-CORS policy turns into
// cross-site request forgery.
//
// WHAT THIS IS NOT. It is not authentication and it is not authorisation.
//
//   * CORS is enforced by browsers. `curl` ignores every header here. Nothing in this file keeps a
//     script off the endpoint; the rate limiter and the disk caps are what do that.
//   * `*-script.googleusercontent.com` is the sandbox shape for EVERY Apps Script project, not just
//     this one. Allowing it therefore allows any Apps Script add-on in the world to submit from a
//     visitor's browser. It cannot be narrowed further, because the only part of the host that
//     identifies the project is the opaque segment that rotates. What the policy does achieve is
//     keeping ordinary web pages -- an advertisement, a forum post, a phishing page -- from quietly
//     submitting on a visitor's behalf, and keeping the response unreadable to them if they try.
//
// A DISALLOWED ORIGIN IS REFUSED, NOT MERELY UNREADABLE. Omitting the header only stops the caller
// reading the response; the write still happened. So a request that carries a disallowed `Origin`
// is answered 403 and never reaches the store. A request with NO `Origin` (curl, a server-side
// caller, a health checker) is allowed through, because the header is absent exactly when it
// cannot be relied upon and refusing on its absence would be theatre -- any client can omit it.

export type CorsDecision =
  /** Not a browser-originated cross-origin request; no CORS headers apply. */
  | Readonly<{ kind: "no-origin" }>
  | Readonly<{ kind: "allowed"; origin: string }>
  | Readonly<{ kind: "denied"; reason: CorsDenialReason }>;

export type CorsDenialReason = "unparseable" | "not-https" | "host-not-allowed";

export type CorsPolicy = Readonly<{
  /**
   * Host patterns allowed over https with no port. A leading `*` matches exactly one DNS label
   * fragment -- no dots -- so `*-script.googleusercontent.com` matches the Apps Script sandbox and
   * nothing deeper or broader. A pattern with no `*` must match the host exactly.
   */
  allowedHostPatterns: readonly string[];
  /** Exact origins, for local development. Matched verbatim, so `http:` is permitted here. */
  allowedOrigins: readonly string[];
}>;

/** The methods this service answers. Echoed in the preflight response and in a 405's `Allow`. */
export const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

/**
 * The request headers a caller may set. `content-type` is needed for the JSON body;
 * `x-deletion-token` carries the deletion secret. Nothing else is permitted, which is how the
 * preflight stays a meaningful gate instead of a formality.
 */
export const ALLOWED_REQUEST_HEADERS = "content-type, x-deletion-token";

export function corsDecisionFor(options: { origin: string | null; policy: CorsPolicy }): CorsDecision {
  if (options.origin === null || options.origin === "") return { kind: "no-origin" };
  if (options.policy.allowedOrigins.includes(options.origin)) {
    return { kind: "allowed", origin: options.origin };
  }
  const parsed = parseOrigin(options.origin);
  if (parsed === null) return { kind: "denied", reason: "unparseable" };
  if (parsed.protocol !== "https:") return { kind: "denied", reason: "not-https" };
  if (parsed.port !== "") return { kind: "denied", reason: "host-not-allowed" };
  if (!isAllowedHost({ hostname: parsed.hostname, patterns: options.policy.allowedHostPatterns })) {
    return { kind: "denied", reason: "host-not-allowed" };
  }
  return { kind: "allowed", origin: options.origin };
}

function isAllowedHost(options: Readonly<{ hostname: string; patterns: readonly string[] }>): boolean {
  for (const pattern of options.patterns) {
    if (matchesHostPattern({ hostname: options.hostname, pattern })) return true;
  }
  return false;
}

/**
 * The wildcard is deliberately weak: one leading `*`, matching a run of label characters with no
 * dot in it. A pattern with a `*` anywhere else is treated as unmatchable rather than interpreted,
 * so a mis-set `REPORT_ALLOWED_HOST_PATTERNS` fails closed instead of opening something up.
 */
function matchesHostPattern(options: Readonly<{ hostname: string; pattern: string }>): boolean {
  const starAt = options.pattern.indexOf("*");
  if (starAt === -1) return options.hostname === options.pattern;
  if (starAt !== 0) return false;
  const tail = options.pattern.slice(1);
  if (tail.includes("*") || !(tail.startsWith("-") || tail.startsWith("."))) return false;
  if (!options.hostname.endsWith(tail)) return false;
  const head = options.hostname.slice(0, options.hostname.length - tail.length);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(head);
}

/**
 * Round-trips the origin through the URL parser and insists the result is identical. That single
 * check rejects a trailing slash, an embedded path, userinfo, a non-lowercase host and every other
 * spelling that would otherwise let a crafted `Origin` match a pattern it should not.
 */
function parseOrigin(origin: string): URL | null {
  const parsed = parseUrl(origin);
  if (parsed === null) return null;
  if (parsed.origin !== origin) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed;
}

function parseUrl(candidate: string): URL | null {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * Which `redirect_uri` an OAuth client may be sent back to.
 *
 * Three surfaces have to work, and they need different matching rules:
 *
 *  - **Claude's hosted surfaces** come back to one fixed HTTPS URI,
 *    `https://claude.ai/api/mcp/auth_callback`. Exact string match.
 *  - **ChatGPT** comes back to `https://chatgpt.com/connector_platform_oauth_redirect` when
 *    the authorization server advertises RFC 9207 issuer identification (we do), and to a
 *    per-connection `https://chatgpt.com/connector/oauth/{callback_id}` otherwise. Both
 *    arrive in the DCR body, so both are exact matches; the stable one is also accepted
 *    for every client (see `HOSTED_REDIRECT_URIS`). Source:
 *    https://developers.openai.com/apps-sdk/build/auth ("Redirect URL").
 *  - **Claude Code** runs a loopback listener on an ephemeral port, so the port it
 *    registers with and the port it actually asks for will differ. RFC 8252 section 7.3
 *    ("Loopback Interface Redirection") says exactly this: the authorization server MUST
 *    allow any port for a loopback redirect. We additionally treat `localhost`,
 *    `127.0.0.1` and `::1` as the same host, because the client may register one spelling
 *    and request another.
 *
 * Everything else is an exact match. Relaxing the host — not just the port — would turn
 * this endpoint into an open redirector, which is the delivery mechanism for the
 * "confused deputy" attack the MCP authorization spec's security considerations name.
 */

/** Claude's hosted callback. Accepted for every registered client; see `oauth-store.ts`. */
export const CLAUDE_HOSTED_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/** ChatGPT's stable callback, used once the server advertises RFC 9207 `iss`. */
export const CHATGPT_STABLE_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

/**
 * Fixed callbacks added to every registration. Claude's because its hosted surfaces return
 * there even when the client registered only a loopback URI. ChatGPT's because a connection
 * that registered its per-connection URI keeps reusing that client, and ChatGPT moves to the
 * stable URI once it sees our `iss` support.
 */
export const HOSTED_REDIRECT_URIS: readonly string[] = [CLAUDE_HOSTED_REDIRECT_URI, CHATGPT_STABLE_REDIRECT_URI];

export type RedirectUriMatch =
  | Readonly<{ kind: "allowed"; registered: string }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export function matchRedirectUri(
  options: Readonly<{ registered: readonly string[]; requested: string }>,
): RedirectUriMatch {
  const requested = parseRedirectUri(options.requested);
  if (requested === null) {
    return { kind: "rejected", reason: `redirect_uri is not an absolute URI: ${options.requested}` };
  }
  for (const candidate of options.registered) {
    if (candidate === options.requested) return { kind: "allowed", registered: candidate };
    const registered = parseRedirectUri(candidate);
    if (registered === null) continue;
    if (loopbackEquivalent({ registered, requested })) return { kind: "allowed", registered: candidate };
  }
  return {
    kind: "rejected",
    reason: `redirect_uri ${options.requested} matches none of the registered redirect URIs`,
  };
}

/** `true` for the hosts RFC 8252 section 7.3 calls the loopback interface. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

type RedirectUri = Readonly<{ protocol: string; hostname: string; pathname: string; search: string }>;

function parseRedirectUri(value: string): RedirectUri | null {
  try {
    const url = new URL(value);
    // A fragment is forbidden on a redirect URI (RFC 6749 section 3.1.2) and would also
    // collide with the query parameters we append, so it is rejected rather than ignored.
    if (url.hash !== "") return null;
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    };
  } catch {
    return null;
  }
}

/**
 * The port-ignoring comparison. Both sides must be loopback: a registered loopback URI does
 * not authorise a redirect to some other host, and a registered public host still requires
 * an exact match (handled by the caller before this is reached).
 */
function loopbackEquivalent(
  options: Readonly<{ registered: RedirectUri; requested: RedirectUri }>,
): boolean {
  const { registered, requested } = options;
  if (!isLoopbackHost(registered.hostname) || !isLoopbackHost(requested.hostname)) return false;
  if (registered.protocol !== requested.protocol) return false;
  if (registered.pathname !== requested.pathname) return false;
  return registered.search === requested.search;
}

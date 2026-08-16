// Egress policy shared by the page fetch override (vm.html), the runtime worker and the server
// gateway: which hosts must go through POST /net/fetch (no CORS at the vendor) and which are
// fetched straight from the browser. Anything not listed is fetched directly — if the vendor
// doesn't answer CORS the request fails visibly instead of being laundered through our server.
// The server enforces the SAME list, so the gateway cannot be used as an open proxy / SSRF into
// the machine it runs on.
(function (global) {
  // hosts that need the relay (verified 2026-08-16: no Access-Control-Allow-Origin on these)
  const PROXY_HOSTS = [
    "api.anthropic.com",            // Claude Code preflight /api/hello, event logging
    "platform.claude.com",          // /v1/oauth/hello
    "chatgpt.com", "ab.chatgpt.com",// codex telemetry / plugins
    "antigravity-cli-auto-updater-974169037036.us-central1.run.app", // agy manifest
    "storage.googleapis.com",       // agy tarball (bucket antigravity-public)
    "play.googleapis.com",          // agy telemetry
  ];
  // hosts known to answer CORS: never proxied (registry.npmjs.org, raw.githubusercontent.com,
  // auth.openai.com, api.openai.com, github release assets, ...)
  const isProxied = (urlOrHost) => {
    let host = urlOrHost; try { host = new URL(urlOrHost).hostname; } catch {}
    return PROXY_HOSTS.some((h) => host === h || host.endsWith("." + h));
  };
  global.NanoboxNetPolicy = { PROXY_HOSTS, isProxied };
})(typeof self !== "undefined" ? self : globalThis);

# Shared identity in SashaSlides

The HTTP composition can use the same `oauth/` identity package as AveMachina. Set `SASHA_SHARED_AUTH_CONFIG` to a deployment-local JSON file to enable it. With the variable absent, startup and legacy MCP/account routes retain their existing behavior. An invalid explicit configuration refuses startup; it never silently falls back to a different login authority.

Build the submodule first (`npm ci && npm run build` in `oauth/`). The Node server imports emitted JavaScript only. Enabled storage uses Node's `node:sqlite` (Node22.13+ or24). Secrets and the persistent database must survive releases; protect their enclosing directory and secret files. SQLite is created with mode0600.

```json
{
  "databasePath": "state/shared-auth.sqlite",
  "secretPath": "secrets/shared-auth-secret",
  "audience": "https://sashaslides.com",
  "captcha": {
    "siteKey": "PUBLIC_TURNSTILE_SITE_KEY",
    "secretPath": "secrets/turnstile-secret"
  },
  "clients": [
    {
      "clientId": "sashaslides-web",
      "name": "SashaSlides",
      "redirectUris": ["https://sashaslides.com/auth/finished"]
    }
  ]
}
```

Paths in this JSON are relative to its directory. The existing `--public-url` supplies the exact HTTPS origin. Existing `--identity-providers`, connector Google credentials, `--mail-sender` and `--trusted-proxy` configuration are reused. Enabled shared auth requires a usable mail sender for verification/recovery; an empty placeholder is a configuration error. Existing Google/GitHub/Apple/generic OIDC identities retain their provider names, but their new callback is `/api/auth/callback/<provider>`, which must be registered at the provider. Apple keeps the existing short-lived assertion signer and reads a fresh assertion at token exchange.

The same server mounts `/api/auth/*` before generic MCP CORS and serves the shared React shell at `/auth/sign-in`, its public `/auth/config`, and local JS/CSS assets. Managed Turnstile is loaded only when adaptive admission requests a challenge. The public config contains no provider credential, mail secret, token or auth encryption secret. The [shared package contract](../../../oauth/README.md) defines PKCE, anonymous refresh, limits and access-token verification.

## Account migration boundary

A verified non-anonymous shared identity can use Sasha tools only when an explicit `accountLinks` row with provider `shared` and the verified shared subject points to an existing Sasha account, and that account still owns a usable Google grant. Anonymous, unlinked and revoked/insufficient-grant accounts cannot acquire tools. Email equality never links accounts. A migration must verify possession of both identities before writing this link; this integration does not expose an unverified public account-link endpoint.

The existing Google grant vault, MCP authorization-code broker and legacy account/deck session routes remain compatible during migration. This is the first composition step, not a completed replacement of every legacy login/deck session. Rollout must migrate/link users and switch legacy entry points before declaring one account authority fully deployed. No production provider, mail, CAPTCHA or database configuration is supplied by this patch.

## Verification

The shared package's colocated [workflow](../../../oauth/SKILL.md) runs protocol, real SQLite/restart and actual React PKCE browser checks using local fakes. Sasha-specific checks are `npx tsx --test mcp/sasha-slides/test/shared-auth.test.ts mcp/sasha-slides/test/account-portal-stack.test.ts` and `npx tsc -p mcp/sasha-slides`. Install the existing engine dependencies and `@types/ws` before the full server typecheck. Tests exercise the real HTTP mount and config loader without real mail/provider requests. They assert private body bounds, trusted socket IP, local hosted assets and Google-grant authorization separately from identity.

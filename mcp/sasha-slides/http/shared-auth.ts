import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../../../oauth/src/principal.ts';
import { accountLinkKey } from './account-directory.ts';
import type { AuthorizationServer } from './authorization-server.ts';
import { clientAddress, type TrustedProxies } from './client-address.ts';
import { missingGoogleGrant } from './google-grants.ts';
import { readBodyText } from './http-kit.ts';
import { BROKERED_SCOPES } from './oauth-metadata.ts';
import type { AuthStore } from './oauth-store.ts';

/** Shared identity delegates only to an existing explicit Sasha account/Google grant. */
export function withSharedIdentity(
  options: Readonly<{
    legacy: AuthorizationServer;
    store: AuthStore;
    providerName: string;
    verifyAccessToken: (options: Readonly<{ token: string }>) => Promise<Principal | null>;
  }>,
): AuthorizationServer {
  return {
    ...options.legacy,
    verifyBearer: async ({ token }) => {
      const existing = await options.legacy.verifyBearer({ token });
      if (existing.kind === 'authorized' || !token) return existing;
      const identity = await options.verifyAccessToken({ token });
      if (identity === null || identity.anonymous) return existing;
      const link = await options.store.accountLinks.get({
        key: accountLinkKey({ provider: options.providerName, subject: identity.subject }),
      });
      if (link === null) return existing;
      const account = await options.store.accounts.get({ key: link.accountId });
      if (account?.googleSubject === null || account?.googleSubject === undefined) return existing;
      const grant = await options.store.googleIdentities.get({ key: account.googleSubject });
      if (grant === null || missingGoogleGrant({ grantedScopes: grant.grantedScopes }) !== null)
        return existing;
      return {
        kind: 'authorized',
        authInfo: {
          token,
          clientId: 'shared-account',
          scopes: [...BROKERED_SCOPES],
          expiresAt: Math.floor(identity.expiresAt / 1000),
          resource: new URL(options.legacy.endpoints.mcpUrl),
          extra: { googleSubject: grant.subject },
        },
      };
    },
  };
}

/** Mount before generic MCP CORS; shared auth owns origin/CORS and all IP-based admission. */
export function sharedAuthRoutes(
  options: Readonly<{
    shared: Readonly<{
      issuer: string;
      handler: (options: Readonly<{ request: Request; clientIp: string }>) => Promise<Response>;
    }>;
    trustedProxies: TrustedProxies;
  }>,
) {
  const issuer = new URL(options.shared.issuer);
  const basePath = issuer.pathname.replace(/\/$/, '');
  return {
    handleRequest: async ({
      request,
      response,
      url,
    }: Readonly<{
      request: IncomingMessage;
      response: ServerResponse;
      url: URL;
    }>): Promise<boolean> => {
      if (url.pathname !== basePath && !url.pathname.startsWith(basePath + '/')) return false;
      const body = await readBodyText({ request, maximumBytes: 65536, onOverflow: 'drain' });
      if (body === null) {
        response
          .writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify({ error: 'request_too_large' }));
        return true;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== 'host' && name !== 'content-length')
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const result = await options.shared.handler({
        request: new Request(new URL(url.pathname + url.search, issuer.origin), {
          method: request.method ?? 'GET',
          headers,
          ...(body.length > 0 ? { body } : {}),
        }),
        clientIp: clientAddress({ request, trustedProxies: options.trustedProxies }).address,
      });
      response.statusCode = result.status;
      result.headers.forEach((value, name) => {
        if (name !== 'set-cookie') response.setHeader(name, value);
      });
      const cookies = result.headers.getSetCookie();
      if (cookies.length > 0) response.setHeader('set-cookie', cookies);
      response.end(Buffer.from(await result.arrayBuffer()));
      return true;
    },
  };
}

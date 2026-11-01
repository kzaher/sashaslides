import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { SharedAuthOptions } from '../../../oauth/src/server.ts';
import { loadIdentityProviderSpecs, loadMailSenderConfig } from './account-portal-stack.ts';
import type { GoogleClientCredentials } from '../google-auth.ts';
import { appleClientSecret, type IdentityProviderSpec } from './identity-providers.ts';
import { createGmailSender, MAIL_SENDER_TIMEOUT_MS } from './gmail-sender.ts';
import { LOOPBACK_PROXIES, parseTrustedProxies } from './client-address.ts';
import type { AuthStore } from './oauth-store.ts';
import type { AuthorizationServer } from './authorization-server.ts';
import { sharedAuthRoutes, withSharedIdentity } from './shared-auth.ts';
import { escapeHtml } from './html-pages.ts';
import { assertNever } from '../engine/src/contracts/assert-never.ts';

const configuration = z
  .object({
    databasePath: z.string().min(1),
    secretPath: z.string().min(1),
    audience: z.string().url(),
    captcha: z.object({ siteKey: z.string().min(1), secretPath: z.string().min(1) }).strict(),
    clients: z
      .array(
        z
          .object({
            clientId: z.string().min(1),
            name: z.string().min(1),
            redirectUris: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

type SharedAuthLoad =
  | Readonly<{ kind: 'off'; banner: readonly string[] }>
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{
      kind: 'ok';
      authorizationServer: AuthorizationServer;
      routes: ReturnType<typeof sharedAuthRoutes>;
      close: () => void;
      banner: readonly string[];
    }>;

/** Opt-in uses the same provider/mail files; no auth work or migration occurs when absent. */
export async function loadSharedAuth(
  options: Readonly<{
    configPath: string | undefined;
    publicUrl: string;
    identityProvidersPath: string | null;
    mailSenderPath: string | null;
    googleClient: GoogleClientCredentials;
    trustedProxies: string | null;
    store: AuthStore;
    authorizationServer: AuthorizationServer;
  }>,
): Promise<SharedAuthLoad> {
  if (!options.configPath)
    return {
      kind: 'off',
      banner: [
        'shared identity: off (set SASHA_SHARED_AUTH_CONFIG to a private deployment config)',
      ],
    };
  let database: DatabaseSync | null = null;
  try {
    const parsed = configuration.safeParse(JSON.parse(readFileSync(options.configPath, 'utf8')));
    if (!parsed.success)
      return {
        kind: 'failed',
        message:
          'shared identity config invalid at ' +
          parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      };
    const config = parsed.data;
    const directory = dirname(resolve(options.configPath));
    const path = (value: string) => resolve(directory, value);
    const secret = readFileSync(path(config.secretPath), 'utf8').trim();
    const captchaSecret = readFileSync(path(config.captcha.secretPath), 'utf8').trim();
    if (secret.length < 32 || !captchaSecret)
      return {
        kind: 'failed',
        message: 'shared identity requires persistent auth and CAPTCHA secrets',
      };
    if (options.mailSenderPath === null)
      return {
        kind: 'failed',
        message:
          'shared identity requires the existing --mail-sender file for verified email/recovery',
      };
    const mail = loadMailSenderConfig(options.mailSenderPath);
    if (mail.kind === 'failed') return mail;
    const specs = loadIdentityProviderSpecs({
      identityProvidersPath: options.identityProvidersPath,
      googleClient: options.googleClient,
    });
    if (specs.kind === 'failed') return specs;
    const proxies =
      options.trustedProxies === null
        ? { kind: 'ok' as const, proxies: LOOPBACK_PROXIES }
        : parseTrustedProxies({ text: options.trustedProxies });
    if (proxies.kind === 'error') return { kind: 'failed', message: proxies.message };
    const providerOptions = sharedProviderOptions(specs.specs);
    const databasePath = path(config.databasePath);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    // Built JavaScript is the shared release boundary. Off deployments never import it.
    const { createSharedAuth } = await import('../../../oauth/dist/server.js');
    const { createAuthWebsite } = await import('../../../oauth/dist/website.js');
    const sender = createGmailSender({
      config: mail.config,
      fetch,
      now: () => new Date(),
      randomToken: randomUUID,
      timeoutMs: MAIL_SENDER_TIMEOUT_MS,
    });
    const sendMail = async (
      message: Readonly<{ address: string; url: string }>,
      purpose: string,
    ) => {
      const result = await sender.send({
        to: message.address,
        subject: 'SashaSlides ' + purpose,
        text: purpose + ': ' + message.url,
        html:
          '<p>' +
          escapeHtml(purpose) +
          '</p><p><a href="' +
          escapeHtml(message.url) +
          '">Continue securely</a></p>',
      });
      if (result.kind === 'failed') throw new Error('Identity mail delivery failed');
    };
    const origin = new URL(options.publicUrl).origin;
    const shared = createSharedAuth({
      origin,
      basePath: '/api/auth',
      audience: config.audience,
      secret,
      database,
      ...providerOptions,
      trustedOrigins: [origin],
      clients: config.clients,
      mail: {
        sendVerification: (message) => sendMail(message, 'Verify your email'),
        sendRecovery: (message) => sendMail(message, 'Reset your password'),
      },
      captcha: { provider: 'cloudflare-turnstile', secretKey: captchaSecret },
      captchaSiteKey: config.captcha.siteKey,
      randomId: randomUUID,
    });
    await shared.migrate();
    const api = sharedAuthRoutes({ shared, trustedProxies: proxies.proxies });
    const website = createAuthWebsite({
      origin,
      basePath: '/api/auth',
      appName: 'SashaSlides',
      captchaSiteKey: config.captcha.siteKey,
      providers: specs.specs.map((spec) => ({ id: spec.name, name: spec.displayName })),
    });
    const routes: ReturnType<typeof sharedAuthRoutes> = {
      handleRequest: async ({ request, response, url }) => {
        const page = await website(
          new Request(new URL(url.pathname + url.search, origin), {
            method: request.method ?? 'GET',
          }),
        );
        if (page === null) return api.handleRequest({ request, response, url });
        response.statusCode = page.status;
        page.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(Buffer.from(await page.arrayBuffer()));
        return true;
      },
    };
    const ownedDatabase = database;
    return {
      kind: 'ok',
      routes,
      authorizationServer: withSharedIdentity({
        legacy: options.authorizationServer,
        store: options.store,
        providerName: 'shared',
        verifyAccessToken: shared.verifyAccessToken,
      }),
      close: () => ownedDatabase.close(),
      banner: [
        'shared identity: ' + shared.issuer + ' (explicit linked Sasha accounts only)',
        'shared identity UI: ' + origin + '/auth/sign-in',
      ],
    };
  } catch (cause) {
    database?.close();
    // Configs and provider errors may contain credentials; diagnostics must never echo them.
    return {
      kind: 'failed',
      message:
        'shared identity startup failed (' +
        (cause instanceof Error ? cause.name : 'unknown error') +
        ')',
    };
  }
}

/** Provider identities keep their existing names; no email-based account merge is introduced. */
export function sharedProviderOptions(
  specs: readonly IdentityProviderSpec[],
): Pick<SharedAuthOptions, 'providers' | 'genericProviders'> {
  const providers: SharedAuthOptions['providers'] = {};
  const genericProviders: Array<SharedAuthOptions['genericProviders'][number]> = [];
  for (const spec of specs) {
    switch (spec.protocol) {
      case 'oidc':
        genericProviders.push({
          providerId: spec.name,
          clientId: spec.clientId,
          clientSecret: spec.clientSecret,
          discoveryUrl: spec.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration',
          scopes: [...spec.scopes],
          pkce: true,
        });
        break;
      case 'github':
        providers.github = {
          clientId: spec.clientId,
          clientSecret: spec.clientSecret,
          scope: [...spec.scopes],
        };
        break;
      case 'apple':
        // The pinned provider reads options.clientSecret at token exchange, not only initialization.
        providers.apple = {
          clientId: spec.clientId,
          get clientSecret() {
            return appleClientSecret({ ...spec, nowMs: Date.now() });
          },
          scope: [...spec.scopes],
        };
        break;
      default:
        assertNever(spec);
    }
  }
  return { providers, genericProviders };
}

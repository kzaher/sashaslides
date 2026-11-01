import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Principal } from '../../../oauth/src/principal.ts';
import { authWebsiteConfig } from '../../../oauth/src/websiteConfig.ts';
import { oauthTokenResponse } from '../../../oauth/src/client.ts';
import {
  createAuthorizationServer,
  defaultAuthorizationServerConfig,
  hashToken,
} from '../http/authorization-server.ts';
import { endpointsFor } from '../http/oauth-metadata.ts';
import { inMemoryAuthStore } from '../http/oauth-store.ts';
import { accountLinkKey } from '../http/account-directory.ts';
import { withSharedIdentity, sharedAuthRoutes } from '../http/shared-auth.ts';
import { NO_TRUSTED_PROXIES } from '../http/client-address.ts';
import { createSashaSlidesHttpServer } from '../http/http-server.ts';
import { loadSharedAuth, sharedProviderOptions } from '../http/shared-auth-stack.ts';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const issuer = 'https://identity.example.test/api/auth';
const principal: Principal = {
  subject: 'shared-user',
  anonymous: false,
  expiresAt: 4102444800000,
  issuer,
  audience: 'https://slides.example.test',
  scopes: ['openid', 'profile'],
};

test('a shared account bearer delegates only to its explicitly linked Sasha Google grant', async () => {
  const runtime = await fixture(principal);
  const result = await runtime.server.verifyBearer({ token: 'shared-account-token' });
  assert.equal(result.kind, 'authorized');
  if (result.kind !== 'authorized') throw new Error('No verified account');
  assert.equal(result.authInfo.extra?.googleSubject, 'owned-google-subject');
  assert.equal(result.authInfo.expiresAt, principal.expiresAt / 1000);
});

test('anonymous, unlinked and revoked-grant identities cannot acquire Sasha tools', async () => {
  for (const identity of [{ ...principal, anonymous: true }, null]) {
    const runtime = await fixture(identity);
    assert.equal(
      (await runtime.server.verifyBearer({ token: 'shared-account-token' })).kind,
      'unauthorized',
    );
  }
  const runtime = await fixture(principal);
  await runtime.store.accountLinks.remove({
    key: accountLinkKey({ provider: 'shared', subject: principal.subject }),
  });
  assert.equal(
    (await runtime.server.verifyBearer({ token: 'shared-account-token' })).kind,
    'unauthorized',
  );
  const revoked = await fixture(principal);
  await revoked.store.googleIdentities.remove({ key: 'owned-google-subject' });
  assert.equal(
    (await revoked.server.verifyBearer({ token: 'shared-account-token' })).kind,
    'unauthorized',
  );
});

async function fixture(identity: Principal | null) {
  const store = inMemoryAuthStore();
  await store.accountLinks.put({
    key: accountLinkKey({ provider: 'shared', subject: principal.subject }),
    value: {
      accountId: 'existing-sasha-account',
      provider: 'shared',
      subject: principal.subject,
      sealedEmail: null,
      linkedAtMs: 1,
    },
  });
  await store.accounts.put({
    key: 'existing-sasha-account',
    value: {
      accountId: 'existing-sasha-account',
      createdAtMs: 1,
      linkKeys: [],
      googleSubject: 'owned-google-subject',
    },
  });
  await store.googleIdentities.put({
    key: 'owned-google-subject',
    value: {
      subject: 'owned-google-subject',
      email: null,
      accessToken: null,
      refreshToken: 'test-only-stored-google-grant',
      accessTokenExpiresAtMs: null,
      grantedScopes: [],
    },
  });
  const endpoints = endpointsFor({ publicUrl: 'https://slides.example.test' });
  const legacy = createAuthorizationServer({
    config: defaultAuthorizationServerConfig({ endpoints }),
    store,
    google: {
      authorizationUrl: () => {
        throw new Error('No external provider in this test');
      },
      exchangeCode: async () => {
        throw new Error('No external provider in this test');
      },
      refresh: async () => {
        throw new Error('No external provider in this test');
      },
    },
    now: () => new Date(0),
    randomToken: () => 'local-test-token',
    warn: () => {},
  });
  const server = withSharedIdentity({
    legacy,
    store,
    providerName: 'shared',
    verifyAccessToken: async () => identity,
  });
  return { store, server };
}

test('legacy bearer remains compatible and shared identity cannot invent or widen a Google grant', async () => {
  const runtime = await fixture(principal);
  await runtime.store.accessTokens.put({
    key: hashToken('legacy-token'),
    value: {
      clientId: 'legacy-client',
      googleSubject: 'owned-google-subject',
      scopes: ['openid'],
      resource: null,
      expiresAtMs: 60000,
    },
  });
  const legacy = await runtime.server.verifyBearer({ token: 'legacy-token' });
  assert.equal(legacy.kind, 'authorized');
  if (legacy.kind === 'authorized') assert.equal(legacy.authInfo.clientId, 'legacy-client');
  const grant = await runtime.store.googleIdentities.get({ key: 'owned-google-subject' });
  assert.ok(grant);
  await runtime.store.googleIdentities.put({
    key: grant.subject,
    value: { ...grant, grantedScopes: ['openid'] },
  });
  assert.equal(
    (await runtime.server.verifyBearer({ token: 'shared-account-token' })).kind,
    'unauthorized',
  );
});

test('actual Sasha HTTP composition mounts auth before generic CORS, bounds bodies and trusts socket identity', async () => {
  const runtime = await fixture(null);
  const calls: Array<Readonly<{ url: string; ip: string; body: string }>> = [];
  const server = createSashaSlidesHttpServer({
    authorizationServer: runtime.server,
    createMcpServer: () => {
      throw new Error('No MCP call in auth test');
    },
    instrumentTransport: (inner) => inner,
    warn: () => {},
    sharedAuth: sharedAuthRoutes({
      trustedProxies: NO_TRUSTED_PROXIES,
      shared: {
        issuer,
        handler: async ({ request, clientIp }) => {
          calls.push({ url: request.url, ip: clientIp, body: await request.text() });
          return new Response('owned-auth-response', {
            status: 201,
            headers: {
              'set-cookie': 'owned=1; Secure; HttpOnly',
              'access-control-allow-origin': 'https://identity.example.test',
            },
          });
        },
      },
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const local = 'http://127.0.0.1:' + address.port;
  try {
    const response = await fetch(local + '/api/auth/anonymous', {
      method: 'POST',
      headers: {
        host: 'attacker.invalid',
        'x-real-ip': '203.0.113.50',
        'x-forwarded-for': '203.0.113.60',
      },
      body: '{"client_id":"sashaslides-web"}',
    });
    assert.equal(response.status, 201);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://identity.example.test',
    );
    assert.ok(response.headers.get('set-cookie')?.includes('HttpOnly'));
    assert.deepEqual(calls[0], {
      url: issuer + '/anonymous',
      ip: '127.0.0.1',
      body: '{"client_id":"sashaslides-web"}',
    });
    assert.equal(
      (await fetch(local + '/api/auth/anonymous', { method: 'POST', body: 'x'.repeat(65537) }))
        .status,
      413,
    );
    assert.equal(calls.length, 1, 'over-limit body cannot reach identity owner');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('opt-in Sasha loader migrates persistent shared auth and serves its same-origin React shell', async () => {
  const runtime = await fixture(null);
  const directory = mkdtempSync(join(tmpdir(), 'sasha-shared-auth-'));
  const configPath = join(directory, 'shared.json');
  const mailSenderPath = join(directory, 'mail.json');
  writeFileSync(join(directory, 'secret'), 'private-sasha-test-secret-not-production-0123456789', {
    mode: 0o600,
  });
  writeFileSync(join(directory, 'captcha'), 'fake-captcha-secret-never-sent', { mode: 0o600 });
  writeFileSync(
    mailSenderPath,
    JSON.stringify({
      clientId: 'owned-mail-id',
      clientSecret: 'owned-mail-secret',
      refreshToken: 'owned-mail-refresh',
      from: 'SashaSlides <noreply@example.test>',
    }),
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      databasePath: 'state/auth.sqlite',
      secretPath: 'secret',
      audience: 'https://slides.example.test',
      captcha: { siteKey: 'public-site-key', secretPath: 'captcha' },
      clients: [
        {
          clientId: 'sashaslides-web',
          name: 'SashaSlides',
          redirectUris: ['https://slides.example.test/auth/finished'],
        },
      ],
    }),
  );
  const options = {
    configPath,
    publicUrl: 'https://slides.example.test',
    identityProvidersPath: null,
    mailSenderPath,
    googleClient: { clientId: 'owned-google-id', clientSecret: 'owned-google-secret' },
    trustedProxies: null,
    store: runtime.store,
    authorizationServer: runtime.server,
  };
  assert.equal((await loadSharedAuth({ ...options, configPath: undefined })).kind, 'off');
  const loaded = await loadSharedAuth(options);
  assert.equal(loaded.kind, 'ok', loaded.kind === 'failed' ? loaded.message : 'not enabled');
  if (loaded.kind !== 'ok') throw new Error('Shared identity not enabled');
  assert.equal(statSync(join(directory, 'state/auth.sqlite')).mode & 0o777, 0o600);
  const server = createSashaSlidesHttpServer({
    authorizationServer: loaded.authorizationServer,
    createMcpServer: () => {
      throw new Error('No MCP call in auth test');
    },
    instrumentTransport: (inner) => inner,
    warn: () => {},
    sharedAuth: loaded.routes,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const local = 'http://127.0.0.1:' + address.port;
  try {
    const config = await fetch(local + '/auth/config');
    assert.equal(config.status, 200);
    const publicData = authWebsiteConfig.parse(await config.json());
    assert.deepEqual(publicData.providers, [{ id: 'google', name: 'Google' }]);
    assert.equal(publicData.appName, 'SashaSlides');
    assert.ok(!JSON.stringify(publicData).includes('owned-google-secret'));
    const page = await fetch(local + '/auth/sign-in');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('/auth/auth-ui.js'));
    const enrolled = await fetch(local + '/api/auth/anonymous', {
      method: 'POST',
      headers: { origin: 'https://slides.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'sashaslides-web' }),
    });
    assert.equal(enrolled.status, 200);
    const token = oauthTokenResponse.parse(await enrolled.json());
    assert.equal(token.token_type, 'Bearer');
    assert.equal(
      (await loaded.authorizationServer.verifyBearer({ token: token.access_token })).kind,
      'unauthorized',
      'anonymous identity does not grant Slides access',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    loaded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Sasha provider adapter reuses configured provider identities and rotates Apple assertions at read time', (context) => {
  const initialTime = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now: initialTime });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const options = sharedProviderOptions([
    {
      protocol: 'oidc',
      name: 'owned-oidc',
      displayName: 'Work',
      issuer: 'https://id.example.test',
      issuers: ['https://id.example.test'],
      clientId: 'client',
      clientSecret: 'secret',
      scopes: ['openid'],
    },
    {
      protocol: 'github',
      name: 'github',
      displayName: 'GitHub',
      clientId: 'github-client',
      clientSecret: 'github-secret',
      scopes: ['read:user'],
    },
    {
      protocol: 'apple',
      name: 'apple',
      displayName: 'Apple',
      clientId: 'apple-client',
      teamId: 'team',
      keyId: 'key',
      privateKey,
      scopes: ['email'],
    },
  ]);
  assert.equal(options.genericProviders[0]?.providerId, 'owned-oidc');
  assert.equal(options.genericProviders[0]?.pkce, true);
  assert.ok(options.providers.github);
  const apple = options.providers.apple;
  assert.ok(apple && typeof apple !== 'function');
  assert.equal(
    Object.getOwnPropertyDescriptor(apple, 'clientSecret')?.get instanceof Function,
    true,
  );
  const assertion = apple.clientSecret;
  assert.ok(assertion);
  const payload = JSON.parse(
    Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8'),
  );
  assert.equal(payload.sub, 'apple-client');
  assert.equal(payload.exp - payload.iat, 300);
  context.mock.timers.setTime(initialTime + 301000);
  const next = JSON.parse(
    Buffer.from(apple.clientSecret?.split('.')[1] ?? '', 'base64url').toString('utf8'),
  );
  assert.equal(next.iat - payload.iat, 301);
  assert.equal(next.exp - next.iat, 300);
});

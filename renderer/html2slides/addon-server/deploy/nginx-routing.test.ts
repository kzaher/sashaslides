// THE NGINX ROUTING CONTRACT for sashaslides.com: every path the Sasha Slides connector serves
// reaches the connector, and every page the website serves still reaches the website.
//
// nginx is not installed in the devcontainer, so this reimplements its location selection
// (exact `=`, then the longest prefix, where `^~` stops the regex search, then the first
// matching `~` regex in file order, else the longest prefix) over the parsed config.
//
//   npx tsx --test renderer/html2slides/addon-server/deploy/nginx-routing.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const CONFIG_TEXT = readFileSync(join(import.meta.dirname, "nginx-sashaslides.conf"), "utf8");
const SITE = "http://127.0.0.1:6000";
const CONNECTOR = "http://127.0.0.1:6100";

/** Every path the connector answers (http/http-server.ts, http/oauth-metadata.ts, http/account-portal.ts). */
const CONNECTOR_PATHS: readonly string[] = [
  "/mcp",
  "/mcp/",
  "/register",
  "/authorize",
  "/token",
  "/oauth/google/callback",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/mcp",
  "/account",
  "/account/",
  "/account/login/google",
  "/account/callback/microsoft",
  "/account/erase",
  "/account/logout",
];

/** The website's routes (addon-server/server.ts, pages.ts), plus near-misses of connector paths. */
const SITE_PATHS: readonly string[] = [
  "/",
  "/dev",
  "/dev/",
  "/privacy",
  "/terms",
  "/healthz",
  "/static/app.css",
  "/drawio",
  "/drawio/index.html",
  "/api/config",
  "/api/export",
  "/install.sh",
  "/shell.html",
  "/favicon.ico",
  "/home.html",
  "/accounting",
  "/mcpx",
  "/tokens",
  "/registered",
  "/.well-known/security.txt",
];

type Modifier = "exact" | "prefix" | "prefix-no-regex" | "regex";

type Location = Readonly<{ modifier: Modifier; pattern: string; body: string }>;

type Server = Readonly<{ listens: readonly string[]; locations: readonly Location[] }>;

test("every connector path is proxied to the connector", () => {
  const server = httpsServer();
  for (const path of CONNECTOR_PATHS) {
    assert.equal(proxyTarget(selectLocation({ server, path })), CONNECTOR, `${path} must reach the connector`);
  }
});

test("the connector's health check is published at /connector/healthz, rewritten to its /healthz", () => {
  const location = selectLocation({ server: httpsServer(), path: "/connector/healthz" });
  assert.equal(location.modifier, "exact");
  assert.equal(proxyPassValue(location), `${CONNECTOR}/healthz`);
});

test("every website path still reaches the website", () => {
  const server = httpsServer();
  for (const path of SITE_PATHS) {
    assert.equal(proxyTarget(selectLocation({ server, path })), SITE, `${path} must reach the website`);
  }
});

test("connector locations stream, forward the client's identity, and are never cached", () => {
  const server = httpsServer();
  for (const path of CONNECTOR_PATHS) {
    const { body } = selectLocation({ server, path });
    for (const directive of [
      /proxy_buffering\s+off;/,
      /proxy_http_version\s+1\.1;/,
      /proxy_set_header\s+Host\s+\$host;/,
      /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/,
      /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/,
      /proxy_set_header\s+X-Forwarded-Host\s+\$host;/,
      /add_header\s+Cache-Control\s+"no-store"\s+always;/,
    ]) {
      assert.match(body, directive, `${path} is missing ${String(directive)}`);
    }
    assert.doesNotMatch(body, /proxy_hide_header\s+Set-Cookie|proxy_ignore_headers/, `${path} must pass cookies`);
    const timeout = /proxy_read_timeout\s+(\d+)s;/.exec(body);
    assert.ok(timeout !== null && Number(timeout[1]) > 3600, `${path} must outlast await_pick's 3600 s limit`);
  }
});

test("port 80 still answers the ACME challenge from disk and redirects everything else", () => {
  const plain = servers().find((server) => server.listens.some((listen) => /^80\b/.test(listen)));
  assert.ok(plain !== undefined, "no port-80 server block");
  const acme = selectLocation({ server: plain, path: "/.well-known/acme-challenge/token" });
  assert.match(acme.body, /root\s+\/var\/www\/html;/);
  for (const path of ["/", "/mcp", "/account"]) {
    assert.match(selectLocation({ server: plain, path }).body, /return\s+301\s+https:/);
  }
});

function httpsServer(): Server {
  const server = servers().find((candidate) => candidate.listens.some((listen) => /:443\s+ssl/.test(listen)));
  assert.ok(server !== undefined, "no TLS server block");
  return server;
}

function servers(): readonly Server[] {
  const text = CONFIG_TEXT.replace(/#[^\n]*/g, "");
  return blocksNamed({ text, keyword: "server" }).map((body) => ({
    listens: [...body.matchAll(/^\s*listen\s+([^;]+);/gm)].map((match) => match[1] ?? ""),
    locations: locationsOf(body),
  }));
}

function blocksNamed(options: Readonly<{ text: string; keyword: string }>): readonly string[] {
  const result: string[] = [];
  const opener = new RegExp(`(^|[\\s;}])${options.keyword}\\s*\\{`, "g");
  for (const match of options.text.matchAll(opener)) {
    const open = match.index + match[0].length - 1;
    result.push(options.text.slice(open + 1, closingBrace({ text: options.text, open })));
  }
  return result;
}

function locationsOf(serverBody: string): readonly Location[] {
  const result: Location[] = [];
  const opener = /location\s+(=|\^~|~\*?)?\s*(\S+)\s*\{/g;
  for (const match of serverBody.matchAll(opener)) {
    const open = match.index + match[0].length - 1;
    result.push({
      modifier: modifierOf(match[1]),
      pattern: match[2] ?? "",
      body: serverBody.slice(open + 1, closingBrace({ text: serverBody, open })),
    });
  }
  return result;
}

function modifierOf(token: string | undefined): Modifier {
  if (token === undefined) return "prefix";
  if (token === "=") return "exact";
  if (token === "^~") return "prefix-no-regex";
  return "regex";
}

function closingBrace(options: Readonly<{ text: string; open: number }>): number {
  let depth = 0;
  for (let index = options.open; index < options.text.length; index += 1) {
    const character = options.text[index];
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error(`unbalanced brace at ${String(options.open)}`);
}

function selectLocation(options: Readonly<{ server: Server; path: string }>): Location {
  const { server, path } = options;
  const exact = server.locations.find((location) => location.modifier === "exact" && location.pattern === path);
  if (exact !== undefined) return exact;
  const prefixes = server.locations
    .filter((location) => location.modifier === "prefix" || location.modifier === "prefix-no-regex")
    .filter((location) => path.startsWith(location.pattern))
    .sort((left, right) => right.pattern.length - left.pattern.length);
  const longest = prefixes[0];
  if (longest?.modifier === "prefix-no-regex") return longest;
  const regex = server.locations.find(
    (location) => location.modifier === "regex" && new RegExp(location.pattern).test(path),
  );
  if (regex !== undefined) return regex;
  assert.ok(longest !== undefined, `no location matches ${path}`);
  return longest;
}

function proxyTarget(location: Location): string {
  return new URL(proxyPassValue(location)).origin;
}

function proxyPassValue(location: Location): string {
  const match = /proxy_pass\s+([^;]+);/.exec(location.body);
  assert.ok(match !== null, `location ${location.pattern} does not proxy`);
  return match[1] ?? "";
}

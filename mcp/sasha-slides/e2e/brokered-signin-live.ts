#!/usr/bin/env npx tsx
/**
 * The brokered per-user sign-in, end to end against real Google.
 *
 * This is the path a remote Claude takes: it discovers the authorization server, registers
 * itself, sends the user to consent, exchanges the resulting code for a bearer token, and
 * calls a tool AS THAT USER. Nothing here uses `.auth/tokens.json` -- that is one developer's
 * personal grant and must never be on this path.
 *
 * Run the server first:
 *   npx tsx mcp/sasha-slides/server.ts --http --public-url http://127.0.0.1:7777 --port 7777
 * then:
 *   npx tsx mcp/sasha-slides/e2e/brokered-signin-live.ts
 *
 * Two things this encodes, both learned the hard way:
 *
 *  1. A PUBLIC client must send `client_id` on the token request (RFC 6749 section 3.2.1).
 *     Omitting it earned `invalid_grant: the code was issued to another client` -- the server
 *     was right and the test was wrong. So ONE client is registered here and its id is carried
 *     through every later step rather than re-registered.
 *  2. Google accepts a loopback redirect on an unregistered PORT for a desktop client, which
 *     is why `http://127.0.0.1:7777/oauth/google/callback` works with no Cloud console.
 */
import CDPraw from "chrome-remote-interface";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";
import { evaluateText, realClick, bringToFront } from "./cdp-page.ts";

// chrome-remote-interface ships no type declarations; CdpModule is the repo's boundary type.
const CDP = CDPraw as CdpModule;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const BASE = option("--base") ?? "http://127.0.0.1:7777";
const CLIENT_PORT = Number(option("--client-port") ?? 60123);
const BROWSER_PORT = Number(option("--browser-port") ?? 9223);
const EMAIL = option("--email") ?? "ante.materija@gmail.com";

type Point = Readonly<{ x: number; y: number; label: string }>;

const base64url = (input: Buffer): string =>
  input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 7636: challenge = BASE64URL(SHA256(ASCII(verifier))). */
function pkcePair(): Readonly<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}



const FIND = (patterns: readonly string[]): string => `((pats) => {
  const nodes = document.querySelectorAll('li,button,[role=button],[role=link],a,input[type=submit],div[data-identifier],span');
  for (const p of pats) { const re = new RegExp(p, 'i');
    for (const n of nodes) {
      const s = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
      if (!s || s.length > 120 || !re.test(s)) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) continue;
      return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), label: s.replace(/\\s+/g,' ').slice(0,50) });
    } }
  return null;
})(${JSON.stringify(patterns)})`;

async function findHit(c: CdpClient, patterns: readonly string[]): Promise<Point | null> {
  const raw = await evaluateText(c, FIND(patterns));
  return raw.startsWith("{") ? (JSON.parse(raw) as Point) : null;
}

/** The loopback listener that stands in for Claude's own redirect endpoint. */
function clientListener(): Readonly<{ server: Server; code: Promise<string> }> {
  let deliver: (value: string) => void = () => {};
  const code = new Promise<string>((resolve) => { deliver = resolve; });
  const server = createServer((req, res) => {
    const asked = new URL(req.url ?? "/", `http://127.0.0.1:${CLIENT_PORT}`);
    const got = asked.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(got === null ? "no code in callback" : "signed in; you can close this");
    if (got !== null) deliver(got);
  });
  return { server, code };
}

async function main(): Promise<void> {
  const redirectUri = `http://127.0.0.1:${CLIENT_PORT}/callback`;
  const { verifier, challenge } = pkcePair();

  // 1. register ONE client and keep its identity for every later step
  const registered = (await (
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "brokered-signin-live", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
    })
  ).json()) as Record<string, unknown>;
  const clientId = registered["client_id"];
  if (typeof clientId !== "string") { console.error("FAIL  registration returned no client_id"); process.exitCode = 1; return; }
  console.log(`ok    registered client ${clientId.slice(0, 18)}...`);

  const { server, code: pendingCode } = clientListener();
  await new Promise<void>((r) => server.listen(CLIENT_PORT, "127.0.0.1", r));

  // 2. /authorize -> Google
  const authorize = `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=live&scope=${encodeURIComponent("openid email")}`;
  const bounced = await fetch(authorize, { redirect: "manual" });
  const toGoogle = bounced.headers.get("location");
  if (bounced.status !== 302 || toGoogle === null) { console.error(`FAIL  /authorize returned ${bounced.status}`); server.close(); process.exitCode = 1; return; }
  console.log(`ok    /authorize redirects to ${new URL(toGoogle).host}`);

  // 3. consent in the signed-in browser
  const tab = await CDP.New({ port: BROWSER_PORT });
  const c: CdpClient = await CDP({ port: BROWSER_PORT, target: tab.id });
  await c.Page.enable(); await c.Runtime.enable();
  await c.Page.navigate({ url: toGoogle });
  await bringToFront(c, tab.id);

  for (let step = 0; step < 14; step++) {
    await new Promise((r) => setTimeout(r, 1500));
    const raw = await evaluateText(c, `JSON.stringify({ url: location.href, text: (document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,200) })`);
    if (raw === "CLOSED" || !raw.startsWith("{")) continue;
    const state = JSON.parse(raw) as { url: string; text: string };
    if (state.url.includes(`127.0.0.1:${CLIENT_PORT}`)) { console.log("ok    Google returned the user to the client"); break; }
    if (/hasn.t verified|not been verified/i.test(state.text)) {
      const advanced = await findHit(c, ["^advanced$"]);
      if (advanced !== null) { await realClick(c, advanced); await new Promise((r) => setTimeout(r, 800)); }
      const proceed = await findHit(c, ["^go to .*unsafe", "^go to "]);
      if (proceed !== null) { await realClick(c, proceed); continue; }
    }
    const hit = await findHit(c, ["^(continue|allow|accept)$", EMAIL.replace(/\./g, "\\."), "^next$"]);
    if (hit !== null) await realClick(c, hit);
  }

  const code = await Promise.race([
    pendingCode,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("no authorization code within 30s")), 30000)),
  ]).catch((cause: unknown) => { console.error(`FAIL  ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
  await c.close();
  server.close();
  if (code === null) { process.exitCode = 1; return; }
  console.log(`ok    our broker issued an authorization code (${code.slice(0, 10)}...)`);

  // 4. exchange it -- WITH client_id, because this is a public client
  const tokenReply = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: redirectUri,
      code_verifier: verifier, client_id: clientId,
    }),
  });
  const token = (await tokenReply.json()) as Record<string, unknown>;
  const access = token["access_token"];
  if (typeof access !== "string") {
    console.error(`FAIL  /token ${tokenReply.status}: ${JSON.stringify(token).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    bearer token issued (${access.slice(0, 10)}...)`);

  // 5. use it on the protected endpoint
  const called = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${access}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await called.text();
  const names = [...new Set([...body.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  if (called.status !== 200 || names.length === 0) {
    console.error(`FAIL  authenticated tools/list -> ${called.status}: ${body.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok    authenticated as the signed-in user; tools: ${names.join(", ")}`);
  console.log("\nPASS  brokered per-user sign-in works end to end");
}
void main();

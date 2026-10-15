/**
 * TEST ONLY: fake Google endpoints behind one `fetch`, a signing key Google "publishes", and a
 * real HTTP server around the interchange, so the route tests speak HTTP to the handler exactly as
 * the collaboration server's router will, and the handler speaks HTTP (through `fetch`) to a Google
 * that answers from tables.
 *
 * The router's own authentication is stood in for by one header: `x-test-account` names the
 * signed-in account (the router passes its caller; a missing header is a caller of null, as for
 * the add-on and capability paths).
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DeckId } from "../engine/src/contracts/ids.ts";
import type { DeckCaller, GoogleGrantStore, GoogleIdentityAccounts, GoogleSlidesInterchange } from "../deck-contracts/deck-service-contract.ts";
import type { GoogleIdentity } from "../http/oauth-store";
import { GOOGLE_KEYS_ADDRESS } from "./identity-token.ts";
import { GOOGLE_TOKEN_ENDPOINT } from "./google-oauth.ts";
import { SLIDES_API_ORIGIN } from "./slides-client.ts";
import { testCaller } from "./testing-deck-service.ts";

export const TEST_KEY_ID = "test-key-1";
export const TEST_CLIENT = { clientId: "982862611156-test.apps.googleusercontent.com", clientSecret: "secret" } as const;
export const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452000000100000000808060000001f15c489", "hex");

export type SigningKeys = Readonly<{ privateKey: KeyObject; otherPrivateKey: KeyObject; jwk: Readonly<Record<string, unknown>> }>;

export function createSigningKeys(): SigningKeys {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = pair.publicKey.export({ format: "jwk" });
  return { privateKey: pair.privateKey, otherPrivateKey: other.privateKey, jwk: { ...exported, kid: TEST_KEY_ID, alg: "RS256", use: "sig" } };
}

/** An RS256 JSON web token; `signWith` lets a row sign with a key Google never published. */
export function signedToken(options: Readonly<{ claims: Readonly<Record<string, unknown>>; key: KeyObject }>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: TEST_KEY_ID, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(options.claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), options.key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export type FakeGoogle = Readonly<{
  fetch: typeof fetch;
  /** Every batchUpdate body Google received, in order. */
  batches: { presentationId: string; requests: unknown[] }[];
  /** A batch containing `createSlide` of this page id is refused with HTTP 400. */
  refuseSlide: { pageId: string | null };
  /** What the token endpoint answers to a code exchange. */
  tokenAnswer: { body: Readonly<Record<string, unknown>> };
  presentations: Map<string, unknown>;
}>;

export function createFakeGoogle(options: Readonly<{ keys: SigningKeys; presentation: unknown }>): FakeGoogle {
  const batches: { presentationId: string; requests: unknown[] }[] = [];
  const refuseSlide: { pageId: string | null } = { pageId: null };
  const tokenAnswer: { body: Readonly<Record<string, unknown>> } = { body: {} };
  const presentations = new Map<string, unknown>();
  const presentationId = stringOf(options.presentation, "presentationId");
  presentations.set(presentationId, options.presentation);
  const answerWith = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fakeFetch: typeof fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (address === GOOGLE_KEYS_ADDRESS) return answerWith({ keys: [options.keys.jwk] });
    if (address === GOOGLE_TOKEN_ENDPOINT) return answerWith(tokenAnswer.body);
    if (address.startsWith("https://fixture.invalid/")) return new Response(PNG_BYTES, { status: 200 });
    if (!address.startsWith(SLIDES_API_ORIGIN)) return new Response("not faked", { status: 599 });
    const path = new URL(address).pathname;
    if (path === "/v1/presentations" && method === "POST") {
      const id = `created_${presentations.size}_presentation_id_000`;
      presentations.set(id, { presentationId: id, slides: [{ objectId: "p" }] });
      return answerWith({ presentationId: id, slides: [{ objectId: "p" }] });
    }
    const batch = /^\/v1\/presentations\/([^/:]+):batchUpdate$/.exec(path);
    if (batch?.[1] !== undefined && method === "POST") {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      const requests = arrayOf(body, "requests");
      if (refuseSlide.pageId !== null && requests.some((request) => JSON.stringify(request).includes(`"createSlide":{"objectId":"${refuseSlide.pageId}"`))) {
        return answerWith({ error: { code: 400, message: "Invalid requests[7].createShape: the shape is out of this world", status: "INVALID_ARGUMENT" } }, 400);
      }
      batches.push({ presentationId: batch[1], requests });
      return answerWith({ presentationId: batch[1], replies: requests.map(() => ({})) });
    }
    const get = /^\/v1\/presentations\/([^/:]+)$/.exec(path);
    if (get?.[1] !== undefined && method === "GET") {
      const known = presentations.get(decodeURIComponent(get[1]));
      return known === undefined ? answerWith({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404) : answerWith(known);
    }
    return new Response("not faked", { status: 599 });
  };
  return { fetch: fakeFetch, batches, refuseSlide, tokenAnswer, presentations };
}

/** Grants by account, with every `save` recorded. */
export function createFakeGrantStore(): GoogleGrantStore & Readonly<{ grants: Map<string, GoogleIdentity>; saved: { accountId: string; identity: GoogleIdentity }[] }> {
  const grants = new Map<string, GoogleIdentity>();
  const saved: { accountId: string; identity: GoogleIdentity }[] = [];
  return {
    grants,
    saved,
    forAccount: async ({ accountId }) => {
      const identity = grants.get(accountId);
      return identity === undefined ? { kind: "notConnected", googleSubject: null } : { kind: "ok", identity };
    },
    save: async ({ accountId, identity }) => {
      saved.push({ accountId, identity });
      grants.set(accountId, identity);
      return "saved";
    },
  };
}

export function connectedIdentity(options: Readonly<{ now: number }>): GoogleIdentity {
  return {
    subject: "google-subject-1",
    email: "person@example.com",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    accessTokenExpiresAtMs: options.now + 3_600_000,
    grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/presentations", "https://www.googleapis.com/auth/drive.file"],
  };
}

/** Accounts by Google subject: the subject is the account id, so two subjects are two accounts. */
export function createFakeAccounts(): GoogleIdentityAccounts {
  return { accountForGoogleIdentity: async ({ subject }): Promise<DeckCaller> => testCaller(subject) };
}

export type InterchangeServer = AsyncDisposable &
  Readonly<{
    origin: string;
    call(options: Readonly<{ method: string; path: string; account?: string; body?: unknown; headers?: Readonly<Record<string, string>> }>): Promise<Response>;
  }>;

/** A real HTTP server whose every request goes to the interchange (the router's delegation). */
export async function serveInterchange(interchange: GoogleSlidesInterchange): Promise<InterchangeServer> {
  const server: Server = createServer((request, response) => {
    const account = request.headers["x-test-account"];
    const caller = typeof account === "string" ? testCaller(account) : null;
    const url = new URL(request.url ?? "/", "http://localhost");
    interchange
      .handleRequest({ request, response, url, caller })
      .then((answered) => {
        if (!answered) {
          response.writeHead(418, { "content-type": "text/plain" });
          response.end("not answered by the Google Slides module");
        }
      })
      .catch((cause: unknown) => {
        response.writeHead(500);
        response.end(String(cause));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A listening TCP server's address is an AddressInfo (node:net), never a pipe path here.
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    call: ({ method, path, account, body, headers }) =>
      fetch(`${origin}${path}`, {
        method,
        redirect: "manual",
        headers: { ...(account === undefined ? {} : { "x-test-account": account }), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(headers ?? {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function asDeckId(text: string): DeckId {
  // Test decks are minted by the test deck service in the `dk_` shape (ids.ts parseDeckId).
  return text as DeckId;
}

function stringOf(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || !(key in value)) return "";
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : "";
}

function arrayOf(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null || !(key in value)) return [];
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return Array.isArray(field) ? field : [];
}

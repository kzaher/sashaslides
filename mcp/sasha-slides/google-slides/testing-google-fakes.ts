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
import { GOOGLE_TOKEN_ENDPOINT } from "../google-constants.ts";
import { DRIVE_API_ORIGIN, SLIDES_API_ORIGIN } from "./slides-client.ts";
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
  /** A batch whose JSON contains `text` is refused with `status` (null: none is). */
  refuseBatch: { text: string | null; status: number };
  drive: FakeDrive;
  thumbnails: FakeThumbnails;
}>;

/** My Drive behind the Drive REST paths drive-files.ts calls. */
export type FakeDrive = {
  readonly files: Map<string, FakeDriveFile>;
  /** Every call, in order: `upload <name>`, `update <id>`, `share <id>`, `delete <id>`, `find <parent>/<name>`, `folder <parent>/<name>`. */
  readonly calls: string[];
  readonly permissions: { fileId: string; body: unknown }[];
  /** Every file created by upload, kept after a delete: `{ id, name, mimeType, parents, bytes }`. */
  readonly uploaded: FakeDriveFile[];
  /** The next call of this operation answers `status` (then it is cleared). */
  failNext: { operation: "upload" | "update" | "share" | "delete" | "find" | "folder" | null; status: number };
};

export type FakeDriveFile = { readonly id: string; name: string; mimeType: string; readonly parents: readonly string[]; bytes: Buffer };

export type FakeThumbnails = {
  /** Page ids asked for, in order. */
  readonly calls: string[];
  /** Statuses to answer before the next successful thumbnail (a 429 then 200, say). */
  readonly statuses: number[];
};

/** The bytes the fake thumbnail address of `pageObjectId` serves: a PNG signature, then the id. */
export function thumbnailBytesOf(pageObjectId: string): Buffer {
  return Buffer.concat([PNG_BYTES, Buffer.from(pageObjectId, "utf8")]);
}

export function createFakeGoogle(options: Readonly<{ keys: SigningKeys; presentation: unknown }>): FakeGoogle {
  const batches: { presentationId: string; requests: unknown[] }[] = [];
  const refuseSlide: { pageId: string | null } = { pageId: null };
  const tokenAnswer: { body: Readonly<Record<string, unknown>> } = { body: {} };
  const presentations = new Map<string, unknown>();
  const refuseBatch: { text: string | null; status: number } = { text: null, status: 400 };
  const drive: FakeDrive = { files: new Map(), calls: [], permissions: [], uploaded: [], failNext: { operation: null, status: 500 } };
  const thumbnails: FakeThumbnails = { calls: [], statuses: [] };
  const presentationId = stringOf(options.presentation, "presentationId");
  presentations.set(presentationId, options.presentation);
  const answerWith = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fakeFetch: typeof fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (address === GOOGLE_KEYS_ADDRESS) return answerWith({ keys: [options.keys.jwk] });
    if (address === GOOGLE_TOKEN_ENDPOINT) return answerWith(tokenAnswer.body);
    if (address.startsWith("https://fixture.invalid/")) return new Response(PNG_BYTES, { status: 200 });
    if (address.startsWith(THUMBNAIL_ADDRESS_PREFIX)) return new Response(thumbnailBytesOf(decodeURIComponent(address.slice(THUMBNAIL_ADDRESS_PREFIX.length).replace(/\.png$/, ""))), { status: 200 });
    if (address.startsWith(`${DRIVE_API_ORIGIN}/drive/v3/`) || address.startsWith(`${DRIVE_API_ORIGIN}/upload/drive/v3/`)) return answerDrive({ drive, address, method, init, answerWith });
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
      if (refuseBatch.text !== null && JSON.stringify(requests).includes(refuseBatch.text)) {
        return answerWith({ error: { code: refuseBatch.status, message: `refused with ${refuseBatch.status}`, status: "REFUSED" } }, refuseBatch.status);
      }
      batches.push({ presentationId: batch[1], requests });
      return answerWith({ presentationId: batch[1], replies: requests.map(() => ({})) });
    }
    const thumbnail = /^\/v1\/presentations\/([^/:]+)\/pages\/([^/]+)\/thumbnail$/.exec(path);
    if (thumbnail?.[2] !== undefined && method === "GET") {
      const pageObjectId = decodeURIComponent(thumbnail[2]);
      thumbnails.calls.push(pageObjectId);
      const status = thumbnails.statuses.shift();
      if (status !== undefined && status !== 200) return answerWith({ error: { code: status, message: `thumbnail refused with ${status}`, status: "REFUSED" } }, status);
      return answerWith({ contentUrl: `${THUMBNAIL_ADDRESS_PREFIX}${encodeURIComponent(pageObjectId)}.png`, width: 1600, height: 900 });
    }
    const get = /^\/v1\/presentations\/([^/:]+)$/.exec(path);
    if (get?.[1] !== undefined && method === "GET") {
      const known = presentations.get(decodeURIComponent(get[1]));
      return known === undefined ? answerWith({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404) : answerWith(known);
    }
    return new Response("not faked", { status: 599 });
  };
  return { fetch: fakeFetch, batches, refuseSlide, tokenAnswer, presentations, refuseBatch, drive, thumbnails };
}

const THUMBNAIL_ADDRESS_PREFIX = "https://thumbnails.fake.invalid/";
const FOLDER_MEDIA_TYPE = "application/vnd.google-apps.folder";

function answerDrive(
  options: Readonly<{ drive: FakeDrive; address: string; method: string; init: RequestInit | undefined; answerWith: (body: unknown, status?: number) => Response }>,
): Response {
  const { drive, method, answerWith } = options;
  const url = new URL(options.address);
  const failing = (operation: NonNullable<FakeDrive["failNext"]["operation"]>): Response | null => {
    if (drive.failNext.operation !== operation) return null;
    drive.failNext.operation = null;
    return answerWith({ error: { code: drive.failNext.status, message: `${operation} refused with ${drive.failNext.status}` } }, drive.failNext.status);
  };
  // Unique for the fake's lifetime: every id-making call is in `calls` before its id is made.
  const newId = (): string => `drivefile${drive.calls.length.toString().padStart(6, "0")}xyz`;
  const body = bodyBytesOf(options.init);
  if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
    const upload = multipartOf({ body, contentType: headerOf(options.init, "content-type") });
    const name = stringOf(upload.metadata, "name");
    drive.calls.push(`upload ${name}`);
    const refused = failing("upload");
    if (refused !== null) return refused;
    const id = newId();
    const parents = arrayOf(upload.metadata, "parents").filter((parent): parent is string => typeof parent === "string");
    const file: FakeDriveFile = { id, name, mimeType: stringOf(upload.metadata, "mimeType"), parents: parents.length === 0 ? ["root"] : parents, bytes: upload.content };
    drive.files.set(id, file);
    drive.uploaded.push({ ...file });
    return answerWith({ id });
  }
  const update = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (update?.[1] !== undefined && method === "PATCH") {
    const id = decodeURIComponent(update[1]);
    drive.calls.push(`update ${id}`);
    const refused = failing("update");
    if (refused !== null) return refused;
    const file = drive.files.get(id);
    if (file === undefined) return answerWith({ error: { code: 404, message: "File not found" } }, 404);
    file.bytes = body;
    return answerWith({ id });
  }
  const permission = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(url.pathname);
  if (permission?.[1] !== undefined && method === "POST") {
    const fileId = decodeURIComponent(permission[1]);
    drive.calls.push(`share ${fileId}`);
    const refused = failing("share");
    if (refused !== null) return refused;
    drive.permissions.push({ fileId, body: JSON.parse(body.toString("utf8")) });
    return answerWith({ id: "anyoneWithLink" });
  }
  const single = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (single?.[1] !== undefined && method === "DELETE") {
    const fileId = decodeURIComponent(single[1]);
    drive.calls.push(`delete ${fileId}`);
    const refused = failing("delete");
    if (refused !== null) return refused;
    drive.files.delete(fileId);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const match = /^name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and trashed = false and mimeType (=|!=) '([^']+)'$/.exec(query);
    if (match === null) return answerWith({ error: { code: 400, message: `unexpected query ${query}` } }, 400);
    const unescape = (text: string): string => text.replace(/\\(.)/g, "$1");
    const name = unescape(match[1] ?? "");
    const parent = unescape(match[2] ?? "");
    const wantsFolder = match[3] === "=";
    drive.calls.push(`find ${parent}/${name}`);
    const refused = failing("find");
    if (refused !== null) return refused;
    const files = [...drive.files.values()].filter((file) => file.name === name && file.parents.includes(parent) && (file.mimeType === FOLDER_MEDIA_TYPE) === wantsFolder);
    return answerWith({ files: files.map((file) => ({ id: file.id })) });
  }
  if (url.pathname === "/drive/v3/files" && method === "POST") {
    const metadata: unknown = JSON.parse(body.toString("utf8"));
    const name = stringOf(metadata, "name");
    const parents = arrayOf(metadata, "parents").filter((parent): parent is string => typeof parent === "string");
    drive.calls.push(`folder ${parents[0] ?? "root"}/${name}`);
    const refused = failing("folder");
    if (refused !== null) return refused;
    const id = newId();
    drive.files.set(id, { id, name, mimeType: stringOf(metadata, "mimeType"), parents, bytes: Buffer.alloc(0) });
    return answerWith({ id });
  }
  return new Response("not faked", { status: 599 });
}

function bodyBytesOf(init: RequestInit | undefined): Buffer {
  const body = init?.body;
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error("the fake Drive reads string and byte bodies only");
}

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) return new Headers(headers).get(name) ?? "";
  const value: unknown = Object.getOwnPropertyDescriptor(headers, name)?.value;
  return typeof value === "string" ? value : "";
}

/** The two parts of a `multipart/related` upload: the JSON metadata, then the content. */
function multipartOf(options: Readonly<{ body: Buffer; contentType: string }>): Readonly<{ metadata: unknown; content: Buffer }> {
  const boundary = /boundary=([^;]+)/.exec(options.contentType)?.[1];
  if (boundary === undefined) throw new Error("a multipart upload without a boundary");
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const partOf = (start: number): Readonly<{ bytes: Buffer; end: number }> => {
    const headersEnd = options.body.indexOf("\r\n\r\n", start);
    const next = options.body.indexOf(delimiter, headersEnd);
    return { bytes: options.body.subarray(headersEnd + 4, next - 2), end: next };
  };
  const first = partOf(options.body.indexOf(delimiter) + delimiter.byteLength);
  const second = partOf(first.end + delimiter.byteLength);
  return { metadata: JSON.parse(first.bytes.toString("utf8")), content: Buffer.from(second.bytes) };
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

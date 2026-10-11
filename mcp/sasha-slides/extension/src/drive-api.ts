// The two Google REST surfaces the extension needs, as INTERFACES first and an HTTP
// implementation second. Everything above this file depends on the interface, so the observer and
// the PICK writer are exercised in unit tests against a fake Drive with no network (see
// observer.test.ts / pick-writer.test.ts) rather than by patching globals.
//
// Why these calls run in an extension context and never in the content script: a content script's
// fetch carries the PAGE's origin (docs.google.com) and the user's cookies, and `Origin` is a
// forbidden request-header name, so it cannot be corrected -- `Headers.append()` is a silent no-op
// for `Origin`/`Host`/`Referer`/`Cookie` even from an extension. In an extension page the request
// is made with the extension's own origin and `host_permissions` exempts it from CORS, which is the
// only combination that reliably authorizes with a bearer token.

import type { Parsed } from "./protocol.ts";

export type DriveFileRef = Readonly<{
  id: string;
  name: string;
  createdTime: string;
  /** Drive's folder ids. The proposal folder is `parents[0]` of its own `READY` marker. */
  parents: readonly string[];
  /** Every protocol file is tagged; `sashaSlides` is its role and `proposalId` is its proposal. */
  appProperties: Readonly<Record<string, string>>;
}>;

/** An outcome, not an exception: `unauthorized` is the one failure the caller must act on. */
export type HttpOutcome<TValue> =
  | Readonly<{ kind: "ok"; value: TValue }>
  | Readonly<{ kind: "unauthorized"; message: string }>
  | Readonly<{ kind: "failed"; status: number | null; message: string }>;

export type DriveApi = Readonly<{
  /**
   * Every protocol file carries `appProperties.sashaSlides`, so one narrow query finds whole roles.
   * Several roles go in ONE request because the observer always needs `ready` and `pick` together:
   * a proposal that already has a PICK has been answered and must not be offered again.
   */
  listByRoles(spec: Readonly<{ roles: readonly string[]; pageSize: number }>): Promise<HttpOutcome<readonly DriveFileRef[]>>;
  downloadText(fileId: string): Promise<HttpOutcome<string>>;
  createTextFile(
    spec: Readonly<{
      name: string;
      parentFolderId: string;
      mimeType: string;
      body: string;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<HttpOutcome<DriveFileRef>>;
  /** For `<proposalId>/render/NN.png`. Bytes, not text, so the PNG is not corrupted by encoding. */
  createBinaryFile(
    spec: Readonly<{
      name: string;
      parentFolderId: string;
      mimeType: string;
      bytes: Blob;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<HttpOutcome<DriveFileRef>>;
  /** Finds or creates the `render` subfolder. Idempotent: a second call returns the first folder. */
  ensureChildFolder(
    spec: Readonly<{
      parentFolderId: string;
      name: string;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<HttpOutcome<DriveFileRef>>;
}>;

export type SlidesApi = Readonly<{
  /** Returns the object ids the batch actually created, for `PICK.insertedObjectIds`. */
  batchUpdate(
    spec: Readonly<{ presentationId: string; requests: readonly object[] }>,
  ): Promise<HttpOutcome<readonly string[]>>;
  /**
   * A short-lived URL to Google's own PNG of a page. This is the ONLY way to obtain a true
   * rasterisation of a converted slide, and it is why `render/NN.png` can only be written for a
   * slide that has actually been inserted.
   */
  pageThumbnailPng(
    spec: Readonly<{ presentationId: string; pageObjectId: string }>,
  ): Promise<HttpOutcome<Blob>>;
}>;

/** A bearer token, however it was obtained. See google-identity.ts for the only implementation. */
export type AccessTokenSource = Readonly<{
  token(spec: Readonly<{ interactive: boolean; forceRefresh: boolean }>): Promise<Parsed<string>>;
}>;

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SLIDES_PRESENTATIONS = "https://slides.googleapis.com/v1/presentations";
const FILE_FIELDS = "id,name,createdTime,parents,appProperties";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export function httpDriveApi({ tokens }: { tokens: AccessTokenSource }): DriveApi {
  return {
    async listByRoles({ roles, pageSize }) {
      // `appProperties has {...}` is Drive's only indexed way to ask "files MY app tagged this way",
      // and it is the query the protocol's appProperties were designed for.
      const query = `(${roles
        .map((role) => `appProperties has { key='sashaSlides' and value='${role}' }`)
        .join(" or ")}) and trashed = false`;
      const url = `${DRIVE_FILES}?${new URLSearchParams({
        q: query,
        spaces: "drive",
        orderBy: "createdTime",
        pageSize: String(pageSize),
        fields: `files(${FILE_FIELDS})`,
      }).toString()}`;
      const outcome = await authorizedJson({ tokens, url, init: { method: "GET" } });
      if (outcome.kind !== "ok") return outcome;
      return { kind: "ok", value: fileRefsOf(outcome.value) };
    },

    async downloadText(fileId) {
      const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`;
      return authorizedText({ tokens, url, init: { method: "GET" } });
    },

    createTextFile({ name, parentFolderId, mimeType, body, appProperties }) {
      return upload({ tokens, name, parentFolderId, mimeType, bytes: new Blob([body], { type: mimeType }), appProperties });
    },

    createBinaryFile({ name, parentFolderId, mimeType, bytes, appProperties }) {
      return upload({ tokens, name, parentFolderId, mimeType, bytes, appProperties });
    },

    async ensureChildFolder({ parentFolderId, name, appProperties }) {
      const query =
        `'${parentFolderId}' in parents and name = '${name}' and ` +
        `mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`;
      const listUrl = `${DRIVE_FILES}?${new URLSearchParams({
        q: query,
        spaces: "drive",
        pageSize: "1",
        fields: `files(${FILE_FIELDS})`,
      }).toString()}`;
      const listed = await authorizedJson({ tokens, url: listUrl, init: { method: "GET" } });
      if (listed.kind !== "ok") return listed;
      const existing = fileRefsOf(listed.value)[0];
      if (existing !== undefined) return { kind: "ok", value: existing };

      const createUrl = `${DRIVE_FILES}?${new URLSearchParams({ fields: FILE_FIELDS }).toString()}`;
      const created = await authorizedJson({
        tokens,
        url: createUrl,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, parents: [parentFolderId], mimeType: FOLDER_MIME_TYPE, appProperties }),
        },
      });
      if (created.kind !== "ok") return created;
      return oneFile({ payload: created.value, what: "folder" });
    },
  };
}

export function httpSlidesApi({ tokens }: { tokens: AccessTokenSource }): SlidesApi {
  return {
    async batchUpdate({ presentationId, requests }) {
      const url = `${SLIDES_PRESENTATIONS}/${encodeURIComponent(presentationId)}:batchUpdate`;
      const outcome = await authorizedJson({
        tokens,
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests }),
        },
      });
      if (outcome.kind !== "ok") return outcome;
      return { kind: "ok", value: createdObjectIdsOf(outcome.value) };
    },

    async pageThumbnailPng({ presentationId, pageObjectId }) {
      const url =
        `${SLIDES_PRESENTATIONS}/${encodeURIComponent(presentationId)}` +
        `/pages/${encodeURIComponent(pageObjectId)}/thumbnail?` +
        new URLSearchParams({
          "thumbnailProperties.mimeType": "PNG",
          "thumbnailProperties.thumbnailSize": "LARGE",
        }).toString();
      const described = await authorizedJson({ tokens, url, init: { method: "GET" } });
      if (described.kind !== "ok") return described;
      const contentUrl = asRecord(described.value)?.["contentUrl"];
      if (typeof contentUrl !== "string") {
        return { kind: "failed", status: null, message: "thumbnail reply carried no contentUrl" };
      }
      // The contentUrl is a short-lived, unauthenticated googleusercontent.com link, which is why
      // that host is in `host_permissions` and why no Authorization header is attached here.
      try {
        const response = await fetch(contentUrl, { credentials: "omit" });
        if (!response.ok) {
          return { kind: "failed", status: response.status, message: "thumbnail download failed" };
        }
        return { kind: "ok", value: await response.blob() };
      } catch (cause) {
        return { kind: "failed", status: null, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}

async function upload({
  tokens,
  name,
  parentFolderId,
  mimeType,
  bytes,
  appProperties,
}: {
  tokens: AccessTokenSource;
  name: string;
  parentFolderId: string;
  mimeType: string;
  bytes: Blob;
  appProperties: Readonly<Record<string, string>>;
}): Promise<HttpOutcome<DriveFileRef>> {
  const metadata = { name, parents: [parentFolderId], mimeType, appProperties };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", bytes);
  const url = `${DRIVE_UPLOAD}?${new URLSearchParams({
    uploadType: "multipart",
    fields: FILE_FIELDS,
  }).toString()}`;
  // No Content-Type header: FormData makes fetch set multipart/related's boundary itself, and a
  // hand-written boundary that disagrees with the body is the classic 400 here.
  const outcome = await authorizedJson({ tokens, url, init: { method: "POST", body: form } });
  if (outcome.kind !== "ok") return outcome;
  return oneFile({ payload: outcome.value, what: "upload" });
}

function oneFile({ payload, what }: { payload: unknown; what: string }): HttpOutcome<DriveFileRef> {
  const created = fileRefsOf({ files: [payload] })[0];
  return created === undefined
    ? { kind: "failed", status: null, message: `${what} returned no file id` }
    : { kind: "ok", value: created };
}

/**
 * Every objectId any reply in a batchUpdate response reports as created. Slides names the field
 * `objectId` on createSlide/createShape/createTable/createImage replies alike, so one sweep covers
 * whatever requests the converter emitted without this file knowing the converter's repertoire.
 */
export function createdObjectIdsOf(response: unknown): readonly string[] {
  const replies = asRecord(response)?.["replies"];
  if (!Array.isArray(replies)) return [];
  const ids: string[] = [];
  for (const reply of replies) {
    const record = asRecord(reply);
    if (record === null) continue;
    for (const value of Object.values(record)) {
      const objectId = asRecord(value)?.["objectId"];
      if (typeof objectId === "string" && objectId !== "") ids.push(objectId);
    }
  }
  return ids;
}

/**
 * One 401 retry with a forced refresh, then give up. A second 401 means the grant itself is gone
 * (revoked, or the wrong OAuth client), which no amount of retrying fixes and which the observer
 * must surface to the user instead of hiding in a backoff loop.
 */
async function authorizedText({
  tokens,
  url,
  init,
}: {
  tokens: AccessTokenSource;
  url: string;
  init: RequestInit;
}): Promise<HttpOutcome<string>> {
  const first = await attempt({ tokens, url, init, forceRefresh: false });
  if (first.kind !== "unauthorized") return first;
  return attempt({ tokens, url, init, forceRefresh: true });
}

async function authorizedJson({
  tokens,
  url,
  init,
}: {
  tokens: AccessTokenSource;
  url: string;
  init: RequestInit;
}): Promise<HttpOutcome<unknown>> {
  const outcome = await authorizedText({ tokens, url, init });
  if (outcome.kind !== "ok") return outcome;
  try {
    return { kind: "ok", value: JSON.parse(outcome.value) as unknown };
  } catch (cause) {
    return { kind: "failed", status: null, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function attempt({
  tokens,
  url,
  init,
  forceRefresh,
}: {
  tokens: AccessTokenSource;
  url: string;
  init: RequestInit;
  forceRefresh: boolean;
}): Promise<HttpOutcome<string>> {
  const token = await tokens.token({ interactive: false, forceRefresh });
  if (token.kind !== "ok") {
    return { kind: "unauthorized", message: token.kind === "invalid" ? token.reason : "unsupported token version" };
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token.value}`);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: "omit" });
  } catch (cause) {
    return { kind: "failed", status: null, message: cause instanceof Error ? cause.message : String(cause) };
  }
  const text = await response.text();
  if (response.status === 401) return { kind: "unauthorized", message: text.slice(0, 400) };
  if (!response.ok) return { kind: "failed", status: response.status, message: text.slice(0, 400) };
  return { kind: "ok", value: text };
}

function fileRefsOf(payload: unknown): readonly DriveFileRef[] {
  const files = asRecord(payload)?.["files"];
  if (!Array.isArray(files)) return [];
  const refs: DriveFileRef[] = [];
  for (const candidate of files) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const id = record["id"];
    if (typeof id !== "string") continue;
    const name = record["name"];
    const createdTime = record["createdTime"];
    const parents = record["parents"];
    refs.push({
      id,
      name: typeof name === "string" ? name : "",
      createdTime: typeof createdTime === "string" ? createdTime : "",
      parents: Array.isArray(parents) ? parents.filter((parent): parent is string => typeof parent === "string") : [],
      appProperties: stringMapOf(record["appProperties"]),
    });
  }
  return refs;
}

function stringMapOf(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  if (record === null) return {};
  const entries: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(record)) {
    if (typeof candidate === "string") entries[key] = candidate;
  }
  return entries;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

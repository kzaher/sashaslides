/**
 * The Google Drive REST calls the developer page's insert route makes with the person's own
 * `drive.file` grant, over the injected `fetch` (the same reason as slides-client.ts: route tests
 * answer from fake endpoints with no module patching).
 *
 * `drive.file` reaches only files THIS OAuth client created or the person opened with it. So a
 * folder the add-on (a different client, Apps Script's own project) created under the same name is
 * invisible here, and a lookup by name creates a second folder of that name beside it. That is
 * Drive's rule, not something this module can work around without the full Drive scope.
 *
 * Every answer is a value: a failed call names its HTTP status and Google's message, and the caller
 * maps the status (slides-client.ts `googleFailureCodeOf`).
 */
import { randomBytes } from "node:crypto";
import { DRIVE_API_ORIGIN } from "./slides-client.ts";

export const DRIVE_FOLDER_MEDIA_TYPE = "application/vnd.google-apps.folder";

export type DriveOutcome<TValue> = Readonly<{ kind: "ok"; value: TValue }> | Readonly<{ kind: "failed"; status: number; message: string }>;

export type DriveClient = Readonly<{
  /** A new file with these bytes; `parentId` null puts it in My Drive's root. */
  uploadFile(options: Readonly<{ name: string; mediaType: string; bytes: Uint8Array; parentId: string | null }>): Promise<DriveOutcome<string>>;
  /** Replaces a file's content and keeps its id (and so every link to it). */
  updateFileContent(options: Readonly<{ fileId: string; mediaType: string; bytes: Uint8Array }>): Promise<DriveOutcome<string>>;
  /** "Anyone with the link" may read it: what makes a staged picture fetchable by `createImage`. */
  shareWithAnyoneReader(options: Readonly<{ fileId: string }>): Promise<DriveOutcome<null>>;
  /** A permanent delete, not the bin: the staged copy must stop existing now (slide-image.ts). */
  deleteFile(options: Readonly<{ fileId: string }>): Promise<DriveOutcome<null>>;
  /** The id of a child of `parentId` (`root` for My Drive) with exactly this name, or null. */
  findChild(options: Readonly<{ parentId: string; name: string; folder: boolean }>): Promise<DriveOutcome<string | null>>;
  createFolder(options: Readonly<{ name: string; parentId: string }>): Promise<DriveOutcome<string>>;
}>;

export function createDriveClient(options: Readonly<{ fetch: typeof fetch; accessToken: string }>): DriveClient {
  const call = (request: DriveRequest): Promise<DriveOutcome<unknown>> => callDrive({ fetch: options.fetch, accessToken: options.accessToken, request });
  return {
    uploadFile: async ({ name, mediaType, bytes, parentId }) => {
      const boundary = `sasha${randomBytes(12).toString("hex")}`;
      const metadata = JSON.stringify({ name, mimeType: mediaType, ...(parentId === null ? {} : { parents: [parentId] }) });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${mediaType}\r\n\r\n`, "utf8"),
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        Buffer.from(`\r\n--${boundary}--`, "utf8"),
      ]);
      return idOf(await call({ method: "POST", address: `${DRIVE_API_ORIGIN}/upload/drive/v3/files?uploadType=multipart&fields=id`, contentType: `multipart/related; boundary=${boundary}`, body }));
    },
    updateFileContent: async ({ fileId, mediaType, bytes }) =>
      idOf(await call({ method: "PATCH", address: `${DRIVE_API_ORIGIN}/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`, contentType: mediaType, body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) })),
    shareWithAnyoneReader: async ({ fileId }) =>
      nothingOf(await call({ method: "POST", address: `${DRIVE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=id`, contentType: "application/json", body: Buffer.from(JSON.stringify({ role: "reader", type: "anyone" }), "utf8") })),
    deleteFile: async ({ fileId }) => nothingOf(await call({ method: "DELETE", address: `${DRIVE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}`, contentType: null, body: null })),
    findChild: async ({ parentId, name, folder }) => {
      const query = [`name = '${driveQueryLiteral(name)}'`, `'${driveQueryLiteral(parentId)}' in parents`, "trashed = false", `mimeType ${folder ? "=" : "!="} '${DRIVE_FOLDER_MEDIA_TYPE}'`].join(" and ");
      const listed = await call({ method: "GET", address: `${DRIVE_API_ORIGIN}/drive/v3/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent("files(id)")}&pageSize=10&spaces=drive`, contentType: null, body: null });
      if (listed.kind === "failed") return listed;
      return { kind: "ok", value: firstFileIdOf(listed.value) };
    },
    createFolder: async ({ name, parentId }) =>
      idOf(await call({ method: "POST", address: `${DRIVE_API_ORIGIN}/drive/v3/files?fields=id`, contentType: "application/json", body: Buffer.from(JSON.stringify({ name, mimeType: DRIVE_FOLDER_MEDIA_TYPE, parents: [parentId] }), "utf8") })),
  };
}

/** A string literal inside a Drive `q` expression: backslash and single quote are escaped. */
export function driveQueryLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type DriveRequest = Readonly<{ method: "GET" | "POST" | "PATCH" | "DELETE"; address: string; contentType: string | null; body: Buffer | null }>;

/** Uploads of a few megabytes and folder lookups: past this the call is stuck, not slow. */
const DRIVE_CALL_TIMEOUT_MILLISECONDS = 60_000;

async function callDrive(options: Readonly<{ fetch: typeof fetch; accessToken: string; request: DriveRequest }>): Promise<DriveOutcome<unknown>> {
  const { request } = options;
  let response: Response;
  try {
    response = await options.fetch(request.address, {
      method: request.method,
      headers: { authorization: `Bearer ${options.accessToken}`, ...(request.contentType === null ? {} : { "content-type": request.contentType }) },
      ...(request.body === null ? {} : { body: request.body }),
      signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MILLISECONDS),
    });
  } catch (cause) {
    return { kind: "failed", status: 0, message: cause instanceof Error ? cause.message : String(cause) };
  }
  const text = await response.text();
  const parsed = parseText(text);
  if (!response.ok) return { kind: "failed", status: response.status, message: messageOf({ parsed, text }) };
  return { kind: "ok", value: parsed };
}

function idOf(outcome: DriveOutcome<unknown>): DriveOutcome<string> {
  if (outcome.kind === "failed") return outcome;
  const id = fieldOf(outcome.value, "id");
  return typeof id === "string" && id.length > 0 ? { kind: "ok", value: id } : { kind: "failed", status: 502, message: "Drive answered without a file id." };
}

function nothingOf(outcome: DriveOutcome<unknown>): DriveOutcome<null> {
  return outcome.kind === "failed" ? outcome : { kind: "ok", value: null };
}

function firstFileIdOf(listing: unknown): string | null {
  const files = fieldOf(listing, "files");
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    const id: unknown = fieldOf(file, "id");
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function parseText(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Google's error envelope is `{ error: { message } }`; fall back to the raw text. */
function messageOf(options: Readonly<{ parsed: unknown; text: string }>): string {
  const message = fieldOf(fieldOf(options.parsed, "error"), "message");
  return typeof message === "string" ? message : options.text.slice(0, 400);
}

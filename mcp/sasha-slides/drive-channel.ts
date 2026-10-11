/**
 * The narrow Drive capability the sasha-slides staging protocol needs, plus the real
 * googleapis-backed implementation of it.
 *
 * Everything the protocol does to Drive goes through `DriveChannel`, so the whole of
 * `proposal.ts` is testable against an in-memory fake (`test/fake-drive.ts`) with no
 * credentials and no network. The interface is deliberately small: seven operations, a
 * structured query instead of a Drive query string, and media described as a value so a
 * fake can record *which path* was uploaded without ever reading the bytes.
 *
 * Note what is NOT here: there is no "append to a file". Drive has no append, and the server
 * and the add-on cannot see each other's writes, so an appended log would be a
 * read-modify-write whose loser silently vanishes. The session log is therefore one *created*
 * file per event — `createFile`, never `updateFileContent` — and `updateFileContent` exists
 * only for the two documents with a single writer: a candidate's HTML and `manifest.json`.
 *
 * The bytes matter: slide HTML must never be read into the model's context (PROTOCOL.md
 * "paths in, ids out"), so `DriveMedia` carries a path and the channel streams it.
 */
import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertNever } from "./google-auth";

export type DriveChannel = Readonly<{
  createFolder(
    options: Readonly<{ name: string; parentId: string | null; appProperties: DriveAppProperties }>,
  ): Promise<DriveFile>;

  /** Streams `media` into a new file under `parentId`. Never buffers the body in memory. */
  createFile(
    options: Readonly<{
      name: string;
      parentId: string;
      mimeType: string;
      media: DriveMedia;
      appProperties: DriveAppProperties;
    }>,
  ): Promise<DriveFile>;

  listFiles(options: Readonly<{ query: DriveQuery }>): Promise<readonly DriveFile[]>;

  /**
   * Replaces a file's BODY, keeping its id. That is the whole point: a revised candidate
   * must stay the same Drive file or its comment threads detach from the slide they are
   * about (PROTOCOL.md "A revision replaces the candidate in place").
   */
  updateFileContent(
    options: Readonly<{ fileId: string; mimeType: string; media: DriveMedia }>,
  ): Promise<DriveFile>;

  /** Permanent, not trashed: a cleared candidate must stop being discoverable by name. */
  deleteFile(options: Readonly<{ fileId: string }>): Promise<void>;

  /** For the protocol's small JSON sentinels (manifest.json, READY, PICK) only. */
  readTextFile(options: Readonly<{ fileId: string }>): Promise<string>;

  /** Streams to disk, creating parent directories. Keeps image bytes out of the process. */
  downloadBinaryFile(options: Readonly<{ fileId: string; destinationPath: string }>): Promise<void>;
}>;

export type DriveFile = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  appProperties: DriveAppProperties;
}>;

export type DriveAppProperties = Readonly<Record<string, string>>;

/**
 * A body to upload. `local-file` is streamed from disk and is how slide HTML reaches Drive
 * without being transcribed; `text` is for the few small JSON documents the server writes.
 */
export type DriveMedia =
  | Readonly<{ kind: "local-file"; path: string }>
  | Readonly<{ kind: "text"; text: string }>;

/**
 * A structured query rather than a Drive `q` string: the real channel renders it, and a fake
 * can honour it without implementing Drive's query grammar. Fields are required and nullable
 * so a call site states every dimension it is (and is not) filtering on.
 */
export type DriveQuery = Readonly<{
  name: string | null;
  /**
   * The folder to look inside, or null for "anywhere this app can see".
   *
   * Required because cross-component discovery is by NAME (PROTOCOL.md "Discovery is by
   * NAME, not by appProperties"): the add-on cannot read the server's `appProperties`, so
   * `events/` and `NN.html` are found as named children of a known folder. Without a parent
   * dimension a name query would reach into every proposal at once.
   */
  parentId: string | null;
  sashaSlides: SashaRole | null;
  proposalId: string | null;
  trashed: boolean;
}>;

/** The values PROTOCOL.md defines for the `sashaSlides` appProperty. */
export type SashaRole =
  | "inbox"
  | "proposal"
  | "slide"
  | "manifest"
  | "ready"
  | "pick"
  /** The `events/` folder of one proposal. */
  | "events"
  /** One session-log event file inside it — one file per event, never an appended log. */
  | "event";

export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export function googleDriveChannel(options: Readonly<{ auth: OAuth2Client }>): DriveChannel {
  const drive = google.drive({ version: "v3", auth: options.auth });
  return {
    createFolder: async ({ name, parentId, appProperties }) => {
      const response = await drive.files.create({
        requestBody: {
          name,
          mimeType: FOLDER_MIME_TYPE,
          appProperties: { ...appProperties },
          ...(parentId === null ? {} : { parents: [parentId] }),
        },
        fields: DRIVE_FILE_FIELDS,
      });
      return requireDriveFile({ file: response.data, what: `folder ${name}` });
    },

    createFile: async ({ name, parentId, mimeType, media, appProperties }) => {
      const response = await drive.files.create({
        requestBody: { name, parents: [parentId], mimeType, appProperties: { ...appProperties } },
        media: { mimeType, body: mediaBody(media) },
        fields: DRIVE_FILE_FIELDS,
      });
      return requireDriveFile({ file: response.data, what: `file ${name}` });
    },

    updateFileContent: async ({ fileId, mimeType, media }) => {
      const response = await drive.files.update({
        fileId,
        media: { mimeType, body: mediaBody(media) },
        fields: DRIVE_FILE_FIELDS,
      });
      return requireDriveFile({ file: response.data, what: `updated file ${fileId}` });
    },

    deleteFile: async ({ fileId }) => {
      await drive.files.delete({ fileId });
    },

    listFiles: async ({ query }) => {
      // Annotated so the overloaded `files.list` resolves without inferring `response`
      // from an argument that itself mentions the page token (TS7022).
      const params: drive_v3.Params$Resource$Files$List = {
        q: renderDriveQuery(query),
        spaces: "drive",
        pageSize: LIST_PAGE_SIZE,
        fields: `nextPageToken, files(${DRIVE_FILE_FIELDS})`,
      };
      const collected: DriveFile[] = [];
      let pageToken: string | null = null;
      // Bounded so a surprising number of matches cannot turn one tool call into a long scan.
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listed = await listPage({
          drive,
          params: pageToken === null ? params : { ...params, pageToken },
        });
        collected.push(...listed.files);
        pageToken = listed.nextPageToken;
        if (pageToken === null) break;
      }
      return collected;
    },

    readTextFile: async ({ fileId }) => {
      const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
      // `alt: "media"` returns the file body, not the Schema$File the generated types
      // describe; `responseType: "text"` makes gaxios hand back the raw string. The cast
      // encodes the documented behaviour of Drive's media-download endpoint.
      return response.data as unknown as string;
    },

    downloadBinaryFile: async ({ fileId, destinationPath }) => {
      await mkdir(dirname(destinationPath), { recursive: true });
      const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
      // Same media-download endpoint as above: with `responseType: "stream"` gaxios yields a
      // Node readable of the body rather than parsed file metadata.
      const body = response.data as unknown as Readable;
      await pipeline(body, createWriteStream(destinationPath));
    },
  };
}

const DRIVE_FILE_FIELDS = "id, name, mimeType, appProperties";
const LIST_PAGE_SIZE = 200;
const MAX_LIST_PAGES = 10;

function mediaBody(media: DriveMedia): Readable {
  switch (media.kind) {
    case "local-file":
      return createReadStream(media.path);
    case "text":
      return Readable.from([media.text]);
    default:
      return assertNever(media);
  }
}

/** One page of `files.list`, narrowed. Kept out of the loop so `files.list`'s overloads
 *  resolve against an annotated parameter rather than a loop-carried page token (TS7022). */
async function listPage(
  options: Readonly<{ drive: drive_v3.Drive; params: drive_v3.Params$Resource$Files$List }>,
): Promise<Readonly<{ files: readonly DriveFile[]; nextPageToken: string | null }>> {
  const response = await options.drive.files.list(options.params);
  const files: DriveFile[] = [];
  for (const candidate of response.data.files ?? []) {
    const file = narrowDriveFile(candidate);
    if (file !== null) files.push(file);
  }
  return { files, nextPageToken: response.data.nextPageToken ?? null };
}

function renderDriveQuery(query: DriveQuery): string {
  const clauses: string[] = [`trashed = ${String(query.trashed)}`];
  if (query.name !== null) clauses.push(`name = '${escapeQueryValue(query.name)}'`);
  if (query.parentId !== null) clauses.push(`'${escapeQueryValue(query.parentId)}' in parents`);
  if (query.sashaSlides !== null) clauses.push(appPropertyClause("sashaSlides", query.sashaSlides));
  if (query.proposalId !== null) clauses.push(appPropertyClause("proposalId", query.proposalId));
  return clauses.join(" and ");
}

function appPropertyClause(key: string, value: string): string {
  return `appProperties has { key='${escapeQueryValue(key)}' and value='${escapeQueryValue(value)}' }`;
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function requireDriveFile(options: Readonly<{ file: drive_v3.Schema$File; what: string }>): DriveFile {
  const narrowed = narrowDriveFile(options.file);
  if (narrowed === null) throw new Error(`Drive returned no usable id/name for ${options.what}`);
  return narrowed;
}

/** Drive's generated types make every field optional; this is the parse boundary for them. */
function narrowDriveFile(file: drive_v3.Schema$File): DriveFile | null {
  const id = file.id;
  const name = file.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    id,
    name,
    mimeType: typeof file.mimeType === "string" ? file.mimeType : "application/octet-stream",
    appProperties: { ...(file.appProperties ?? {}) },
  };
}

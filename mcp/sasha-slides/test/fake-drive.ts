/**
 * An in-memory `DriveChannel` plus a call recorder, so the whole staging protocol can be
 * tested with no credentials and no network.
 *
 * Two things it deliberately does NOT do:
 *  - it never reads a `local-file` media body, only records its path. That is the test's
 *    proof that slide HTML never enters the process (let alone the model's context);
 *  - it never reorders or batches operations, so `calls()` is a faithful transcript and the
 *    READY-last invariant can be asserted on ordering rather than on final state.
 */
import {
  type DriveAppProperties,
  type DriveChannel,
  type DriveFile,
  type DriveQuery,
  FOLDER_MIME_TYPE,
} from "../drive-channel";
import { assertNever } from "../google-auth";

export type FakeDrive = Readonly<{
  channel: DriveChannel;
  /** Ordered transcript of every channel operation. */
  calls: () => readonly RecordedCall[];
  files: () => readonly FakeDriveFile[];
  find: (options: Readonly<{ name: string }>) => FakeDriveFile | null;
  /**
   * Simulates another component writing into the proposal folder — in practice the
   * extension writing `PICK`, the one file the server must never write itself.
   */
  putForeignFile: (
    options: Readonly<{
      name: string;
      parentId: string;
      mimeType: string;
      text: string;
      appProperties: DriveAppProperties;
    }>,
  ) => FakeDriveFile;
  downloads: () => readonly Readonly<{ fileId: string; destinationPath: string }>[];
}>;

export type RecordedCall = Readonly<{ op: RecordedOperation; name: string }>;

export type RecordedOperation =
  | "createFolder"
  | "createFile"
  | "updateFileContent"
  | "deleteFile"
  | "listFiles"
  | "readTextFile"
  | "download";

export type FakeDriveFile = DriveFile &
  Readonly<{
    parentId: string | null;
    /** Body of a `text` upload; null for a folder or a streamed local file. */
    text: string | null;
    /** Path of a `local-file` upload, recorded without being opened. */
    sourcePath: string | null;
  }>;

export function createFakeDrive(): FakeDrive {
  const files: FakeDriveFile[] = [];
  const calls: RecordedCall[] = [];
  const downloads: Readonly<{ fileId: string; destinationPath: string }>[] = [];
  let nextId = 1;

  function add(
    file: Omit<FakeDriveFile, "id"> & Readonly<{ appProperties: DriveAppProperties }>,
  ): FakeDriveFile {
    const stored: FakeDriveFile = { ...file, id: `fake-${String(nextId)}` };
    nextId += 1;
    files.push(stored);
    return stored;
  }

  const channel: DriveChannel = {
    createFolder: ({ name, parentId, appProperties }) => {
      calls.push({ op: "createFolder", name });
      return Promise.resolve(
        add({ name, parentId, mimeType: FOLDER_MIME_TYPE, appProperties, text: null, sourcePath: null }),
      );
    },

    createFile: ({ name, parentId, mimeType, media, appProperties }) => {
      calls.push({ op: "createFile", name });
      switch (media.kind) {
        case "local-file":
          return Promise.resolve(
            add({ name, parentId, mimeType, appProperties, text: null, sourcePath: media.path }),
          );
        case "text":
          return Promise.resolve(
            add({ name, parentId, mimeType, appProperties, text: media.text, sourcePath: null }),
          );
        default:
          return assertNever(media);
      }
    },

    updateFileContent: ({ fileId, mimeType, media }) => {
      const at = files.findIndex((candidate) => candidate.id === fileId);
      const existing = files[at];
      if (existing === undefined) {
        calls.push({ op: "updateFileContent", name: fileId });
        return Promise.reject(new Error(`no such fake file: ${fileId}`));
      }
      calls.push({ op: "updateFileContent", name: existing.name });
      // The id is preserved, exactly as Drive's files.update does: a revised candidate that
      // changed id would detach every comment thread from the slide it is about.
      const replaced: FakeDriveFile = {
        ...existing,
        mimeType,
        text: media.kind === "text" ? media.text : null,
        sourcePath: media.kind === "local-file" ? media.path : null,
      };
      files[at] = replaced;
      return Promise.resolve(replaced);
    },

    deleteFile: ({ fileId }) => {
      const at = files.findIndex((candidate) => candidate.id === fileId);
      const existing = files[at];
      if (existing === undefined) {
        calls.push({ op: "deleteFile", name: fileId });
        return Promise.reject(new Error(`no such fake file: ${fileId}`));
      }
      calls.push({ op: "deleteFile", name: existing.name });
      files.splice(at, 1);
      return Promise.resolve();
    },

    listFiles: ({ query }) => {
      calls.push({ op: "listFiles", name: describeQuery(query) });
      return Promise.resolve(files.filter((file) => matches({ file, query })));
    },

    readTextFile: ({ fileId }) => {
      calls.push({ op: "readTextFile", name: fileId });
      const file = files.find((candidate) => candidate.id === fileId);
      if (file === undefined) return Promise.reject(new Error(`no such fake file: ${fileId}`));
      if (file.text === null) {
        return Promise.reject(new Error(`fake file ${file.name} has no text body (streamed upload)`));
      }
      return Promise.resolve(file.text);
    },

    downloadBinaryFile: ({ fileId, destinationPath }) => {
      calls.push({ op: "download", name: destinationPath });
      downloads.push({ fileId, destinationPath });
      return Promise.resolve();
    },
  };

  return {
    channel,
    calls: () => [...calls],
    files: () => [...files],
    find: ({ name }) => files.find((file) => file.name === name) ?? null,
    putForeignFile: ({ name, parentId, mimeType, text, appProperties }) =>
      add({ name, parentId, mimeType, appProperties, text, sourcePath: null }),
    downloads: () => [...downloads],
  };
}

function matches(options: Readonly<{ file: FakeDriveFile; query: DriveQuery }>): boolean {
  const { file, query } = options;
  // Every fake file is live; `trashed: true` therefore matches nothing.
  if (query.trashed) return false;
  if (query.name !== null && file.name !== query.name) return false;
  if (query.parentId !== null && file.parentId !== query.parentId) return false;
  if (query.sashaSlides !== null && file.appProperties["sashaSlides"] !== query.sashaSlides) return false;
  if (query.proposalId !== null && file.appProperties["proposalId"] !== query.proposalId) return false;
  return true;
}

function describeQuery(query: DriveQuery): string {
  return [
    query.name === null ? null : `name=${query.name}`,
    query.parentId === null ? null : `parent=${query.parentId}`,
    query.sashaSlides === null ? null : `sashaSlides=${query.sashaSlides}`,
    query.proposalId === null ? null : `proposalId=${query.proposalId}`,
    `trashed=${String(query.trashed)}`,
  ]
    .filter((clause): clause is string => clause !== null)
    .join(" ");
}

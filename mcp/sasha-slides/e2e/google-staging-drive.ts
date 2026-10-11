/**
 * The real Google Drive backend for the harness, built on the shared OAuth loader.
 *
 * It reads `createdTime` for every listing because the "READY is written last" invariant
 * is a statement about creation order, and a Drive listing's own order guarantees
 * nothing. Drive reports `createdTime` at millisecond resolution, so two writes inside
 * the same millisecond come back tied — `verifyWrittenLast` reports that as `tied`
 * rather than guessing.
 */
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { Readable } from "node:stream";
import type { StagedFile } from "./staged-file.ts";
import { rankByCreation } from "./staged-file.ts";
import type { StagingDrive } from "./staging-drive.ts";
import { FOLDER_MIME } from "./protocol-records.ts";

const LIST_FIELDS = "files(id,name,mimeType,appProperties,createdTime)";

export function googleStagingDrive(options: Readonly<{ auth: OAuth2Client; accountLabel: string }>): StagingDrive {
  const drive = google.drive({ version: "v3", auth: options.auth });

  return {
    describe: `google drive as ${options.accountLabel}`,

    async findFolder({ name, parentId }) {
      const parentClause = parentId === null ? "" : ` and '${parentId}' in parents`;
      const response = await drive.files.list({
        q: `mimeType = '${FOLDER_MIME}' and name = '${escapeQuoted(name)}' and trashed = false${parentClause}`,
        fields: LIST_FIELDS,
        pageSize: 10,
        spaces: "drive",
      });
      const found = (response.data.files ?? []).map(narrowDriveFile);
      const first = found[0];
      return first === undefined ? null : { ...first, writeSeq: 0 };
    },

    async createFolder({ name, parentId, appProperties }) {
      const response = await drive.files.create({
        requestBody: {
          name,
          mimeType: FOLDER_MIME,
          appProperties: { ...appProperties },
          ...(parentId === null ? {} : { parents: [parentId] }),
        },
        fields: "id,name,mimeType,appProperties,createdTime",
      });
      return { ...narrowDriveFile(response.data), writeSeq: 0 };
    },

    async createFile({ name, parentId, mimeType, content, appProperties }) {
      const response = await drive.files.create({
        requestBody: { name, parents: [parentId], appProperties: { ...appProperties } },
        media: { mimeType, body: Readable.from([content]) },
        fields: "id,name,mimeType,appProperties,createdTime",
      });
      return { ...narrowDriveFile(response.data), writeSeq: 0 };
    },

    async listChildren({ parentId }) {
      const children: Omit<StagedFile, "writeSeq">[] = [];
      let pageToken: string | undefined = undefined;
      do {
        // Annotated because `pageToken` is assigned from this reply and read back into
        // the next request, which TS would otherwise see as a circular inference.
        const response: Readonly<{ data: drive_v3.Schema$FileList }> = await drive.files.list({
          q: `'${parentId}' in parents and trashed = false`,
          fields: `nextPageToken,${LIST_FIELDS}`,
          orderBy: "createdTime",
          pageSize: 100,
          spaces: "drive",
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        for (const file of response.data.files ?? []) children.push(narrowDriveFile(file));
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken !== undefined);
      return rankByCreation(children);
    },

    async readFile({ id }) {
      const response = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "text" });
      // `responseType: "text"` makes googleapis hand back the body as a string; the
      // generated types still widen `data` to the resource type for this overload.
      return typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    },

    async deleteFile({ id }) {
      await drive.files.delete({ fileId: id });
    },
  };
}

type DriveFileShape = Readonly<{
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  appProperties?: Readonly<Record<string, string>> | null;
  createdTime?: string | null;
}>;

function narrowDriveFile(file: DriveFileShape): Omit<StagedFile, "writeSeq"> {
  if (typeof file.id !== "string") throw new Error("drive returned a file with no id");
  const createdAtMs = typeof file.createdTime === "string" ? Date.parse(file.createdTime) : Number.NaN;
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(`drive returned no usable createdTime for ${file.id} — write order is unverifiable`);
  }
  return {
    id: file.id,
    name: typeof file.name === "string" ? file.name : "<unnamed>",
    mimeType: typeof file.mimeType === "string" ? file.mimeType : "<unknown>",
    appProperties: file.appProperties ?? {},
    createdAtMs,
  };
}

/** Drive query strings quote with `'`; a literal one has to be backslash-escaped. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

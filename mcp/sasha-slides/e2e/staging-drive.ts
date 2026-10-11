/**
 * The narrow Drive surface the E2E harness needs, so the same assertions run against
 * real Google Drive and against a local fake.
 *
 * Only the operations PROTOCOL.md's staging layout actually uses are here — folders,
 * create, list, read, delete. It is deliberately not a Drive client.
 */
import type { StagedFile } from "./staged-file.ts";

export type StagingDrive = Readonly<{
  /** Printed in the harness's evidence lines so a PASS says which backend produced it. */
  describe: string;

  findFolder(options: Readonly<{ name: string; parentId: string | null }>): Promise<StagedFile | null>;

  createFolder(
    options: Readonly<{
      name: string;
      parentId: string | null;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<StagedFile>;

  createFile(
    options: Readonly<{
      name: string;
      parentId: string;
      mimeType: string;
      content: string;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<StagedFile>;

  /** Ordered by creation, oldest first, with `writeSeq` assigned from that order. */
  listChildren(options: Readonly<{ parentId: string }>): Promise<readonly StagedFile[]>;

  readFile(options: Readonly<{ id: string }>): Promise<string>;

  deleteFile(options: Readonly<{ id: string }>): Promise<void>;
}>;

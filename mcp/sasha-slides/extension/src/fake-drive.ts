// A Drive the tests own completely. TEST-ONLY: no entry point imports it, so esbuild never bundles
// it. It substitutes the DriveApi/SlidesApi dependencies rather than patching globals, which is why
// the observer and the PICK writer are exercised with no network and no Chrome.

import type { DriveApi, DriveFileRef, HttpOutcome, SlidesApi } from "./drive-api.ts";

export type FakeFile = Readonly<{
  id: string;
  name: string;
  createdTime: string;
  parents: readonly string[];
  appProperties: Readonly<Record<string, string>>;
  body: string;
}>;

export type FakeDrive = Readonly<{
  api: DriveApi;
  slides: SlidesApi;
  /** Appears in the next poll. Use `stageProposal` for a whole, correctly ordered proposal. */
  put(file: FakeFile): void;
  /** Uploads every HTML and the manifest, then READY LAST, exactly as the server must. */
  stageProposal(spec: Readonly<{ proposalId: string; count: number; presentationId: string | null; protocolVersion?: number; createdTime?: string }>): void;
  files(): readonly FakeFile[];
  /** Files the extension created. The assertion target for "it writes only PICK and render/*.png". */
  written(): readonly FakeFile[];
  byName(name: string): FakeFile | null;
  /** Makes the next N calls fail, for the backoff and retry cases. */
  failNext(count: number, message?: string): void;
  batches(): readonly Readonly<{ presentationId: string; requests: readonly object[] }>[];
  thumbnails(): readonly Readonly<{ presentationId: string; pageObjectId: string }>[];
}>;

export function fakeDrive(): FakeDrive {
  const stored: FakeFile[] = [];
  const written: FakeFile[] = [];
  const batches: Readonly<{ presentationId: string; requests: readonly object[] }>[] = [];
  const thumbnails: Readonly<{ presentationId: string; pageObjectId: string }>[] = [];
  let failures = 0;
  let failureMessage = "fake transport failure";
  let nextId = 1;

  const failIfAsked = <TValue>(): HttpOutcome<TValue> | null => {
    if (failures <= 0) return null;
    failures -= 1;
    return { kind: "failed", status: 503, message: failureMessage };
  };

  const create = (spec: {
    name: string;
    parentFolderId: string;
    appProperties: Readonly<Record<string, string>>;
    body: string;
  }): HttpOutcome<DriveFileRef> => {
    const failed = failIfAsked<DriveFileRef>();
    if (failed !== null) return failed;
    const file: FakeFile = {
      id: `written_${nextId++}`,
      name: spec.name,
      createdTime: new Date(1_700_000_000_000 + nextId).toISOString(),
      parents: [spec.parentFolderId],
      appProperties: spec.appProperties,
      body: spec.body,
    };
    stored.push(file);
    written.push(file);
    return { kind: "ok", value: refOf(file) };
  };

  const api: DriveApi = {
    async listByRoles({ roles }) {
      const failed = failIfAsked<readonly DriveFileRef[]>();
      if (failed !== null) return failed;
      const wanted = new Set(roles);
      return {
        kind: "ok",
        value: stored
          .filter((file) => wanted.has(file.appProperties["sashaSlides"] ?? ""))
          .sort((left, right) => left.createdTime.localeCompare(right.createdTime))
          .map(refOf),
      };
    },
    async downloadText(fileId) {
      const failed = failIfAsked<string>();
      if (failed !== null) return failed;
      const file = stored.find((candidate) => candidate.id === fileId);
      return file === undefined
        ? { kind: "failed", status: 404, message: `no such file ${fileId}` }
        : { kind: "ok", value: file.body };
    },
    async createTextFile({ name, parentFolderId, appProperties, body }) {
      return create({ name, parentFolderId, appProperties, body });
    },
    async createBinaryFile({ name, parentFolderId, appProperties, bytes }) {
      return create({ name, parentFolderId, appProperties, body: `<${bytes.size} bytes of ${bytes.type}>` });
    },
    async ensureChildFolder({ parentFolderId, name, appProperties }) {
      const existing = stored.find(
        (candidate) => candidate.name === name && candidate.parents[0] === parentFolderId && candidate.body === FOLDER_BODY,
      );
      if (existing !== undefined) return { kind: "ok", value: refOf(existing) };
      return create({ name, parentFolderId, appProperties, body: FOLDER_BODY });
    },
  };

  const slides: SlidesApi = {
    async batchUpdate({ presentationId, requests }) {
      const failed = failIfAsked<readonly string[]>();
      if (failed !== null) return failed;
      batches.push({ presentationId, requests });
      return { kind: "ok", value: objectIdsOf(requests) };
    },
    async pageThumbnailPng({ presentationId, pageObjectId }) {
      const failed = failIfAsked<Blob>();
      if (failed !== null) return failed;
      thumbnails.push({ presentationId, pageObjectId });
      return { kind: "ok", value: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) };
    },
  };

  return {
    api,
    slides,
    put(file) {
      stored.push(file);
    },
    stageProposal({ proposalId, count, presentationId, protocolVersion = 1, createdTime = "2026-10-03T12:00:00.000Z" }) {
      const folderId = `folder_${proposalId}`;
      const slideEntries = [];
      for (let index = 1; index <= count; index++) {
        const name = `${String(index).padStart(2, "0")}.html`;
        const fileId = `html_${proposalId}_${index}`;
        stored.push({
          id: fileId,
          name,
          createdTime,
          parents: [folderId],
          appProperties: { sashaSlides: "slide", proposalId, index: String(index) },
          body: slideHtml({ index, proposalId }),
        });
        slideEntries.push({ index, fileId, name, label: `option ${index}` });
      }
      const manifestFileId = `manifest_${proposalId}`;
      stored.push({
        id: manifestFileId,
        name: "manifest.json",
        createdTime,
        parents: [folderId],
        appProperties: { sashaSlides: "manifest", proposalId },
        body: JSON.stringify({
          protocolVersion,
          proposalId,
          createdAt: createdTime,
          presentationId,
          count,
          slides: slideEntries,
        }),
      });
      // READY LAST, which is the protocol's whole consistency story.
      stored.push({
        id: `ready_${proposalId}`,
        name: "READY",
        createdTime,
        parents: [folderId],
        appProperties: { sashaSlides: "ready", proposalId },
        body: JSON.stringify({ protocolVersion, proposalId, count, manifestFileId }),
      });
    },
    files() {
      return stored;
    },
    written() {
      return written;
    },
    byName(name) {
      return stored.find((candidate) => candidate.name === name) ?? null;
    },
    failNext(count, message) {
      failures = count;
      if (message !== undefined) failureMessage = message;
    },
    batches() {
      return batches;
    },
    thumbnails() {
      return thumbnails;
    },
  };
}

export function slideHtml({ index, proposalId }: { index: number; proposalId: string }): string {
  return [
    "<!DOCTYPE html><html><head><style>",
    "body { width: 1280px; height: 720px; margin: 0; background: #fff; }",
    `</style><title>option ${index}</title></head><body><h1>${proposalId} option ${index}</h1></body></html>`,
  ].join("");
}

const FOLDER_BODY = "<folder>";

function refOf(file: FakeFile): DriveFileRef {
  return {
    id: file.id,
    name: file.name,
    createdTime: file.createdTime,
    parents: file.parents,
    appProperties: file.appProperties,
  };
}

function objectIdsOf(requests: readonly object[]): readonly string[] {
  const ids: string[] = [];
  for (const request of requests) {
    for (const payload of Object.values(request as Record<string, unknown>)) {
      if (typeof payload !== "object" || payload === null) continue;
      const objectId = (payload as Record<string, unknown>)["objectId"];
      if (typeof objectId === "string") ids.push(objectId);
    }
  }
  return ids;
}

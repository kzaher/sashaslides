// A Drive the tests own completely. TEST-ONLY: no entry point imports it, so esbuild never bundles
// it. It substitutes the DriveApi/SlidesApi/PickApi dependencies rather than patching globals,
// which is why the observer, the PICK writer and the render artifact are exercised with no network
// and no Apps Script.
//
// ADAPTED FROM THE EXTENSION'S COPY, and the adaptation is the point. There `listByRoles` filtered
// a flat bag of files by `appProperties.sashaSlides`, so the fake could not have caught a mistake
// in the name walk -- it had no folders. Here it is a real TREE (`ROOT_FOLDER_ID` -> the inbox ->
// one folder per proposal -> READY/PICK/NN.html/manifest.json) and `scanInbox` performs the actual
// three-step descent PROTOCOL.md specifies. A `READY` in the wrong place is therefore invisible to
// the tests exactly as it would be to Drive.

import type {
  CallOutcome,
  InsertReply,
  InsertRequestSpec,
  ProposalMark,
  RenderPreviewsReply,
} from "./bridge.ts";
import type { DriveApi, PickApi, SlidesApi } from "./drive-api.ts";

export const ROOT_FOLDER_ID = "root";
export const INBOX_FOLDER_NAME = "Sasha Slides Inbox";
/** A 1x1 transparent PNG: enough for an `<img>` to be a picture rather than a broken link. */
const FAKE_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type FakeFile = Readonly<{
  id: string;
  name: string;
  createdTime: string;
  parents: readonly string[];
  mimeType: string;
  appProperties: Readonly<Record<string, string>>;
  body: string;
}>;

export type FakeDrive = Readonly<{
  api: DriveApi;
  slides: SlidesApi;
  pick: PickApi;
  /** Appears in the next poll. Use `stageProposal` for a whole, correctly ordered proposal. */
  put(file: FakeFile): void;
  /** Creates the proposal folder by NAME under the inbox, then every HTML, the manifest, and
   *  READY LAST -- exactly as the MCP server must. `ready: false` leaves it partial. */
  stageProposal(
    spec: Readonly<{
      proposalId: string;
      count: number;
      presentationId: string | null;
      protocolVersion?: number;
      createdTime?: string;
      ready?: boolean;
    }>,
  ): void;
  /** The proposal folder `stageProposal` made, so a test can name it without guessing. */
  proposalFolderId(proposalId: string): string;
  files(): readonly FakeFile[];
  /** Files the picker created. The assertion target for "it writes only PICK and render/NN.png". */
  written(): readonly FakeFile[];
  byName(name: string): FakeFile | null;
  /** Makes the next N calls fail, for the backoff and retry cases. */
  failNext(count: number, message?: string): void;
  batches(): readonly Readonly<{ presentationId: string; requests: readonly object[] }>[];
  thumbnails(): readonly Readonly<{ presentationId: string; pageObjectId: string }>[];
  /** What `renderPreviews` was asked to photograph, in call order -- one entry per candidate. */
  renderedPreviews: readonly Readonly<{ index: number; requestCount: number }>[];
}>;

export function fakeDrive(): FakeDrive {
  const stored: FakeFile[] = [];
  const written: FakeFile[] = [];
  const batches: Readonly<{ presentationId: string; requests: readonly object[] }>[] = [];
  const thumbnails: Readonly<{ presentationId: string; pageObjectId: string }>[] = [];
  let failures = 0;
  let failureMessage = "fake transport failure";
  let nextId = 1;

  const failIfAsked = <TValue>(): CallOutcome<TValue> | null => {
    if (failures <= 0) return null;
    failures -= 1;
    return { kind: "failed", message: failureMessage };
  };

  const childrenOf = (folderId: string): readonly FakeFile[] =>
    stored.filter((file) => file.parents[0] === folderId);

  const childNamed = ({ folderId, name }: { folderId: string; name: string }): FakeFile | null =>
    childrenOf(folderId).find((file) => file.name === name) ?? null;

  const create = (spec: {
    name: string;
    parentFolderId: string;
    mimeType: string;
    appProperties: Readonly<Record<string, string>>;
    body: string;
  }): FakeFile => {
    const file: FakeFile = {
      id: `written_${nextId++}`,
      name: spec.name,
      createdTime: new Date(1_700_000_000_000 + nextId).toISOString(),
      parents: [spec.parentFolderId],
      mimeType: spec.mimeType,
      appProperties: spec.appProperties,
      body: spec.body,
    };
    stored.push(file);
    written.push(file);
    return file;
  };

  const api: DriveApi = {
    async scanInbox({ pageSize }) {
      const failed = failIfAsked<readonly ProposalMark[]>();
      if (failed !== null) return failed;
      // THE NAME WALK, as Code.gs performs it: the inbox by name under My Drive, its child
      // FOLDERS (each named for its proposal), then READY/PICK by name inside each.
      const inbox = childNamed({ folderId: ROOT_FOLDER_ID, name: INBOX_FOLDER_NAME });
      if (inbox === null || inbox.mimeType !== FOLDER_MIME_TYPE) return { kind: "ok", value: [] };
      const marks = childrenOf(inbox.id)
        .filter((folder) => folder.mimeType === FOLDER_MIME_TYPE)
        .sort((left, right) => left.createdTime.localeCompare(right.createdTime))
        .slice(0, pageSize)
        .map(
          (folder): ProposalMark => ({
            proposalId: folder.name,
            folderId: folder.id,
            readyFileId: childNamed({ folderId: folder.id, name: "READY" })?.id ?? null,
            pickFileId: childNamed({ folderId: folder.id, name: "PICK" })?.id ?? null,
            createdTime: folder.createdTime,
          }),
        );
      return { kind: "ok", value: marks };
    },

    async downloadText(fileId) {
      const failed = failIfAsked<string>();
      if (failed !== null) return failed;
      const file = stored.find((candidate) => candidate.id === fileId);
      return file === undefined
        ? { kind: "failed", message: `no such file ${fileId}` }
        : { kind: "ok", value: file.body };
    },
  };

  /** Every preview render asked for, so a test can assert the ONE call covered the whole set. */
  const rendered: { index: number; requestCount: number }[] = [];

  const slides: SlidesApi = {
    async insert(spec: InsertRequestSpec) {
      const failed = failIfAsked<InsertReply>();
      if (failed !== null) return failed;
      batches.push({ presentationId: spec.presentationId, requests: spec.requests });
      const objectIds = requestedObjectIdsOf(spec.requests);
      // Code.gs's own order: batchUpdate first, then the render artifact, best effort.
      let renderArtifact: string | null = null;
      const render = spec.render;
      if (render !== null) {
        thumbnails.push({ presentationId: spec.presentationId, pageObjectId: render.pageObjectId });
        const existing = childNamed({ folderId: render.folderId, name: render.folderName });
        const renderFolder =
          existing ??
          create({
            name: render.folderName,
            parentFolderId: render.folderId,
            mimeType: FOLDER_MIME_TYPE,
            appProperties: render.folderAppProperties,
            body: "",
          });
        create({
          name: render.fileName,
          parentFolderId: renderFolder.id,
          mimeType: render.mimeType,
          appProperties: render.fileAppProperties,
          body: "<4 bytes of image/png>",
        });
        renderArtifact = render.fileName;
      }
      return {
        kind: "ok",
        value: {
          batchResponse: { replies: objectIds.map((objectId) => ({ createShape: { objectId } })) },
          renderArtifact,
        },
      };
    },

    /**
     * The throwaway-deck render, faked. A 1x1 PNG per candidate is enough: every caller only
     * cares THAT a picture arrived for an index, and the real bytes are Google's.
     */
    async renderPreviews(spec) {
      const failed = failIfAsked<RenderPreviewsReply>();
      if (failed !== null) return failed;
      for (const slide of spec.slides) {
        rendered.push({ index: slide.index, requestCount: slide.requests.length });
      }
      return {
        kind: "ok",
        value: {
          previews: spec.slides.map((slide) => ({
            index: slide.index,
            dataUri: `${FAKE_PNG_DATA_URI}#candidate${String(slide.index)}`,
            message: null,
          })),
        },
      };
    },
  };

  const pick: PickApi = {
    async createPick({ folderId, name, mimeType, body, appProperties }) {
      const failed = failIfAsked<Readonly<{ fileId: string }>>();
      if (failed !== null) return failed;
      const file = create({ name, parentFolderId: folderId, mimeType, appProperties, body });
      return { kind: "ok", value: { fileId: file.id } };
    },
  };

  const ensureInbox = (createdTime: string): string => {
    const existing = childNamed({ folderId: ROOT_FOLDER_ID, name: INBOX_FOLDER_NAME });
    if (existing !== null) return existing.id;
    stored.push({
      id: "inbox",
      name: INBOX_FOLDER_NAME,
      createdTime,
      parents: [ROOT_FOLDER_ID],
      mimeType: FOLDER_MIME_TYPE,
      appProperties: { sashaSlides: "inbox" },
      body: "",
    });
    return "inbox";
  };

  return {
    api,
    slides,
    pick,
    /** What `renderPreviews` was asked to photograph, in call order. */
    renderedPreviews: rendered,
    put(file) {
      stored.push(file);
    },
    stageProposal({
      proposalId,
      count,
      presentationId,
      protocolVersion = 1,
      createdTime = "2026-10-03T12:00:00.000Z",
      ready = true,
    }) {
      const inboxId = ensureInbox(createdTime);
      const folderId = `folder_${proposalId}`;
      stored.push({
        id: folderId,
        name: proposalId,
        createdTime,
        parents: [inboxId],
        mimeType: FOLDER_MIME_TYPE,
        appProperties: { sashaSlides: "proposal", proposalId },
        body: "",
      });
      const slideEntries = [];
      for (let index = 1; index <= count; index++) {
        const name = `${String(index).padStart(2, "0")}.html`;
        const fileId = `html_${proposalId}_${index}`;
        stored.push({
          id: fileId,
          name,
          createdTime,
          parents: [folderId],
          mimeType: "text/html",
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
        mimeType: "application/json",
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
      if (!ready) return;
      stored.push({
        id: `ready_${proposalId}`,
        name: "READY",
        createdTime,
        parents: [folderId],
        mimeType: "application/json",
        appProperties: { sashaSlides: "ready", proposalId },
        body: JSON.stringify({ protocolVersion, proposalId, count, manifestFileId }),
      });
    },
    proposalFolderId(proposalId) {
      return `folder_${proposalId}`;
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

/** Every objectId the REQUESTS asked Slides to create, which is what a real reply would echo. */
function requestedObjectIdsOf(requests: readonly object[]): readonly string[] {
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

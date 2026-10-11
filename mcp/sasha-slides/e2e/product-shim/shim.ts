// The `google.script.run` stand-in for the product E2E, as TypeScript compiled into the served
// Sidebar.html. It is NOT a mock: every one of the five functions makes the same REST call Code.gs
// makes, against real Drive and real Slides, with a real OAuth access token.
//
// WHY THIS EXISTS. The Apps Script API is disabled at the Cloud-project level, so the add-on cannot
// be pushed programmatically. The sidebar bundle, though, only ever talks to its host through
// `google.script.run` -- five functions whose request and reply shapes are declared in
// ../../addon/src/bridge.ts. Serving the SAME bundle from a local http server and installing this
// object under `window.google.script.run` therefore exercises the whole product path (observer ->
// name walk -> HTML fetch -> converter -> batchUpdate -> PICK) with Apps Script as the only thing
// substituted.
//
// THE ONE THING THAT IS NOT A DIRECT CALL is the render artifact's PNG bytes. A page thumbnail's
// `contentUrl` is an unauthenticated googleusercontent.com link, and a browser cannot read its
// bytes cross-origin -- Apps Script does it with UrlFetchApp, i.e. server side. So that single
// fetch goes through the host's `/relay` endpoint, which is this harness's UrlFetchApp. Everything
// else below is this page calling googleapis.com itself.
//
// Browser TypeScript: no node types, DOM only, gated by ./tsconfig.json. The host runs that gate
// before it emits the bundle (product-host.ts), because esbuild strips types without checking them.

import type {
  HelloReply,
  InsertReply,
  InsertRequestSpec,
  ProposalMark,
  ReadTextReply,
  ScanReply,
  WritePickReply,
  WritePickSpec,
} from "../../addon/src/bridge.ts";

/** What the host inlines into the page as a base64 `<meta>`, read once at install time. */
export type ShimConfig = Readonly<{
  accessToken: string;
  presentationUrl: string;
  inboxFolderName: string;
  /** Host endpoint that fetches a Google-hosted URL server side (stands in for UrlFetchApp). */
  relayPath: string;
  /** Host endpoint that re-mints an access token when Google answers 401. */
  tokenPath: string;
}>;

/** One server call as it happened, so the harness can assert on real traffic rather than on UI. */
export type CallRecord = Readonly<{ at: string; call: string; detail: string }>;

/** What `sashaInsert` actually sent and got back. Read by the harness over CDP. */
export type InsertEvidence = Readonly<{
  presentationId: string;
  pageObjectId: string;
  requestCount: number;
  requestKinds: readonly string[];
  createdObjectIds: readonly string[];
  renderArtifact: string | null;
  batchResponseJson: string;
}>;

/** What `sashaWritePick` actually wrote. */
export type PickEvidence = Readonly<{ fileId: string; folderId: string; name: string; body: string }>;

export type ShimEvidence = Readonly<{
  records: readonly CallRecord[];
  insert: InsertEvidence | null;
  pick: PickEvidence | null;
}>;

declare global {
  interface Window {
    /** The harness reads this over CDP; it is the probe, not part of the product. */
    __SASHA_E2E__?: () => ShimEvidence;
    /** Set when the config meta tag is missing or unreadable, so the failure is visible in the page. */
    __SASHA_E2E_BROKEN__?: string;
  }
}

/**
 * Installs the shim on `window.google`. Must run before the sidebar bundle, which calls
 * `google.script.run.sashaHello()` synchronously as it parses.
 */
export function installShim(): void {
  const config = readConfig();
  if (config === null) {
    window.__SASHA_E2E_BROKEN__ = `no <meta name="${CONFIG_META_NAME}"> in the page`;
    return;
  }
  const recorder = callRecorder();
  const server = googleServer({ config, recorder });
  window.__SASHA_E2E__ = () => recorder.evidence();
  // The sidebar reads `google.script.run` fresh for every call (a runner is single-use), which is
  // exactly what the real Apps Script shim does.
  Object.defineProperty(window, "google", {
    configurable: true,
    value: { script: { get run(): AppsScriptRunnerLike { return runnerOver(server); } } },
  });
}

const CONFIG_META_NAME = "sasha-e2e-shim-config";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SLIDES_PRESENTATIONS = "https://slides.googleapis.com/v1/presentations";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIST_FIELDS = "files(id,name,mimeType,createdTime)";

/**
 * The five functions, each one a faithful transcription of its Code.gs counterpart. Returned as a
 * record so `runnerOver` can relay by name without a switch per function.
 */
type ServerFunctions = Readonly<{
  sashaHello(): Promise<HelloReply>;
  sashaScanInbox(spec: Readonly<{ pageSize: number }>): Promise<ScanReply>;
  sashaReadText(spec: Readonly<{ fileId: string }>): Promise<ReadTextReply>;
  sashaInsert(spec: InsertRequestSpec): Promise<InsertReply>;
  sashaWritePick(spec: WritePickSpec): Promise<WritePickReply>;
}>;

/** The subset of Apps Script's runner the sidebar uses; mirrors addon/src/apps-script.d.ts. */
type AppsScriptRunnerLike = Readonly<{
  withSuccessHandler(handler: (value: unknown) => void): AppsScriptRunnerLike;
  withFailureHandler(handler: (error: unknown) => void): AppsScriptRunnerLike;
  sashaHello(): void;
  sashaScanInbox(spec: Readonly<{ pageSize: number }>): void;
  sashaReadText(spec: Readonly<{ fileId: string }>): void;
  sashaInsert(spec: InsertRequestSpec): void;
  sashaWritePick(spec: WritePickSpec): void;
}>;

type Recorder = Readonly<{
  note(record: Readonly<{ call: string; detail: string }>): void;
  insert(evidence: InsertEvidence): void;
  pick(evidence: PickEvidence): void;
  evidence(): ShimEvidence;
}>;

function googleServer({ config, recorder }: { config: ShimConfig; recorder: Recorder }): ServerFunctions {
  const transport = googleTransport(config);

  return {
    // 1/5 -- the deck the sidebar is bound to. Apps Script reads it from the active presentation;
    // here the host was told which deck to target and passed the URL in.
    async sashaHello() {
      recorder.note({ call: "sashaHello", detail: config.presentationUrl });
      return { protocolVersion: 1, presentationUrl: config.presentationUrl };
    },

    // 2/5 -- the NAME walk, exactly as Code.gs does it with DriveApp:
    //   "Sasha Slides Inbox" under My Drive -> every child folder -> has it a READY, has it a PICK.
    // No appProperties anywhere: they are private to the MCP server's OAuth client.
    async sashaScanInbox({ pageSize }) {
      const inbox = await transport.listFiles({
        query: `mimeType = '${FOLDER_MIME}' and name = ${quoted(config.inboxFolderName)} and trashed = false and 'root' in parents`,
        pageSize: 10,
      });
      const inboxFolder = inbox[0];
      if (inboxFolder === undefined) {
        recorder.note({ call: "sashaScanInbox", detail: `no "${config.inboxFolderName}" at the Drive root` });
        return { marks: [] };
      }
      const folders = await transport.listFiles({
        query: `'${inboxFolder.id}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
        pageSize,
        orderBy: "createdTime",
      });
      const marks: ProposalMark[] = [];
      for (const folder of folders) {
        const children = await transport.listFiles({
          query: `'${folder.id}' in parents and trashed = false and (name = 'READY' or name = 'PICK')`,
          pageSize: 10,
        });
        marks.push({
          proposalId: folder.name,
          folderId: folder.id,
          readyFileId: idNamed({ files: children, name: "READY" }),
          pickFileId: idNamed({ files: children, name: "PICK" }),
          createdTime: folder.createdTime ?? "",
        });
      }
      // Oldest first, so a backlog drains in the order Claude produced it.
      const ordered = [...marks].sort((left, right) => (left.createdTime < right.createdTime ? -1 : left.createdTime > right.createdTime ? 1 : 0));
      recorder.note({
        call: "sashaScanInbox",
        detail: `inbox=${inboxFolder.id} marks=${ordered.map((mark) => `${mark.proposalId}(ready=${mark.readyFileId !== null},pick=${mark.pickFileId !== null})`).join(" ")}`,
      });
      return { marks: ordered };
    },

    // 3/5 -- one primitive, three callers (READY, manifest.json, NN.html).
    async sashaReadText({ fileId }) {
      const text = await transport.readMedia({ fileId });
      recorder.note({ call: "sashaReadText", detail: `${fileId} -> ${text.length}B` });
      return { text };
    },

    // 4/5 -- the converter's batchUpdate, then the best-effort render artifact.
    async sashaInsert(spec) {
      const batchResponse = await transport.batchUpdate({
        presentationId: spec.presentationId,
        requests: spec.requests,
      });
      const createdObjectIds = createdObjectIdsOf(batchResponse);
      recorder.note({ call: "sashaInsert", detail: `${spec.requests.length} requests -> ${createdObjectIds.length} object ids` });

      let renderArtifact: string | null = null;
      if (spec.render !== null) {
        try {
          renderArtifact = await writeRenderArtifact({ transport, presentationId: spec.presentationId, render: spec.render });
        } catch (cause) {
          // Best effort by design: the slide is already in the deck, so this must never fail the
          // insert (render-artifact.ts).
          recorder.note({ call: "sashaInsert", detail: `no render artifact: ${describe(cause)}` });
        }
      }
      recorder.insert({
        presentationId: spec.presentationId,
        pageObjectId: spec.render === null ? "" : spec.render.pageObjectId,
        requestCount: spec.requests.length,
        requestKinds: spec.requests.map((request) => Object.keys(request)[0] ?? "<empty>"),
        createdObjectIds,
        renderArtifact,
        batchResponseJson: JSON.stringify(batchResponse),
      });
      return { batchResponse, renderArtifact };
    },

    // 5/5 -- the one file the picker is allowed to create. The body arrives already serialized and
    // already validated by serializePick (addon/src/protocol.ts).
    async sashaWritePick(spec) {
      const fileId = await transport.createTextFile({
        name: spec.name,
        parentId: spec.folderId,
        mimeType: spec.mimeType,
        content: spec.body,
        appProperties: spec.appProperties,
      });
      recorder.pick({ fileId, folderId: spec.folderId, name: spec.name, body: spec.body });
      recorder.note({ call: "sashaWritePick", detail: `${spec.name} -> ${fileId}` });
      return { fileId };
    },
  };
}

type Handlers = Readonly<{ onSuccess: ((value: unknown) => void) | null; onFailure: ((error: unknown) => void) | null }>;

/**
 * Apps Script's callback shim over a promise-returning server.
 *
 * `withSuccessHandler` / `withFailureHandler` return a NEW runner and leave this one untouched,
 * which is what the real API documents (apps-script.d.ts: "Each ... returns a new runner"). That is
 * not a detail: sidebar.tsx captures `google.script.run` ONCE at startup and reuses that one object
 * for every call, so a runner that mutated itself would let two in-flight calls overwrite each
 * other's handlers -- and the second caller would be handed the FIRST call's reply. Caught exactly
 * that way: candidate 2's HTML pane was served candidate 1's bytes whenever the two downloads
 * overlapped.
 */
function runnerOver(server: ServerFunctions, handlers: Handlers = { onSuccess: null, onFailure: null }): AppsScriptRunnerLike {
  const settle = (work: Promise<unknown>): void => {
    void work.then(
      (value) => {
        if (handlers.onSuccess !== null) handlers.onSuccess(value);
      },
      (cause: unknown) => {
        if (handlers.onFailure !== null) handlers.onFailure(cause instanceof Error ? cause : new Error(describe(cause)));
      },
    );
  };

  const runner: AppsScriptRunnerLike = {
    withSuccessHandler(handler) {
      return runnerOver(server, { ...handlers, onSuccess: handler });
    },
    withFailureHandler(handler) {
      return runnerOver(server, { ...handlers, onFailure: handler });
    },
    sashaHello() {
      settle(server.sashaHello());
    },
    sashaScanInbox(spec) {
      settle(server.sashaScanInbox(spec));
    },
    sashaReadText(spec) {
      settle(server.sashaReadText(spec));
    },
    sashaInsert(spec) {
      settle(server.sashaInsert(spec));
    },
    sashaWritePick(spec) {
      settle(server.sashaWritePick(spec));
    },
  };
  return runner;
}

/** The render subfolder, the thumbnail, the PNG and its tag -- the body of Code.gs's sashaWriteRender_. */
async function writeRenderArtifact({
  transport,
  presentationId,
  render,
}: {
  transport: Transport;
  presentationId: string;
  render: NonNullable<InsertRequestSpec["render"]>;
}): Promise<string> {
  const contentUrl = await transport.thumbnailUrl({ presentationId, pageObjectId: render.pageObjectId });
  const png = await transport.relayBytes({ url: contentUrl });
  const existing = await transport.listFiles({
    query: `'${render.folderId}' in parents and mimeType = '${FOLDER_MIME}' and name = ${quoted(render.folderName)} and trashed = false`,
    pageSize: 10,
  });
  const folderId =
    existing[0]?.id ??
    (await transport.createFolder({
      name: render.folderName,
      parentId: render.folderId,
      appProperties: render.folderAppProperties,
    }));
  await transport.createBinaryFile({
    name: render.fileName,
    parentId: folderId,
    mimeType: render.mimeType,
    bytes: png,
    appProperties: render.fileAppProperties,
  });
  return render.fileName;
}

type DriveFile = Readonly<{ id: string; name: string; createdTime: string | null }>;

/** Every authorized call the five functions make, with one 401 retry against a re-minted token. */
type Transport = Readonly<{
  listFiles(spec: Readonly<{ query: string; pageSize: number; orderBy?: string }>): Promise<readonly DriveFile[]>;
  readMedia(spec: Readonly<{ fileId: string }>): Promise<string>;
  createFolder(spec: Readonly<{ name: string; parentId: string; appProperties: Readonly<Record<string, string>> }>): Promise<string>;
  createTextFile(
    spec: Readonly<{
      name: string;
      parentId: string;
      mimeType: string;
      content: string;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<string>;
  createBinaryFile(
    spec: Readonly<{
      name: string;
      parentId: string;
      mimeType: string;
      bytes: Uint8Array<ArrayBuffer>;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<string>;
  batchUpdate(spec: Readonly<{ presentationId: string; requests: readonly Readonly<Record<string, unknown>>[] }>): Promise<unknown>;
  thumbnailUrl(spec: Readonly<{ presentationId: string; pageObjectId: string }>): Promise<string>;
  relayBytes(spec: Readonly<{ url: string }>): Promise<Uint8Array<ArrayBuffer>>;
}>;

function googleTransport(config: ShimConfig): Transport {
  let bearer = config.accessToken;

  async function send(spec: Readonly<{ url: string; method: string; body?: BodyInit; contentType?: string }>): Promise<Response> {
    const attempt = (token: string): Promise<Response> =>
      fetch(spec.url, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(spec.contentType === undefined ? {} : { "Content-Type": spec.contentType }),
        },
        ...(spec.body === undefined ? {} : { body: spec.body }),
      });

    let response = await attempt(bearer);
    if (response.status === 401) {
      bearer = await mintedToken(config.tokenPath);
      response = await attempt(bearer);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} on ${spec.method} ${spec.url.slice(0, 120)}: ${(await response.text()).slice(0, 300)}`);
    }
    return response;
  }

  /** Two steps rather than a multipart body: metadata (which carries appProperties) then media. */
  async function createWithMedia(
    spec: Readonly<{
      name: string;
      parentId: string;
      mimeType: string;
      body: BodyInit;
      appProperties: Readonly<Record<string, string>>;
    }>,
  ): Promise<string> {
    const created = await send({
      url: `${DRIVE_FILES}?fields=id`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        name: spec.name,
        parents: [spec.parentId],
        mimeType: spec.mimeType,
        appProperties: spec.appProperties,
      }),
    });
    const fileId = stringAt({ record: asRecord(await created.json()), key: "id" });
    if (fileId === null) throw new Error(`drive created ${spec.name} with no id`);
    await send({
      url: `${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media&fields=id`,
      method: "PATCH",
      contentType: spec.mimeType,
      body: spec.body,
    });
    return fileId;
  }

  return {
    async listFiles({ query, pageSize, orderBy }) {
      const parameters = new URLSearchParams({
        q: query,
        fields: LIST_FIELDS,
        pageSize: String(pageSize),
        spaces: "drive",
        ...(orderBy === undefined ? {} : { orderBy }),
      });
      const response = await send({ url: `${DRIVE_FILES}?${parameters.toString()}`, method: "GET" });
      return driveFilesOf(await response.json());
    },

    async readMedia({ fileId }) {
      const response = await send({ url: `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`, method: "GET" });
      return response.text();
    },

    async createFolder({ name, parentId, appProperties }) {
      const response = await send({
        url: `${DRIVE_FILES}?fields=id`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER_MIME, appProperties }),
      });
      const folderId = stringAt({ record: asRecord(await response.json()), key: "id" });
      if (folderId === null) throw new Error(`drive created folder ${name} with no id`);
      return folderId;
    },

    createTextFile({ name, parentId, mimeType, content, appProperties }) {
      return createWithMedia({ name, parentId, mimeType, body: content, appProperties });
    },

    createBinaryFile({ name, parentId, mimeType, bytes, appProperties }) {
      return createWithMedia({ name, parentId, mimeType, body: new Blob([bytes], { type: mimeType }), appProperties });
    },

    async batchUpdate({ presentationId, requests }) {
      const response = await send({
        url: `${SLIDES_PRESENTATIONS}/${encodeURIComponent(presentationId)}:batchUpdate`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ requests }),
      });
      return response.json();
    },

    async thumbnailUrl({ presentationId, pageObjectId }) {
      const response = await send({
        url:
          `${SLIDES_PRESENTATIONS}/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}` +
          "/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE",
        method: "GET",
      });
      const contentUrl = stringAt({ record: asRecord(await response.json()), key: "contentUrl" });
      if (contentUrl === null) throw new Error("thumbnail reply carried no contentUrl");
      return contentUrl;
    },

    async relayBytes({ url }) {
      // The host's UrlFetchApp: a browser cannot read googleusercontent bytes cross-origin.
      const response = await fetch(`${config.relayPath}?url=${encodeURIComponent(url)}`);
      if (!response.ok) throw new Error(`relay answered HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function mintedToken(tokenPath: string): Promise<string> {
  const response = await fetch(tokenPath);
  if (!response.ok) throw new Error(`token endpoint answered HTTP ${response.status}`);
  const token = stringAt({ record: asRecord(await response.json()), key: "accessToken" });
  if (token === null) throw new Error("token endpoint returned no accessToken");
  return token;
}

function callRecorder(): Recorder {
  const records: CallRecord[] = [];
  let insert: InsertEvidence | null = null;
  let pick: PickEvidence | null = null;
  return {
    note({ call, detail }) {
      records.push({ at: new Date().toISOString(), call, detail });
    },
    insert(evidence) {
      insert = evidence;
    },
    pick(evidence) {
      pick = evidence;
    },
    evidence() {
      return { records: [...records], insert, pick };
    },
  };
}

/**
 * The same sweep as addon/src/drive-api.ts `createdObjectIdsOf`, duplicated rather than imported
 * because the harness must read the ids out of the RAW reply itself -- importing the product's
 * reader would make the assertion circular.
 */
function createdObjectIdsOf(response: unknown): readonly string[] {
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

function readConfig(): ShimConfig | null {
  const meta = document.querySelector(`meta[name="${CONFIG_META_NAME}"]`);
  const encoded = meta === null ? null : meta.getAttribute("content");
  if (encoded === null || encoded === "") return null;
  let parsed: unknown;
  try {
    // atob yields LATIN-1 bytes, so it is decoded through TextDecoder rather than used directly
    // (same reason sidebar.tsx decodes the extractor that way).
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const accessToken = stringAt({ record, key: "accessToken" });
  const presentationUrl = stringAt({ record, key: "presentationUrl" });
  const inboxFolderName = stringAt({ record, key: "inboxFolderName" });
  const relayPath = stringAt({ record, key: "relayPath" });
  const tokenPath = stringAt({ record, key: "tokenPath" });
  if (
    accessToken === null ||
    presentationUrl === null ||
    inboxFolderName === null ||
    relayPath === null ||
    tokenPath === null
  ) {
    return null;
  }
  return { accessToken, presentationUrl, inboxFolderName, relayPath, tokenPath };
}

function driveFilesOf(payload: unknown): readonly DriveFile[] {
  const raw = asRecord(payload)?.["files"];
  if (!Array.isArray(raw)) return [];
  const files: DriveFile[] = [];
  for (const candidate of raw) {
    const record = asRecord(candidate);
    if (record === null) continue;
    const id = stringAt({ record, key: "id" });
    if (id === null) continue;
    files.push({ id, name: stringAt({ record, key: "name" }) ?? "<unnamed>", createdTime: stringAt({ record, key: "createdTime" }) });
  }
  return files;
}

function idNamed({ files, name }: { files: readonly DriveFile[]; name: string }): string | null {
  for (const file of files) {
    if (file.name === name) return file.id;
  }
  return null;
}

/** Drive query strings quote with `'`; a literal one has to be backslash-escaped. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt({ record, key }: { record: Readonly<Record<string, unknown>> | null; key: string }): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Runs as the page parses, before the sidebar bundle in <body> reaches for google.script.run.
installShim();

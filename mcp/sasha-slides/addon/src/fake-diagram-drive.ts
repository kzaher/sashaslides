// A Drive and a Slides deck the diagram tests own completely. TEST-ONLY: no entry point imports it.
//
// It is a real TREE (folders with parents, files with parents and contents), so the copy-on-write
// rule -- "update in place only inside THIS presentation's folder" -- is tested against where a file
// actually sits, exactly as Drive would answer. The DiagramDrive it hands out is composed the way
// Code.gs composes `sashaDiagramDrive_`: folder primitives plus diagram-host.ts `walkFolderPaths`.

import { walkFolderPaths, type DiagramDrive, type DiagramFolders, type RawDriveFile } from "./diagram-host.ts";

export type FakeNode = {
  id: string;
  name: string;
  kind: "folder" | "file";
  parents: string[];
  mimeType: string;
  text: string;
  /** Shared link-only (a staged picture). */
  shared: boolean;
};

export type FakeDiagramDrive = Readonly<{
  drive: DiagramDrive;
  nodes: Map<string, FakeNode>;
  batches: { presentationId: string; requests: readonly Readonly<Record<string, unknown>>[] }[];
  deleted: string[];
  /** Creates every missing folder of `path` from My Drive's root; answers the last one's id. */
  folderAt(path: readonly string[]): string;
  /** A second folder of the same name (what the connector's drive.file view can create). */
  duplicateFolder(options: Readonly<{ parentId: string | null; name: string }>): string;
  putFile(options: Readonly<{ folderId: string; name: string; text: string; mimeType?: string }>): string;
  filesIn(folderId: string): readonly FakeNode[];
  /** Make the next batchUpdate throw, as Slides does for a refused request. */
  failNextBatch(message: string): void;
}>;

export const FAKE_ROOT_ID = "root";

export function fakeDiagramDrive(options: Readonly<{ activePresentationId: string }>): FakeDiagramDrive {
  const nodes = new Map<string, FakeNode>();
  const batches: { presentationId: string; requests: readonly Readonly<Record<string, unknown>>[] }[] = [];
  const deleted: string[] = [];
  let counter = 0;
  let batchFailure: string | null = null;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}${String(counter).padStart(12, "0")}`;
  };
  const parentOf = (parentId: string | null): string => parentId ?? FAKE_ROOT_ID;
  const add = (node: FakeNode): string => {
    nodes.set(node.id, node);
    return node.id;
  };
  const children = (parentId: string, kind: FakeNode["kind"]): FakeNode[] => [...nodes.values()].filter((node) => node.kind === kind && node.parents.includes(parentId));
  const fileNode = (fileId: string): FakeNode => {
    const node = nodes.get(fileId);
    if (node === undefined || node.kind !== "file") throw new Error(`File not found: ${fileId}`);
    return node;
  };

  const folders: DiagramFolders = {
    findChildFolders: ({ parentId, name }) => children(parentOf(parentId), "folder").filter((node) => node.name === name).map((node) => node.id),
    createChildFolder: ({ parentId, name }) => add({ id: nextId("folder"), name, kind: "folder", parents: [parentOf(parentId)], mimeType: "application/vnd.google-apps.folder", text: "", shared: false }),
  };

  const drive: DiagramDrive = {
    activePresentationId: () => options.activePresentationId,
    findFolderPaths: (names) => walkFolderPaths({ names, create: false, folders }),
    ensureFolderPaths: (names) => walkFolderPaths({ names, create: true, folders }),
    listFileNames: ({ folderId }) => children(folderId, "file").map((node) => node.name),
    findFile: ({ folderId, name }) => children(folderId, "file").find((node) => node.name === name)?.id ?? null,
    fileParents: ({ fileId }) => [...fileNode(fileId).parents],
    readFile: ({ fileId }): RawDriveFile => {
      const node = fileNode(fileId);
      return { fileId, name: node.name, mimeType: node.mimeType, parentFolderIds: [...node.parents], base64: Buffer.from(node.text, "utf-8").toString("base64") };
    },
    createFile: ({ folderId, name, mimeType, text }) => add({ id: nextId("file"), name, kind: "file", parents: [folderId], mimeType, text, shared: false }),
    updateFile: ({ fileId, text }) => {
      fileNode(fileId).text = text;
    },
    stageImage: ({ fileName, mimeType, base64 }) => {
      const fileId = add({ id: nextId("staged"), name: fileName, kind: "file", parents: [FAKE_ROOT_ID], mimeType, text: base64, shared: true });
      return { fileId, url: `https://drive.google.com/uc?id=${fileId}` };
    },
    deleteFile: ({ fileId }) => {
      fileNode(fileId);
      nodes.delete(fileId);
      deleted.push(fileId);
    },
    batchUpdate: ({ presentationId, requests }) => {
      if (batchFailure !== null) {
        const message = batchFailure;
        batchFailure = null;
        throw new Error(message);
      }
      batches.push({ presentationId, requests });
      return { replies: requests.map(() => ({})) };
    },
  };

  return {
    drive,
    nodes,
    batches,
    deleted,
    folderAt: (path) => {
      const leaves = walkFolderPaths({ names: path, create: true, folders });
      const first = leaves[0];
      if (first === undefined) throw new Error("no folder was created");
      return first;
    },
    duplicateFolder: ({ parentId, name }) => folders.createChildFolder({ parentId, name }),
    putFile: ({ folderId, name, text, mimeType }) => add({ id: nextId("file"), name, kind: "file", parents: [folderId], mimeType: mimeType ?? "application/vnd.jgraph.mxfile", text, shared: false }),
    filesIn: (folderId) => children(folderId, "file"),
    failNextBatch: (message) => {
      batchFailure = message;
    },
  };
}

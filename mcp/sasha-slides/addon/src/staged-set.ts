// READING ONE STAGED SET: READY, then the manifest it names, through protocol.ts's one rule
// (`readyManifestFileIdOf`, `stagedManifestOf` -- PROTOCOL.md "What READY means now"). The slides
// window's observer, Ask Sasha and the report window all read a set here, so they cannot disagree
// about what a cleared or revised set is.
//
// ONE ROUND TRIP WHEN IT CAN BE. The inbox scan names each folder's `manifest.json` when Code.gs's
// REST walk ran, and then READY and the manifest are read together (`sashaReadTexts`). READY still
// decides: when it names a different manifest than the one read alongside it, that one is read.

import type { BatchReadApi, DriveApi } from "./drive-api.ts";
import { describeParsedFailure, readyManifestFileIdOf, stagedManifestOf, type Manifest } from "./protocol.ts";

/** Which set to read: the folder the scan found, by name, and the files it named in it. */
export type StagedSetRef = Readonly<{ proposalId: string; readyFileId: string; manifestFileId?: string | undefined }>;

export type StagedManifestRead =
  | Readonly<{ kind: "ok"; value: Manifest }>
  /** Transport: Drive did not answer. Worth asking again. */
  | Readonly<{ kind: "unavailable"; message: string }>
  /** Content: the files are not a set this rule accepts. Asking again changes nothing. */
  | Readonly<{ kind: "rejected"; reason: string }>;

export async function readStagedManifest({
  drive,
  batch,
  set,
  rememberForSidebar,
}: {
  drive: DriveApi;
  /** Absent where the surface has no batch read; READY and the manifest are then read in series. */
  batch?: BatchReadApi | undefined;
  set: StagedSetRef;
  /** Ask Code.gs to keep this read for the next sidebar open (sidebar-seed.ts). */
  rememberForSidebar?: Readonly<{ forEventId: string | null }> | undefined;
}): Promise<StagedManifestRead> {
  const together =
    batch === undefined || set.manifestFileId === undefined
      ? null
      : await batch.downloadTexts(
          [set.readyFileId, set.manifestFileId],
          rememberForSidebar === undefined ? undefined : { rememberForSidebar },
        );
  const readyText =
    together?.kind === "ok"
      ? together.value.get(set.readyFileId) ?? { kind: "failed" as const, message: "READY missing from the batch" }
      : await drive.downloadText(set.readyFileId);
  if (readyText.kind !== "ok") return { kind: "unavailable", message: readyText.message };
  const manifestFileId = readyManifestFileIdOf({ readyText: readyText.value, proposalId: set.proposalId });
  if (manifestFileId.kind !== "ok") return { kind: "rejected", reason: describeParsedFailure({ parsed: manifestFileId, what: "READY" }) };
  const readAlongside = together?.kind === "ok" ? together.value.get(manifestFileId.value) : undefined;
  const manifestText = readAlongside ?? (await drive.downloadText(manifestFileId.value));
  if (manifestText.kind !== "ok") return { kind: "unavailable", message: manifestText.message };
  const manifest = stagedManifestOf({ manifestText: manifestText.value, proposalId: set.proposalId });
  if (manifest.kind !== "ok") return { kind: "rejected", reason: describeParsedFailure({ parsed: manifest, what: "manifest.json" }) };
  return manifest;
}

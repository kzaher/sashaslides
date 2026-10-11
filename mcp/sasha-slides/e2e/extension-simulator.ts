/**
 * The extension's half of the protocol: it writes `PICK` and nothing else.
 *
 * Kept deliberately minimal because that minimality *is* the invariant — "the extension
 * writes only PICK". The harness calls this instead of the real content script so the
 * server side can be tested without a browser.
 */
import type { StagingDrive } from "./staging-drive.ts";
import type { Anomaly, PickRecord } from "./protocol-records.ts";
import { JSON_MIME, PICK_NAME, PROTOCOL_VERSION, SASHA_PROPERTY } from "./protocol-records.ts";

export async function writePick(
  options: Readonly<{
    drive: StagingDrive;
    folderId: string;
    proposalId: string;
    picked: number | null;
    insertedObjectIds: readonly string[];
    anomalies: readonly Anomaly[];
    nowMs: number;
  }>,
): Promise<Readonly<{ fileId: string; record: PickRecord }>> {
  const record: PickRecord = {
    protocolVersion: PROTOCOL_VERSION,
    proposalId: options.proposalId,
    picked: options.picked,
    decidedAt: new Date(options.nowMs).toISOString(),
    insertedObjectIds: options.insertedObjectIds,
    anomalies: options.anomalies,
  };
  const written = await options.drive.createFile({
    name: PICK_NAME,
    parentId: options.folderId,
    mimeType: JSON_MIME,
    content: `${JSON.stringify(record, null, 2)}\n`,
    appProperties: { [SASHA_PROPERTY]: "pick", proposalId: options.proposalId },
  });
  return { fileId: written.id, record };
}

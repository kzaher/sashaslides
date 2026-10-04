/**
 * PROTOCOL.md's server side, implemented straight from the document.
 *
 * This is the harness's control, not a second product: it does exactly the writes the
 * spec prescribes, in the order the spec prescribes, so the phase assertions can be
 * trusted before they are pointed at the real server. The one invariant it is written to
 * make visible is the ordering — every HTML, then the manifest, and READY strictly last.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { FaultName, ImagesReply, ProposalSide, ProposeOutcome, StateReply } from "./proposal-side.ts";
import type { StagingDrive } from "./staging-drive.ts";
import { childByName, describeChildren } from "./staged-file.ts";
import type { Manifest, ManifestSlide, PickReply } from "./protocol-records.ts";
import {
  HTML_MIME,
  INBOX_FOLDER_NAME,
  JSON_MIME,
  MANIFEST_NAME,
  PICK_NAME,
  PROTOCOL_VERSION,
  READY_NAME,
  SASHA_PROPERTY,
  newProposalId,
  parsePickRecord,
  pickReplyFromRecord,
  slideFileName,
} from "./protocol-records.ts";

const PICK_POLL_INTERVAL_MS = 120;

export function referenceProposalSide(
  options: Readonly<{
    drive: StagingDrive;
    nowMs: () => number;
    randomFraction: () => number;
    /** Harness-only protocol violations; empty for a correct run. */
    faults: readonly FaultName[];
  }>,
): ProposalSide {
  const { drive, nowMs, randomFraction, faults } = options;
  const folderIdByProposal = new Map<string, string>();

  return {
    describe: `reference writer over ${drive.describe}`,

    async propose({ htmlPaths, labels, presentationId }) {
      if (htmlPaths.length !== labels.length) {
        throw new Error(`propose: ${htmlPaths.length} paths but ${labels.length} labels`);
      }
      const proposalId = newProposalId({ nowMs: nowMs(), randomFraction: randomFraction() });
      const inboxId = await ensureInbox({ drive });
      const folder = await drive.createFolder({
        name: proposalId,
        parentId: inboxId,
        appProperties: { [SASHA_PROPERTY]: "proposal", proposalId },
      });
      folderIdByProposal.set(proposalId, folder.id);

      const slides: ManifestSlide[] = [];
      for (const [position, htmlPath] of htmlPaths.entries()) {
        const index = position + 1;
        if (faults.includes("drop-slide") && index === 3) continue;
        const name = slideFileName(index);
        const uploaded = await drive.createFile({
          name,
          parentId: folder.id,
          mimeType: HTML_MIME,
          // The path is read here, at the edge, and never handed back to the caller.
          content: readFileSync(htmlPath, "utf-8"),
          appProperties: { [SASHA_PROPERTY]: "slide", proposalId, index: String(index) },
        });
        slides.push({
          index,
          fileId: uploaded.id,
          name,
          label: labels[position] ?? basename(htmlPath),
        });
      }

      const manifest: Manifest = {
        protocolVersion: PROTOCOL_VERSION,
        proposalId,
        createdAt: new Date(nowMs()).toISOString(),
        presentationId,
        count: slides.length,
        slides,
      };
      // Injected violation: READY lands before the manifest even exists, which is the
      // exact mistake the "READY last" invariant is there to catch.
      const readyEarly = faults.includes("ready-early")
        ? await drive.createFile({
            name: READY_NAME,
            parentId: folder.id,
            mimeType: JSON_MIME,
            content: `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, proposalId, count: slides.length, manifestFileId: "not-written-yet" }, null, 2)}\n`,
            appProperties: { [SASHA_PROPERTY]: "ready", proposalId },
          })
        : null;

      const manifestFile = await drive.createFile({
        name: MANIFEST_NAME,
        parentId: folder.id,
        mimeType: JSON_MIME,
        content: `${JSON.stringify(manifest, null, 2)}\n`,
        appProperties: { [SASHA_PROPERTY]: "manifest", proposalId },
      });

      // READY last, after every HTML and the manifest. Anything added between the
      // manifest write above and this call would break the one invariant the observer
      // relies on, which is why nothing is.
      if (readyEarly === null) {
        await drive.createFile({
          name: READY_NAME,
          parentId: folder.id,
          mimeType: JSON_MIME,
          content: `${JSON.stringify(
            {
              protocolVersion: PROTOCOL_VERSION,
              proposalId,
              count: slides.length,
              manifestFileId: manifestFile.id,
            },
            null,
            2,
          )}\n`,
          appProperties: { [SASHA_PROPERTY]: "ready", proposalId },
        });
      }

      return {
        proposalId,
        count: slides.length,
        slides: slides.map((slide) => ({ index: slide.index, fileId: slide.fileId, name: slide.name })),
        folderId: folder.id,
        manifestFileId: manifestFile.id,
      } satisfies ProposeOutcome;
    },

    async awaitPick({ proposalId, timeoutSeconds }) {
      const folderId = folderIdByProposal.get(proposalId) ?? (await locateProposalFolder({ drive, proposalId }));
      if (folderId === null) throw new Error(`awaitPick: no proposal folder for ${proposalId}`);
      const deadline = nowMs() + timeoutSeconds * 1000;

      // Bounded poll with an explicit deadline — never an unbounded wait, so the caller's
      // own time budget is the only thing that decides how long this can take.
      for (;;) {
        const children = await drive.listChildren({ parentId: folderId });
        const pick = childByName(children, PICK_NAME);
        if (pick !== null) {
          const parsed = parsePickRecord(await drive.readFile({ id: pick.id }));
          if (parsed.kind === "invalid") throw new Error(`awaitPick: PICK is malformed — ${parsed.reason}`);
          return pickReplyFromRecord(parsed.value) satisfies PickReply;
        }
        if (nowMs() >= deadline) {
          // The real server reports a timeout as a status rather than an exception, so
          // the reference one does too; the phase then fails on the status, not a throw.
          return {
            status: "timeout",
            picked: null,
            anomalies: [],
            insertedObjectIds: [],
            decidedAt: null,
            note: `no ${PICK_NAME} within ${timeoutSeconds}s; folder holds ${describeChildren(children)}`,
          } satisfies PickReply;
        }
        await delay(PICK_POLL_INTERVAL_MS);
      }
    },

    async state({ proposalId }) {
      const folderId = folderIdByProposal.get(proposalId) ?? (await locateProposalFolder({ drive, proposalId }));
      if (folderId === null) return { kind: "ok", summary: `no folder for ${proposalId}`, raw: "{}" };
      const children = await drive.listChildren({ parentId: folderId });
      return {
        kind: "ok",
        summary: `${children.length} files: ${describeChildren(children)}`,
        raw: JSON.stringify({ proposalId, folderId, files: children }, null, 2),
      } satisfies StateReply;
    },

    async images() {
      return {
        kind: "unsupported",
        reason: "the reference side stages HTML only; rendering to render/NN.png is the extension's job",
      } satisfies ImagesReply;
    },

    async close() {
      folderIdByProposal.clear();
    },
  };
}

async function ensureInbox(options: Readonly<{ drive: StagingDrive }>): Promise<string> {
  const existing = await options.drive.findFolder({ name: INBOX_FOLDER_NAME, parentId: null });
  if (existing !== null) return existing.id;
  const created = await options.drive.createFolder({
    name: INBOX_FOLDER_NAME,
    parentId: null,
    appProperties: { [SASHA_PROPERTY]: "inbox" },
  });
  return created.id;
}

async function locateProposalFolder(
  options: Readonly<{ drive: StagingDrive; proposalId: string }>,
): Promise<string | null> {
  const inbox = await options.drive.findFolder({ name: INBOX_FOLDER_NAME, parentId: null });
  if (inbox === null) return null;
  const folder = await options.drive.findFolder({ name: options.proposalId, parentId: inbox.id });
  return folder === null ? null : folder.id;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

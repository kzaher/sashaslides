// Writing `PICK` -- the only file the picker is allowed to create, per PROTOCOL.md's "nobody
// mutates another component's files". Split from the Drive transport so the exact bytes can be
// asserted in a unit test, and so an impossible decision is refused in the sidebar rather than
// landing in the folder the MCP server is blocked on.
//
// ADAPTED FROM THE EXTENSION'S COPY in exactly one place: the final call is `pick.createPick`
// (one `google.script.run` function) instead of the generic `drive.createTextFile`. `buildPick` and
// `serializePick` -- everything that decides whether a decision is writable at all -- are untouched.

import type { CallOutcome } from "./bridge.ts";
import type { PickApi } from "./drive-api.ts";
import type { Proposal } from "./observer.ts";
import {
  PROTOCOL_VERSION,
  ROLE_PICK,
  SASHA_SLIDES_PROPERTY,
  assertNever,
  serializePick,
  type Anomaly,
  type Pick,
} from "./protocol.ts";

/** What the user actually decided. `picked === null` is a dismissal, which the server still waits for. */
export type Decision = Readonly<{
  picked: number | null;
  insertedObjectIds: readonly string[];
  anomalies: readonly Anomaly[];
}>;

export type PickOutcome =
  | Readonly<{ kind: "written"; fileId: string; pick: Pick }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "failed"; message: string }>;

export const PICK_FILE_NAME = "PICK";
const PICK_MIME_TYPE = "application/json";

export async function writePick({
  pick: pickApi,
  proposal,
  decision,
  decidedAt,
}: {
  pick: PickApi;
  proposal: Proposal;
  decision: Decision;
  decidedAt: string;
}): Promise<PickOutcome> {
  const pick = buildPick({ proposal, decision, decidedAt });
  if (pick.kind !== "ok") return { kind: "refused", reason: pick.reason };
  const body = serializePick(pick.value);
  switch (body.kind) {
    case "invalid":
      return { kind: "refused", reason: body.reason };
    case "unsupported-version":
      return { kind: "refused", reason: `cannot write protocolVersion ${body.protocolVersion}` };
    case "ok":
      return created({
        outcome: await pickApi.createPick({
          name: PICK_FILE_NAME,
          folderId: proposal.folderId,
          mimeType: PICK_MIME_TYPE,
          body: body.value,
          appProperties: { [SASHA_SLIDES_PROPERTY]: ROLE_PICK, proposalId: proposal.proposalId },
        }),
        pick: pick.value,
      });
    default:
      return assertNever(body);
  }
}

/**
 * The PICK value for a decision, or why the decision is impossible. Pure, so the 1-based bounds --
 * the thing that makes "option 3" mean the same slide in all three components -- are checked without
 * a Drive in the room.
 */
export function buildPick({
  proposal,
  decision,
  decidedAt,
}: {
  proposal: Proposal;
  decision: Decision;
  decidedAt: string;
}): Readonly<{ kind: "ok"; value: Pick }> | Readonly<{ kind: "invalid"; reason: string }> {
  if (decision.picked !== null && !isSlideNumber({ candidate: decision.picked, count: proposal.count })) {
    return { kind: "invalid", reason: `picked ${decision.picked} is not one of 1..${proposal.count}` };
  }
  for (const anomaly of decision.anomalies) {
    if (!isSlideNumber({ candidate: anomaly.index, count: proposal.count })) {
      return { kind: "invalid", reason: `anomaly index ${anomaly.index} is not one of 1..${proposal.count}` };
    }
  }
  if (decision.picked === null && decision.insertedObjectIds.length > 0) {
    return { kind: "invalid", reason: "a dismissal cannot report inserted object ids" };
  }
  return {
    kind: "ok",
    value: {
      protocolVersion: PROTOCOL_VERSION,
      proposalId: proposal.proposalId,
      picked: decision.picked,
      decidedAt,
      insertedObjectIds: decision.insertedObjectIds,
      anomalies: decision.anomalies,
    },
  };
}

function isSlideNumber({ candidate, count }: { candidate: number; count: number }): boolean {
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= count;
}

function created({
  outcome,
  pick,
}: {
  outcome: CallOutcome<Readonly<{ fileId: string }>>;
  pick: Pick;
}): PickOutcome {
  switch (outcome.kind) {
    case "ok":
      return { kind: "written", fileId: outcome.value.fileId, pick };
    case "failed":
      return { kind: "failed", message: `PICK upload failed: ${outcome.message}` };
    default:
      return assertNever(outcome);
  }
}

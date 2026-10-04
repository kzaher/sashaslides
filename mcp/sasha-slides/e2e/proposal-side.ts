/**
 * The "server side" of the protocol as the harness sees it: the four MCP tools, behind
 * one narrow type so the phases do not branch on which implementation is behind it.
 *
 * The shapes here mirror `server.ts`'s own payload types rather than paraphrasing them —
 * `ProposeOutcome` has no `folderId` because `propose_slides` does not return one, and
 * `PickReply` carries a `status` because a timeout is a status there and not an
 * exception. When the two disagree, the server and PROTOCOL.md win.
 *
 * Two implementations exist. `mcp-proposal-side.ts` drives the real server over stdio;
 * `reference-proposal-side.ts` performs the same Drive writes in-process straight from
 * PROTOCOL.md. The reference one is the control: it is what lets the whole loop run with
 * no credentials at all, and if the real server fails a phase the reference passes, the
 * broken invariant is the server's and not the harness's.
 */
import type { PickReply } from "./protocol-records.ts";

/**
 * Deliberate protocol violations the harness can inject, so the assertions are proven to
 * bite instead of merely being green. Each one must turn exactly one phase red:
 *   ready-early  READY written before the manifest  -> `layout` fails on write order
 *   drop-slide   the 3rd candidate never uploaded   -> `propose` fails on the slide count
 *   tamper-pick  PICK names an option nobody chose  -> `await` fails on the returned pick
 * They are honoured by the reference side only; nothing in the product reads them.
 */
export type FaultName = "ready-early" | "drop-slide" | "tamper-pick";

export const FAULT_NAMES: readonly FaultName[] = ["ready-early", "drop-slide", "tamper-pick"];

export type ProposedSlide = Readonly<{ index: number; fileId: string; name: string }>;

export type ProposeOutcome = Readonly<{
  proposalId: string;
  count: number;
  slides: readonly ProposedSlide[];
  /**
   * null from the real server, which returns neither — the harness then resolves the
   * folder by name under the inbox, which is a stronger check anyway: it proves the
   * folder is discoverable the way the extension has to discover it.
   */
  folderId: string | null;
  manifestFileId: string | null;
}>;

export type ImagesReply =
  | Readonly<{ kind: "ok"; files: readonly Readonly<{ index: number; path: string }>[] }>
  /** The extension has not rendered anything yet — the tool's own "unavailable" status. */
  | Readonly<{ kind: "unavailable"; reason: string }>
  /** This side cannot answer at all, e.g. the reference writer never renders. */
  | Readonly<{ kind: "unsupported"; reason: string }>;

export type StateReply =
  | Readonly<{ kind: "ok"; summary: string; raw: string }>
  | Readonly<{ kind: "unsupported"; reason: string }>;

export type ProposalSide = Readonly<{
  describe: string;

  propose(
    options: Readonly<{
      htmlPaths: readonly string[];
      labels: readonly string[];
      presentationId: string | null;
    }>,
  ): Promise<ProposeOutcome>;

  awaitPick(options: Readonly<{ proposalId: string; timeoutSeconds: number }>): Promise<PickReply>;

  state(options: Readonly<{ proposalId: string }>): Promise<StateReply>;

  images(options: Readonly<{ proposalId: string; outDir: string }>): Promise<ImagesReply>;

  close(): Promise<void>;
}>;

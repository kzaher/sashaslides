/**
 * One file or folder as a staging backend reports it, plus the lookups and the
 * write-order verdict the harness reads off a sibling listing.
 */

export type StagedFile = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  appProperties: Readonly<Record<string, string>>;
  createdAtMs: number;
  /**
   * Rank among its siblings by creation order, 0-based. The harness never trusts listing
   * order itself — a real Drive listing may come back in any order — so every backend
   * funnels its listing through `rankByCreation` first.
   */
  writeSeq: number;
}>;

/**
 * Whether one named file was created strictly after all its siblings. `tied` is a
 * distinct answer on purpose: two files sharing a creation timestamp means the backend
 * cannot order them, and resolving that silently would let a server that writes READY
 * too early pass the "READY last" invariant.
 */
export type LastWriteVerdict =
  | Readonly<{ kind: "last"; atMs: number }>
  | Readonly<{ kind: "not-last"; createdAfter: readonly string[] }>
  | Readonly<{ kind: "tied"; withNames: readonly string[]; atMs: number }>
  | Readonly<{ kind: "absent" }>;

export function childByName(files: readonly StagedFile[], name: string): StagedFile | null {
  return files.find((file) => file.name === name) ?? null;
}

export function verifyWrittenLast(
  options: Readonly<{ files: readonly StagedFile[]; name: string }>,
): LastWriteVerdict {
  const subject = childByName(options.files, options.name);
  if (subject === null) return { kind: "absent" };

  const others = options.files.filter((file) => file.id !== subject.id);
  const createdAfter = others
    .filter((file) => file.createdAtMs > subject.createdAtMs)
    .map((file) => `${file.name}@${file.createdAtMs}`);
  if (createdAfter.length > 0) return { kind: "not-last", createdAfter };

  const tied = others.filter((file) => file.createdAtMs === subject.createdAtMs).map((file) => file.name);
  if (tied.length > 0) return { kind: "tied", withNames: tied, atMs: subject.createdAtMs };

  return { kind: "last", atMs: subject.createdAtMs };
}

/** `0:01.html[slide] 1:02.html[slide] …` — compact evidence for a PASS/FAIL line. */
export function describeChildren(files: readonly StagedFile[]): string {
  return files
    .map((file) => `${file.writeSeq}:${file.name}[${file.appProperties["sashaSlides"] ?? "-"}]`)
    .join(" ");
}

/** Assigns `writeSeq` from creation order; the sort is stable so equal timestamps stay tied. */
export function rankByCreation(files: readonly Omit<StagedFile, "writeSeq">[]): readonly StagedFile[] {
  return [...files]
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .map((file, position) => ({ ...file, writeSeq: position }));
}

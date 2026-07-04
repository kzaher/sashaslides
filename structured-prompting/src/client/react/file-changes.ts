/**
 * Pure extraction of file changes from a turn's tool_use blocks
 * (Edit / Write / MultiEdit / NotebookEdit). No JSX, framework-agnostic —
 * both the preact ConversationDiff and the React one can share it.
 */
import type { TranscriptBlock } from "../../api/wire.js";

export interface FileChange {
  file: string;
  /** rendered unified-diff-ish lines (with +/- prefixes) */
  lines: string[];
}

/** Turn one edit tool_use input into unified-diff lines. */
function editToLines(oldStr: string, newStr: string): string[] {
  const out: string[] = ["@@ edit @@"];
  for (const l of oldStr.split("\n")) out.push("-" + l);
  for (const l of newStr.split("\n")) out.push("+" + l);
  return out;
}

/** Extract the file changes represented by the mutating tool_use blocks. */
export function extractFileChanges(blocks: TranscriptBlock[]): FileChange[] {
  const changes: FileChange[] = [];
  for (const b of blocks) {
    if (b.type !== "tool_use") continue;
    const name = b.name ?? "";
    const input = (b.input ?? {}) as Record<string, unknown>;
    const file = typeof input.file_path === "string" ? input.file_path
      : typeof input.notebook_path === "string" ? input.notebook_path
        : "(unknown file)";
    if (name === "Write") {
      const content = typeof input.content === "string" ? input.content : "";
      const lines = ["@@ new file @@", ...content.split("\n").map((l) => "+" + l)];
      changes.push({ file, lines });
    } else if (name === "Edit" || name === "NotebookEdit") {
      const oldStr = typeof input.old_string === "string" ? input.old_string
        : typeof input.old_source === "string" ? input.old_source : "";
      const newStr = typeof input.new_string === "string" ? input.new_string
        : typeof input.new_source === "string" ? input.new_source : "";
      changes.push({ file, lines: editToLines(oldStr, newStr) });
    } else if (name === "MultiEdit") {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const lines: string[] = [];
      for (const e of edits) {
        if (e && typeof e === "object") {
          const eo = e as Record<string, unknown>;
          lines.push(...editToLines(
            typeof eo.old_string === "string" ? eo.old_string : "",
            typeof eo.new_string === "string" ? eo.new_string : "",
          ));
        }
      }
      changes.push({ file, lines });
    }
  }
  return changes;
}

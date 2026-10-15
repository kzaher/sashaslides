// THE ONE EXHAUSTIVE LOOK AT DOCUMENT COMMAND KINDS the editor needs: "is this a text edit", whose
// indices must follow everyone's typing. Everything else in the state module treats commands as
// opaque values it built itself, so this total switch is where a new command kind must be decided.

import { assertNever, type DocumentCommand, type DocumentCommandKind } from "../../contracts/index.ts";

export type EditTextCommand = Extract<DocumentCommand, { kind: "editText" }>;

export function asEditText(command: DocumentCommand): EditTextCommand | null {
  switch (command.kind) {
    case "editText":
      return command;
    case "setTitle":
    case "updateTheme":
    case "upsertLayout":
    case "deleteLayout":
    case "registerAsset":
    case "upsertTransitionScript":
    case "deleteTransitionScript":
    case "approveTransitionScript":
    case "insertSlides":
    case "deleteSlides":
    case "moveSlides":
    case "setSlideProperties":
    case "insertElements":
    case "deleteElements":
    case "setFrames":
    case "updateElements":
    case "reorderElements":
    case "groupElements":
    case "ungroupElements":
    case "insertTableRows":
    case "insertTableColumns":
    case "deleteTableRows":
    case "deleteTableColumns":
    case "setTableColumnWidths":
    case "setTableRowHeights":
    case "updateTableCells":
      return null;
    default:
      return assertNever(command);
  }
}

/** The command narrowed to `kind`, or null; generic over the kind, so it decides nothing per variant. */
export function commandOfKind<TKind extends DocumentCommandKind>(command: DocumentCommand, kind: TKind): Extract<DocumentCommand, { kind: TKind }> | null {
  // The discriminant equals `kind` on this line, which is exactly what Extract<..., { kind: TKind }> selects.
  return command.kind === kind ? (command as Extract<DocumentCommand, { kind: TKind }>) : null;
}

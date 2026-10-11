// THE COMMENT BOX THAT OPENS ON WHAT YOU CLICKED.
//
// This is the annotate tool's whole surface now. Pointing at a thing and saying something about
// it is one gesture, so it is one piece of UI: the element is outlined by the editor's own
// chrome, and this opens against that outline with the cursor already in it.
//
// WHAT IT REPLACES. Annotate used to be "drag a rectangle, then find the row it made in a list
// under the slide, then type into that row, then press Send". Four places for one thought. The
// rectangle also had to be drawn by eye, so a comment about a heading was a comment about
// roughly-where-the-heading-is, and Sasha got a box instead of an element.
//
// IT DOES NOT CLAIM AN ANSWER IS COMING. The button says Comment, and what comes back says so in
// the thread rail; nothing here promises Sasha is listening, because this document cannot see
// whether a session is attached (UI-CONTRACT.md).

import { useEffect, useRef, useState, type JSX } from "react";
import { composerPlacementFor, describeSelected, regionOnSlide } from "./selection-comment.ts";
import type { Region } from "./protocol.ts";

export function SelectionComposer({
  target,
  region,
  disabled,
  onComment,
  onDismiss,
}: {
  /** The selector of the thing clicked; its last step is the heading. */
  target: string;
  /** Its box on the slide, 0-1. The composer anchors to this and the comment carries it. */
  region: Region;
  disabled: boolean;
  onComment: (spec: Readonly<{ region: Region; note: string }>) => void;
  onDismiss: () => void;
}): JSX.Element {
  const [note, setNote] = useState("");
  const field = useRef<HTMLTextAreaElement | null>(null);

  /*
   * THE CURSOR IS ALREADY IN IT. The user clicked a thing in order to say something about it;
   * making them click once more to start typing is the kind of friction that makes people stop
   * leaving comments. Keyed on the target so moving the selection re-focuses on the new one.
   */
  useEffect(() => {
    field.current?.focus();
  }, [target]);

  // TRIMMED ONCE, AND BOTH USES SHARE IT. A measured element can run past the slide edge, and
  // the comment channel refuses a box that is not 0-1 (selection-comment.ts).
  const onSlide = regionOnSlide(region);
  const placement = composerPlacementFor(onSlide);
  const send = (): void => {
    const said = note.trim();
    if (disabled || said === "") return;
    onComment({ region: onSlide, note: said });
    setNote("");
  };

  return (
    <div
      className="sasha-spot"
      data-side={placement.side}
      style={{
        left: `${placement.left * 100}%`,
        top: `${placement.top * 100}%`,
        width: `${placement.width * 100}%`,
      }}
      role="dialog"
      aria-label={`Comment on ${describeSelected(target)}`}
      // The click that selected the element must not also reach the stage behind this.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <p className="sasha-spot-head mono">
        <span className="sasha-spot-what">{describeSelected(target)}</span>
        <button
          type="button"
          className="sasha-spot-x"
          aria-label="Dismiss without commenting"
          onClick={onDismiss}
        >
          &#x2715;
        </button>
      </p>
      <textarea
        ref={field}
        className="sasha-spot-note"
        rows={2}
        disabled={disabled}
        placeholder="What is wrong with this?"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          // Escape gives the slide back; Ctrl/Cmd+Enter sends, the pair Google's own comment
          // box uses and the one the thread rail already uses.
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
            return;
          }
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          send();
        }}
      />
      <div className="sasha-spot-acts">
        <button type="button" className="sasha-secondary sasha-small" onClick={onDismiss}>
          Cancel
        </button>
        <button
          type="button"
          className="sasha-primary sasha-small"
          disabled={disabled || note.trim() === ""}
          onClick={send}
        >
          Comment
        </button>
      </div>
    </div>
  );
}

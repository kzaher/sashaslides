/**
 * Send / askFollowup nodes carry the full composed prompt (after
 * prepend / append concatenation) on `output.composedPrompt`. This
 * collapsible block lets the reviewer expand it on demand without
 * cluttering the detail panel by default.
 */
import { useState } from "preact/hooks";

export function ComposedPromptReveal(props: { text: string }) {
  const { text } = props;
  // Default EXPANDED: this IS the real message sent to the model (prepend header
  // + body + append), so show it by default rather than hiding it behind a click.
  const [shown, setShown] = useState(true);
  return (
    <div class="sect">
      <h2>
        entire prompt sent to claude{" "}
        <button class="revealBtn" onClick={() => setShown(!shown)}>{shown ? "hide" : "show"}</button>
        <span style="margin-left:8px;color:var(--muted);font-size:11px">{text.length + " chars"}</span>
      </h2>
      {shown && <pre>{text}</pre>}
    </div>
  );
}

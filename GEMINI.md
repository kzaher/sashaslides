# Engineering requirements (agent-agnostic)

## Verification must precede reporting

* **Never claim a fix works without numeric proof.** Before reporting a fix
  for a goldens regression, produce JS-level measurements that show:
  1. the *pre-fix* value of the misaligned quantity (extracted from the old
     state: the previous golden, or a captured baseline),
  2. the *post-fix* value after regen,
  3. the *target* value (from the original HTML, measured with
     `getBoundingClientRect` / `Range.getBoundingClientRect` in Chrome), and
  4. a side-by-side showing (2) matches (3) within tolerance.
  Ship these numbers in the same turn as the fix; don't make the user ask.

* **Data checks first, visuals second.** Always prefer programmatic
  measurements (DOM rects, parsed .pptx XML bounds & anchors, pixel
  centroids) over eyeballing images. If a numeric check is impossible,
  confirm visually — but **only on diff images** (`/tmp/sxs*/diffs/`),
  never on raw `originals/` or `slides/` thumbnails. Diffs isolate the
  changed pixels and make drift unambiguous; raw pictures invite
  misinterpretation ("the box is off" vs. "the text inside the box is off").

* **Structural assertion rule.** For every change that edits goldens,
  extract the target structural quantity from both the *input* (HTML) and
  the *output* (pptx XML or rendered PNG) in code, and assert they match.
  Example for a vertical-centering fix: extract the text-center Y from
  Chrome's `Range.getBoundingClientRect` on the text node, and the text
  shape's `y + h/2` from the emitted `ppt/slides/slideN.xml`, and assert
  `|target − observed| < 2 px`. Attach the measurement script + its output
  to the final message.

* **"Proof with every goldens fix."** A goldens-affecting turn is not
  complete without: (a) the numeric before/after/target table, (b) the
  measurement script that produced it (kept under `/tmp/` is fine —
  temp is acceptable for one-shot verification), and (c) an explicit
  statement that the post-fix value is within tolerance of the target.
  The user should not have to re-rate the slide to discover the fix
  didn't land.

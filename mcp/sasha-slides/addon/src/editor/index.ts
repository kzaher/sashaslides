// The editor module's public surface. A host imports from HERE and from nowhere deeper, so the
// internals (selector generation, the DOM applier, the overlay chrome) stay free to change.
//
//   import { createSlideEditor, type SlideEdit } from "./editor/index.ts";
//
//   const editor = createSlideEditor({ onWarning: (message) => showTrouble(message) });
//   editor.attach({ frame, onChange: (edits) => setEdits(edits) });
//   // ... the user drags, resizes, recolours, retypes ...
//   writeBack({ edits: editor.edits(), html: editor.html() });
//   editor.detach();

export { createSlideEditor, type Edge, type SlideEditor, type SlideEditorOptions } from "./slide-editor.ts";
export {
  SLIDE_HEIGHT_PX,
  SLIDE_WIDTH_PX,
  appendEdit,
  describeEdit,
  overridesOf,
  type ColourProperty,
  type FractionalPoint,
  type FractionalSize,
  type SlideEdit,
  type TargetOverride,
} from "./slide-edit.ts";
export { type Permission } from "./editable.ts";
export { hexOfCssColour } from "./css-colour.ts";

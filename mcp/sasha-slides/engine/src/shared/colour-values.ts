// HEXADECIMAL COLOURS AS STORED AND SENT: "#rrggbb", six hexadecimal digits in either case. The one
// check for every place that reads such a colour from something untrusted -- a literal colour and a
// list marker colour (model/stored-values.ts), a theme's colours as projected, repaired and patched
// (model/document-projection.ts, model/validation.ts, model/command-validation.ts) -- so they can
// never disagree about what a colour is.

import type { HexadecimalColour } from "../contracts/style.ts";

/** "#rrggbb" as text. A list or an object whose `toString` reads "#rrggbb" is not one: it would reach the renderer. */
export function isHexadecimalColour(candidate: unknown): candidate is HexadecimalColour {
  return typeof candidate === "string" && HEXADECIMAL_PATTERN.test(candidate);
}

const HEXADECIMAL_PATTERN = /^#[0-9a-fA-F]{6}$/;

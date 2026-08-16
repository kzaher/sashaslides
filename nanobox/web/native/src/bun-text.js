// Bun.stringWidth / Bun.wrapAnsi / Bun.stripANSI — the three functions Claude Code's TUI calls on
// EVERY frame: Ink measures every text node with stringWidth and lays it out with wrapAnsi, so a CJK
// character counted as one column (or an escape sequence counted as text) shifts the whole frame.
// Bun implements them natively against the same specs the npm packages implement, so we bundle
// `string-width`/`wrap-ansi`/`strip-ansi` for correctness — but where Bun's are native, these are
// not: string-width runs an Intl.Segmenter per call (~4 us for a 23-char line) and wrap-ansi asks it
// for the width of every single character (~160 us to wrap one 108-char line). A frame is hundreds
// of strings, so both get help:
//   * an ASCII fast path — printable ASCII is one column per character, which is most of a frame;
//   * a bounded memo of the slow path — these functions are pure, and consecutive frames re-measure
//     the same strings (typing changes one line, the other fifty are identical).
// The fast path is asserted against the packages in test/bun-globals-unit.mjs.
import stringWidthImpl from "string-width";
import wrapAnsiImpl from "wrap-ansi";
import stripAnsiImpl from "strip-ansi";

export function stringWidth(text, options) {
  if (typeof text !== "string") return 0;
  if (PLAIN.test(text)) return text.length;
  const key = flagsOf(options) + text;
  const remembered = WIDTHS.get(key);
  if (remembered !== undefined) return remembered;
  const width = stringWidthImpl(text, options);
  WIDTHS.set(key, width);
  return width;
}

export function wrapAnsi(text, columns, options) {
  if (typeof text !== "string") return "";
  if (!(columns > 0)) return text;
  if (text.length <= columns && PLAIN_TRIMMED.test(text)) return text;
  if (text.length > MAX_REMEMBERED) return wrapAnsiImpl(text, columns, options);
  const key = columns + flagsOf(options) + text;
  const remembered = WRAPS.get(key);
  if (remembered !== undefined) return remembered;
  const wrapped = wrapAnsiImpl(text, columns, options);
  WRAPS.set(key, wrapped);
  return wrapped;
}

export function stripANSI(text) {
  if (typeof text !== "string") return "";
  if (text.indexOf("\x1B") < 0 && text.indexOf("\x9B") < 0) return text;
  return stripAnsiImpl(text);
}

// printable ASCII only: every character is exactly one column and none of them starts an escape
const PLAIN = /^[\x20-\x7E]*$/;
// the same, without leading/trailing spaces — those are what wrap-ansi's default `trim` would eat
const PLAIN_TRIMMED = /^(?:[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?)?$/;
const MAX_REMEMBERED = 8192; // a wrapped result is a copy of the text: don't memo whole documents

// every option that changes the result, folded into the cache key
function flagsOf(options) {
  if (!options) return "\x00";
  return "\x00" + (options.ambiguousIsNarrow === false ? "A" : "") + (options.countAnsiEscapeCodes ? "C" : "") +
    (options.hard ? "H" : "") + (options.wordWrap === false ? "W" : "") + (options.trim === false ? "T" : "");
}

// Two generations instead of an LRU: a hit in the old generation is promoted, and the old generation
// is dropped whole when the new one fills up. O(1) per operation, at most 2*limit entries alive.
class Memo {
  #hot = new Map();
  #cold = new Map();
  #limit;

  constructor(limit) { this.#limit = limit; }

  get(key) {
    const hot = this.#hot.get(key);
    if (hot !== undefined) return hot;
    const cold = this.#cold.get(key);
    if (cold !== undefined) this.#hot.set(key, cold);
    return cold;
  }
  set(key, value) {
    this.#hot.set(key, value);
    if (this.#hot.size < this.#limit) return;
    this.#cold = this.#hot;
    this.#hot = new Map();
  }
}

const WIDTHS = new Memo(4096);
const WRAPS = new Memo(512);

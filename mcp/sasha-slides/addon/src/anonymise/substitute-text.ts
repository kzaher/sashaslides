/**
 * substitute-text.ts — the substitution itself: text in, text of the same shape out.
 *
 * THE INVARIANT THE WHOLE MODULE RESTS ON. Every ASCII letter, every ASCII digit and every Unicode
 * letter/number in the input is replaced by a DIFFERENT character of the same kind. Not "most of
 * them", not "words we recognise" — every one, unconditionally. So no substring of the original
 * that carries meaning can survive, because meaning is carried by letters and digits; what survives
 * is whitespace, punctuation and the positions of things, which is exactly the part that reproduces
 * a layout defect. substitute-text.test.ts asserts this character by character.
 *
 * HOW LAYOUT SURVIVES IT.
 *   - Length is preserved exactly, per run and therefore per text node.
 *   - Whitespace is preserved exactly, so the wrap opportunities are in the same places.
 *   - Case is preserved per character, so a capital stays a capital (and `text-transform`,
 *     `font-variant: small-caps` and first-letter rules behave the same).
 *   - A character is replaced from within its GLYPH-WIDTH BUCKET — `i` can only become `j` or `l`,
 *     `m` only `w` — so the substituted run measures within a fraction of a percent of the original
 *     in any proportional font, and lines break at the same word.
 *   - Digits stay digits and separators are untouched, so `£1,284,300` becomes a different
 *     seven-figure amount with the same symbol and the same commas, and `52%` a different two-digit
 *     percentage. Same digit count means same magnitude: that is the brief's rule, and it does mean
 *     the order of magnitude of the user's numbers is disclosed.
 *
 * CONSISTENCY, ON PURPOSE. The mapping is memoised per input string, so the same original always
 * yields the same substitute. That is not an optimisation: a CSS `[data-tone="warn"]` selector has
 * to keep matching the `data-tone` attribute it was written for, and a repeated heading has to keep
 * measuring the same. The cost is that repetition structure is preserved. The key stream is keyed
 * on the run's own text (key-stream.ts), so this is not a mono-alphabetic cipher and frequency
 * analysis buys nothing; inverting it needs the seed, which never leaves the caller.
 */
import {
  encodeHtmlAttributeValue,
  encodeHtmlCharacterData,
  LETTER_OR_NUMBER,
  splitHtmlEntities,
} from "./html-entities.ts";
import { keyStream, type KeyStream } from "./key-stream.ts";

export type TextSubstituter = Readonly<{
  /** Decoded text in, decoded text out. */
  plain(text: string): string;
  /** HTML character data in (entity references intact), character data out. */
  htmlText(source: string): string;
  /** A raw attribute value in, a raw attribute value out, escaped for `quote`. */
  htmlAttributeValue(options: Readonly<{ raw: string; quote: '"' | "'" }>): string;
  /** A URL-shaped value: the scheme survives so the preview still reads as a link. */
  url(value: string): string;
}>;

export function textSubstituter({ seed }: { seed: string }): TextSubstituter {
  const memo = new Map<string, string>();

  const plain = (text: string): string => {
    const cached = memo.get(text);
    if (cached !== undefined) return cached;
    const substituted = substituteRuns({ text, seed });
    memo.set(text, substituted);
    return substituted;
  };

  const htmlSource = ({ source, encode }: { source: string; encode: (text: string) => string }): string =>
    splitHtmlEntities(source)
      .map((piece) => (piece.kind === "opaque" ? piece.source : encode(plain(piece.text))))
      .join("");

  return {
    plain,
    htmlText: (source) => htmlSource({ source, encode: encodeHtmlCharacterData }),
    htmlAttributeValue: ({ raw, quote }) => htmlSource({ source: raw, encode: (text) => encodeHtmlAttributeValue({ text, quote }) }),
    url: (value) => {
      const scheme = /^(https?:\/\/|mailto:|tel:|ftp:\/\/)/i.exec(value);
      if (scheme === null) return plain(value);
      const prefix = scheme[0];
      return `${prefix}${plain(value.slice(prefix.length))}`;
    },
  };
}

/** True when `text` holds nothing this module would change. Used by the audit counters. */
export function hasSubstitutableCharacter(text: string): boolean {
  return SUBSTITUTABLE.test(text);
}

/** One pass over `text`, run by run. Everything that is not a letter or a digit is copied through. */
function substituteRuns({ text, seed }: { text: string; seed: string }): string {
  if (!SUBSTITUTABLE.test(text)) return text;
  const stream = keyStream({ seed, label: text });
  let out = "";
  let at = 0;
  while (at < text.length) {
    const asciiLetters = /^[A-Za-z]+/.exec(text.slice(at));
    if (asciiLetters !== null) {
      out += substituteAsciiRun({ run: asciiLetters[0], stream, table: letterCandidates });
      at += asciiLetters[0].length;
      continue;
    }
    const digits = /^[0-9]+/.exec(text.slice(at));
    if (digits !== null) {
      out += substituteAsciiRun({ run: digits[0], stream, table: digitCandidates });
      at += digits[0].length;
      continue;
    }
    const character = characterAt({ text, at });
    out += LETTER_OR_NUMBER.test(character) ? substituteForeignCharacter({ character, stream }) : character;
    at += character.length;
  }
  return out;
}

/** `[\p{L}\p{N}]` over the whole string: the test for "is there anything here to replace". */
const SUBSTITUTABLE = /[\p{L}\p{N}]/u;

function substituteAsciiRun({
  run,
  stream,
  table,
}: {
  run: string;
  stream: KeyStream;
  table: (position: Readonly<{ character: string; isFirst: boolean }>) => string;
}): string {
  let out = "";
  for (let index = 0; index < run.length; index += 1) {
    const original = run.charAt(index);
    const candidates = table({ character: original, isFirst: index === 0 });
    out += candidates.charAt(stream.nextBelow(candidates.length));
  }
  return out;
}

/**
 * Candidates for an ASCII letter: the other letters in its GLYPH-WIDTH BUCKET, same case.
 *
 * Three buckets (narrow / normal / wide) was the first attempt and the fidelity run proved it was
 * not good enough: it put `i` in the same bucket as `r` and `P` in the same bucket as `A`, so a
 * 58px heading could lose ten pixels of lead-in and every inline box after it slid. The buckets
 * below were measured instead of guessed — see `LOWERCASE_WIDTH_BUCKETS`.
 *
 * THE COST, stated plainly: because a letter stays inside its width bucket, the WIDTH PATTERN of
 * the original text survives. Together with the word lengths and the punctuation, that is a shape
 * fingerprint, and a reader with a dictionary could guess a short common word from it. It is the
 * price of lines that break in the same place, it is in the residual-risk list, and it discloses a
 * pattern rather than any content.
 *
 * `mw` / `MW` is the one bucket with a single alternative, so those two swap deterministically.
 * That is a known, bounded disclosure — a reader learns a position held one of the two — and it is
 * the price of not replacing the widest glyph in the alphabet with something a third narrower. It
 * is written down in anonymise-slide-html.ts's residual-risk list.
 */
function letterCandidates({ character }: { character: string }): string {
  const buckets = character.toLowerCase() === character ? LOWERCASE_WIDTH_BUCKETS : UPPERCASE_WIDTH_BUCKETS;
  const bucket = buckets.find((candidate) => candidate.includes(character));
  // An unexpected character falls into the last bucket, which is the mid-width bulk of the alphabet.
  return without({ alphabet: bucket ?? buckets[buckets.length - 1] ?? "x", character });
}

/**
 * MEASURED, not guessed: glyph-widths.e2e.ts prints the advance width of every letter in the font
 * stacks the real fixtures use, and scores each bucket's worst-case relative error. These lists are
 * the result of minimising that error across Georgia/Times and Helvetica/Arial at once, under the
 * constraint that a bucket needs at least two members for a substitution to exist. Worst error per
 * bucket is 0% for most, under 20% for the narrow and wide ones, and 80% for `IJ` — which cannot be
 * split, because a capital `I` is the narrowest uppercase glyph by a wide margin and has no
 * neighbour. In a monospace stack every error is 0% by construction.
 *
 * Run glyph-widths.e2e.ts before changing one of these.
 */
export const LOWERCASE_WIDTH_BUCKETS: readonly string[] = ["ijl", "frt", "aesz", "ckvxy", "mw", "bdghnopqu"];
export const UPPERCASE_WIDTH_BUCKETS: readonly string[] = ["IJ", "FL", "PS", "ETZ", "BCR", "AKVXY", "GOQ", "MW", "DHNU"];

/**
 * A different digit. The LEADING digit of a run never becomes `0`, so a number does not acquire a
 * leading zero and `1,284,300` stays a seven-figure amount; every other position draws from all ten
 * digits, so zeros still appear where they appeared.
 *
 * The one thing it cannot preserve is a leading zero: `007` becomes `483`, not `0xy`, because a `0`
 * that stayed a `0` would be a letter-or-digit surviving at its own position, and that invariant is
 * worth more than the padding. The digit COUNT — which is what the layout depends on — is exact.
 */
function digitCandidates({ character, isFirst }: { character: string; isFirst: boolean }): string {
  return without({ alphabet: isFirst ? "123456789" : "0123456789", character });
}

function without({ alphabet, character }: { alphabet: string; character: string }): string {
  const trimmed = alphabet.split(character).join("");
  // An alphabet of one (an unexpected class) would otherwise force the original through, which is
  // the one outcome this module may never produce.
  return trimmed === "" ? alphabet : trimmed;
}

/**
 * A non-ASCII letter or number, replaced within its own Unicode block so the script and the glyph
 * width stay what they were: Japanese stays Japanese, Cyrillic stays Cyrillic. A block the table
 * does not name falls back to a 64-codepoint window around the character, which keeps it in the
 * same script in every assigned block of that size.
 */
function substituteForeignCharacter({ character, stream }: { character: string; stream: KeyStream }): string {
  const code = character.codePointAt(0) ?? 0;
  const block = UNICODE_BLOCKS.find((candidate) => code >= candidate.from && code <= candidate.to) ?? {
    from: code & ~0x3f,
    to: (code & ~0x3f) + 0x3f,
  };
  const span = block.to - block.from + 1;
  const start = stream.nextBelow(span);
  for (let step = 0; step < span; step += 1) {
    const candidate = String.fromCodePoint(block.from + ((start + step) % span));
    if (candidate !== character && LETTER_OR_NUMBER.test(candidate)) return candidate;
  }
  // No assigned letter anywhere in the block: drop to ASCII rather than return the original. This
  // changes the script, which is visible in the preview, and is still never a leak.
  return "x";
}

/** Blocks worth naming, so the common scripts keep their own glyph widths. */
const UNICODE_BLOCKS: readonly Readonly<{ from: number; to: number }>[] = [
  { from: 0x00c0, to: 0x024f }, // Latin-1 Supplement letters through Latin Extended-B
  { from: 0x0370, to: 0x03ff }, // Greek and Coptic
  { from: 0x0400, to: 0x04ff }, // Cyrillic
  { from: 0x0590, to: 0x05ff }, // Hebrew
  { from: 0x0620, to: 0x064a }, // Arabic letters (skips the combining marks either side)
  { from: 0x0905, to: 0x0939 }, // Devanagari consonants and vowels
  { from: 0x3041, to: 0x3096 }, // Hiragana
  { from: 0x30a1, to: 0x30fa }, // Katakana
  { from: 0x4e00, to: 0x9fff }, // CJK Unified Ideographs
  { from: 0xac00, to: 0xd7a3 }, // Hangul syllables
];

/** A code point, never half of a surrogate pair. */
function characterAt({ text, at }: { text: string; at: number }): string {
  const point = text.codePointAt(at);
  return point === undefined ? text.charAt(at) : String.fromCodePoint(point);
}

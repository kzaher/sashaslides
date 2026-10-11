/**
 * html-entities.ts — entity references, in both directions.
 *
 * This exists because an entity reference is a CARRIER. `&#65;&#67;&#77;&#69;` is "ACME" written so
 * that a pass over the literal characters of the markup walks straight past it, and
 * `style="content:&quot;Q3&quot;"` is a CSS string hidden behind HTML escaping. Both have to be
 * decoded before anything decides what is a letter.
 *
 * Two readers, for two different jobs:
 *   - `splitHtmlEntities` is for character data and attribute values, and is deliberately PARTIAL:
 *     a reference denoting a letter or a digit is decoded (so it can be substituted), while one
 *     denoting punctuation or a symbol stays exactly as it was written. That keeps `&middot;`,
 *     `&mdash;` and `&nbsp;` as the same bytes in the output — they carry no content, and
 *     rewriting them would be a change this module cannot justify.
 *   - `decodeHtmlEntities` is TOTAL, for the one place a value has to be fully decoded before it is
 *     re-parsed as another language: the `style` attribute, whose content is CSS.
 *
 * The named table is the subset a slide document realistically uses. An unknown named reference is
 * left alone by both readers; since it denotes at most one character, the most it can carry is that
 * character, which is in the residual-risk list in anonymise-slide-html.ts.
 */

export type HtmlSourcePiece =
  /** Decoded character data: letters and digits here are the substituter's input. */
  | Readonly<{ kind: "chars"; text: string }>
  /** A reference that denotes neither a letter nor a digit. Re-emitted byte for byte. */
  | Readonly<{ kind: "opaque"; source: string }>;

export function splitHtmlEntities(source: string): readonly HtmlSourcePiece[] {
  const pieces: HtmlSourcePiece[] = [];
  let chars = "";
  let at = 0;

  for (let found = REFERENCE.exec(source); found !== null; found = REFERENCE.exec(source)) {
    chars += source.slice(at, found.index);
    at = found.index + found[0].length;
    const decoded = decodeReferenceBody(found[1] ?? "");
    if (decoded !== null && LETTER_OR_NUMBER.test(decoded)) {
      chars += decoded;
      continue;
    }
    if (chars !== "") pieces.push({ kind: "chars", text: chars });
    chars = "";
    pieces.push({ kind: "opaque", source: found[0] });
  }
  REFERENCE.lastIndex = 0;
  chars += source.slice(at);
  if (chars !== "") pieces.push({ kind: "chars", text: chars });
  return pieces;
}

/** Every reference this module knows, decoded. Unknown names are left as written. */
export function decodeHtmlEntities(source: string): string {
  const decoded = source.replace(REFERENCE, (whole, body: string) => decodeReferenceBody(body) ?? whole);
  REFERENCE.lastIndex = 0;
  return decoded;
}

/** Character data: the three characters that would otherwise re-parse as markup. */
export function encodeHtmlCharacterData(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function encodeHtmlAttributeValue({ text, quote }: { text: string; quote: '"' | "'" }): string {
  const base = encodeHtmlCharacterData(text);
  return quote === '"' ? base.replace(/"/g, "&quot;") : base.replace(/'/g, "&#39;");
}

export const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

/** `g` so both readers can share it; every user resets `lastIndex` after its loop. */
const REFERENCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function decodeReferenceBody(body: string): string | null {
  if (body.startsWith("#")) {
    const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    return String.fromCodePoint(code);
  }
  const exact = NAMED[body];
  if (exact !== undefined) return exact;
  const lowercase = NAMED[body.toLowerCase()];
  if (lowercase === undefined) return null;
  // `&Eacute;` and `&eacute;` share a table entry; the case comes from how it was written.
  return body.charAt(0) === body.charAt(0).toUpperCase() ? lowercase.toUpperCase() : lowercase;
}

/**
 * Letters first (these are what get substituted), then the symbols and spaces a slide actually
 * uses. The symbol entries exist for `decodeHtmlEntities`; `splitHtmlEntities` passes them straight
 * through because they are not letters.
 */
const NAMED: Readonly<Record<string, string>> = {
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ",
  yuml: "ÿ", szlig: "ß", oelig: "œ", scaron: "š", zcaron: "ž",
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  thinsp: " ", shy: "­", middot: "·", bull: "•", hellip: "…", mdash: "—",
  ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚",
  bdquo: "„", dagger: "†", permil: "‰", prime: "′", times: "×", divide: "÷",
  plusmn: "±", minus: "−", deg: "°", micro: "µ", para: "¶", sect: "§",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥",
  cent: "¢", curren: "¤", laquo: "«", raquo: "»", iexcl: "¡", iquest: "¿",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", ne: "≠",
  le: "≤", ge: "≥", infin: "∞", sup2: "²", sup3: "³", frac12: "½",
  frac14: "¼", frac34: "¾", ordf: "ª", ordm: "º",
};

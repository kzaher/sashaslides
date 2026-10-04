/**
 * lorem-text.ts — the third text strategy: lorem ipsum matched to the original's RENDERED WIDTH.
 *
 * WHY IT EXISTS. The other two both cost something. Character substitution gives
 * `Dqtfnmlgq fakzqqz 3299532` — safe, same shape, and unreadable, so a defect report is hard to
 * diagnose and a before/after is hard to judge. Model-written text reads well, but the slide's
 * words have to be sent to a model to get it. Lorem ipsum gets most of the readability for none of
 * the exposure: NOTHING LEAVES THE BROWSER, there is no model and no network, it works offline and
 * on-premise, and it is a pure function of (text, seed) so a test can assert its output.
 *
 * WIDTH, NOT CHARACTER COUNT. `Illinois` and `WWWWWWWW` are the same length and nowhere near the
 * same width, so counting characters would move every inline box after the run. Each word is
 * built by ACCUMULATING lorem material until its advance width approximates the original's,
 * measured in per mille of the font size from the table `glyph-advance-widths.ts` holds — the same
 * Chrome measurement the substituter's width buckets were rebuilt from.
 *
 * WHAT IS PRESERVED, and why each one is not negotiable:
 *   - WHITESPACE, BYTE FOR BYTE. The run is split on `/(\s+)/` and every whitespace piece is
 *     re-emitted verbatim, so hard line breaks, indentation and double spaces all survive exactly
 *     and the number of break opportunities is unchanged. That is what reproduces a wrapping
 *     defect, and it is why this works chunk by chunk rather than filling the run as one budget:
 *     matching only the run's TOTAL width moves every break opportunity inside it, and the
 *     fidelity harness asserts the line-box count with no tolerance at all.
 *   - DIGITS STAY DIGITS. A chunk holding a digit is handed to the SUBSTITUTER whole, which keeps
 *     the digit count (so the magnitude), the separators and the currency symbol: `£1,284,300`
 *     becomes a different seven-figure amount, never `lorem ipsum`. A table of figures that turned
 *     into words would stop reproducing the defect and would look absurd. This is the carve-out
 *     that matters most.
 *   - SENTENCE SHAPE. Punctuation is re-emitted verbatim and casing is copied per word, so a
 *     leading capital stays a capital, a terminal full stop stays where it was, and an ALL-CAPS
 *     label stays ALL-CAPS (which is also what keeps its width right).
 *   - LENGTH PROPORTION. A chunk maps to a chunk, so a button label, a table cell or an axis tick
 *     gets ONE word and a paragraph gets a paragraph. Nothing short becomes a sentence.
 *
 * IT NEVER FALLS BACK TO THE ORIGINAL, which is the architecture's one rule. Three cases are
 * handed to the substituter instead of being written in lorem, and all three are gibberish rather
 * than the original: a chunk with a digit in it (above), a chunk holding a non-ASCII letter (so
 * Japanese stays Japanese and Cyrillic stays Cyrillic at their own glyph widths instead of
 * becoming Latin), and a single letter (`a`, `I`), which has no lorem word of its width — a
 * substituted letter from the same width bucket is the closest match that exists and reads as
 * prose just as well.
 *
 * NO LOREM WORD IS EVER ONE OF THE SLIDE'S OWN. The document's vocabulary is subtracted from the
 * candidate list before anything is chosen (`documentWordsOf`), so a slide that says "sed" or
 * "in" cannot have those words handed back to it. That subtraction is also what makes
 * "never the original" true at word level: the only way lorem could echo the slide is by
 * coincidence, and the coincidence is exactly what is filtered out. If it ever filtered out
 * EVERYTHING, the word is substituted instead.
 *
 * DETERMINISM. The choice among the best-scoring candidates comes from `keyStream({ seed, label })`
 * with the word itself as the label, so the same word in the same document under the same seed
 * always yields the same lorem word — a repeated heading keeps measuring the same — while a
 * different seed yields different prose.
 */
import {
  MONOSPACE_ADVANCE_PER_MILLE,
  textAdvanceWidth,
  WIDTH_MODELS,
  type WidthModel,
} from "./glyph-advance-widths.ts";
import { keyStream, type KeyStream } from "./key-stream.ts";
import { hasSubstitutableCharacter, type TextSubstituter } from "./substitute-text.ts";
import type { TextRunSite } from "./text-runs.ts";

export type LoremTexter = Readonly<{
  /**
   * Decoded run text in, decoded lorem of the same shape out. Memoised per input, so the same
   * original always yields the same lorem.
   */
  plain(text: string): string;
}>;

/**
 * `substituter` is injected rather than built here because the two strategies must share one: a
 * chunk this module hands over has to come out exactly as the substitute strategy would have
 * produced it, memoisation and all.
 */
export function loremTexter({
  seed,
  documentWords,
  substituter,
}: {
  seed: string;
  /** Every word of the slide's own visible text, folded. `documentWordsOf` builds it. */
  documentWords: ReadonlySet<string>;
  substituter: TextSubstituter;
}): LoremTexter {
  const candidates = LOREM_VOCABULARY.filter((candidate) => !documentWords.has(candidate));
  const runMemo = new Map<string, string>();
  const wordMemo = new Map<string, string>();

  const loremWord = (word: string): string => {
    const cached = wordMemo.get(word);
    if (cached !== undefined) return cached;
    const written = writeLoremWord({ word, candidates, seed, substituter });
    wordMemo.set(word, written);
    return written;
  };

  return {
    plain: (text) => {
      const cached = runMemo.get(text);
      if (cached !== undefined) return cached;
      const written = text
        .split(WHITESPACE_PIECES)
        .map((piece, index) => (index % 2 === 1 ? piece : writeLoremChunk({ chunk: piece, loremWord, substituter })))
        .join("");
      runMemo.set(text, written);
      return written;
    },
  };
}

/**
 * The slide's own words, folded for comparison, so no lorem word can coincide with one.
 *
 * The scope is the VISIBLE TEXT RUNS, which is the same scope `forbiddenEchoFragmentsOf` in
 * replacement-policy.ts uses and for the same reason: it is the text a reader of the preview sees,
 * so it is where a surviving word would be noticed as the user's own.
 */
export function documentWordsOf({ sites }: { sites: readonly TextRunSite[] }): ReadonlySet<string> {
  const words = new Set<string>();
  for (const site of sites) {
    for (const found of foldedForComparison(site.text).matchAll(/\p{L}+/gu)) words.add(found[0]);
  }
  return words;
}

/**
 * The candidate words: classical lorem ipsum plus the two de Finibus passages it is cut from, so
 * the lengths run from 2 to 14 characters and every width in between has several words at it.
 *
 * Lowercase and ASCII by construction — `writeLoremWord` applies the original's casing, and a
 * candidate with an accent in it would not be measurable from the width table.
 */
export const LOREM_VOCABULARY: readonly string[] = [
  "ab", "ad", "at", "do", "ea", "eo", "et", "eu", "ex", "hic", "id", "in", "ut", "vel",
  "alias", "aliqua", "aliquam", "aliquid", "aliquip", "amet", "animi", "aperiam", "architecto",
  "asperiores", "aspernatur", "assumenda", "atque", "aute", "autem", "beatae", "blanditiis",
  "cillum", "commodi", "commodo", "consectetur", "consequat", "consequatur", "consequuntur",
  "corporis", "corrupti", "culpa", "cum", "cumque", "cupidatat", "cupiditate", "debitis",
  "delectus", "deleniti", "deserunt", "dicta", "dignissimos", "distinctio", "dolor", "dolore",
  "dolorem", "doloremque", "dolores", "doloribus", "dolorum", "ducimus", "duis", "eaque",
  "eiusmod", "eligendi", "elit", "enim", "eos", "error", "esse", "est", "etiam", "eum", "eveniet",
  "excepteur", "excepturi", "exercitation", "exercitationem", "expedita", "explicabo", "facere",
  "facilis", "fuga", "fugiat", "fugit", "harum", "illo", "illum", "impedit", "incididunt",
  "incidunt", "inventore", "ipsa", "ipsam", "ipsum", "irure", "iste", "itaque", "iure", "iusto",
  "labore", "laboriosam", "laboris", "laborum", "laudantium", "libero", "lorem", "magna",
  "magnam", "magni", "maiores", "maxime", "minim", "minus", "modi", "molestiae", "molestias",
  "mollit", "mollitia", "nam", "natus", "necessitatibus", "nemo", "neque", "nesciunt", "nihil",
  "nisi", "nobis", "non", "nostrud", "nostrum", "nulla", "numquam", "obcaecati", "occaecat",
  "odio", "odit", "officia", "officiis", "omnis", "optio", "pariatur", "perferendis",
  "perspiciatis", "placeat", "porro", "possimus", "praesentium", "proident", "provident", "quae",
  "quaerat", "quam", "quas", "quasi", "qui", "quia", "quibusdam", "quidem", "quis", "quisquam",
  "quo", "quod", "quos", "ratione", "recusandae", "reiciendis", "rem", "repellat", "repellendus",
  "reprehenderit", "repudiandae", "rerum", "saepe", "sapiente", "sed", "sequi", "similique",
  "sint", "sit", "soluta", "suscipit", "tempora", "tempore", "temporibus", "tenetur", "totam",
  "ullam", "ullamco", "unde", "velit", "veniam", "vero", "veritatis", "vitae", "voluptas",
  "voluptate", "voluptatem", "voluptates", "voluptatibus", "voluptatum",
];

/** `split` with a captured separator: the odd pieces are the whitespace and are never touched. */
const WHITESPACE_PIECES = /(\s+)/;

/**
 * One whitespace-delimited chunk. Two of the three hand-overs to the substituter are here (the
 * third, a single letter, is in `writeLoremWord`), each for the reason in the header.
 */
function writeLoremChunk({
  chunk,
  loremWord,
  substituter,
}: {
  chunk: string;
  loremWord: (word: string) => string;
  substituter: TextSubstituter;
}): string {
  if (!hasSubstitutableCharacter(chunk)) return chunk;
  if (DIGIT.test(chunk)) return substituter.plain(chunk);
  if (NON_ASCII_LETTER_OR_NUMBER.test(chunk)) return substituter.plain(chunk);
  // The odd pieces are the maximal runs of ASCII letters; everything else — `-`, `'`, `(`, `£`,
  // `—` — is punctuation inside the chunk and is re-emitted verbatim so the shape reads the same.
  return chunk
    .split(ASCII_LETTER_PIECES)
    .map((piece, index) => (index % 2 === 1 ? loremWord(piece) : piece))
    .join("");
}

const DIGIT = /\p{N}/u;
/** A letter or digit outside ASCII: the substituter keeps it inside its own Unicode block. */
const NON_ASCII_LETTER_OR_NUMBER = /(?![\u0000-\u007f])[\p{L}\p{N}]/u;
const ASCII_LETTER_PIECES = /([A-Za-z]+)/;

/**
 * One word, accumulated until its advance width approximates `word`'s under every width model at
 * once (`fitCostOf`).
 *
 * Normally one candidate is enough — the vocabulary covers every width a 2-to-14-letter word has.
 * The loop exists for a word WIDER than any single candidate (a long compound, a run-together
 * token), where it concatenates candidates until adding another would fit worse than stopping. A
 * concatenation keeps the token unbreakable, which is the property a narrow box depends on.
 */
function writeLoremWord({
  word,
  candidates,
  seed,
  substituter,
}: {
  word: string;
  candidates: readonly string[];
  seed: string;
  substituter: TextSubstituter;
}): string {
  if (word.length === 1) return substituter.plain(word);
  if (candidates.length === 0) return substituter.plain(word);
  const casing = casingOf(word);
  const stream = keyStream({ seed, label: `lorem\u0000${word}` });
  const parts: string[] = [];
  let remaining = fitTargetOf({ word, casing });
  while (parts.length < MAX_PARTS_PER_WORD) {
    const part = pickCandidate({ candidates, remaining, stream });
    if (part === null) return substituter.plain(word);
    // Stop as soon as another part would fit WORSE than stopping here does, scored by the same
    // cost the candidate was chosen with — the empty continuation is just another candidate. The
    // obvious "did the width get closer" test is not the same thing and gets this wrong: it
    // accepts a part that trades a small width gain for a whole extra syllable, which is how
    // `embedded` came out as `possimusid`.
    if (parts.length > 0 && fitCostOf({ candidate: part, remaining }) >= fitCostOf({ candidate: "", remaining })) break;
    parts.push(part);
    remaining = fitTargetWithout({ remaining, part });
  }
  return casedWord({ word: parts.join(""), casing });
}

/** A concatenated word is already implausibly long by four parts; this only bounds a pathology. */
const MAX_PARTS_PER_WORD = 4;

/**
 * The candidate that best fits what is left of the target, chosen from the best few so the prose
 * does not repeat one word for every 5-letter original.
 *
 * `null` only when `candidates` is empty, which the caller has already ruled out — it is here so
 * the index lookup needs neither a non-null assertion nor a throw in a privacy path.
 */
function pickCandidate({
  candidates,
  remaining,
  stream,
}: {
  candidates: readonly string[];
  remaining: FitTarget;
  stream: KeyStream;
}): string | null {
  const scored = candidates
    .map((candidate) => ({ candidate, cost: fitCostOf({ candidate, remaining }) }))
    // The alphabetical tie-break makes the order total, so the key stream draws from a list that
    // does not depend on the vocabulary's declaration order.
    .sort((left, right) => left.cost - right.cost || (left.candidate < right.candidate ? -1 : 1));
  const chosen = scored[stream.nextBelow(Math.min(CANDIDATE_CHOICES, scored.length))];
  return chosen === undefined ? null : chosen.candidate;
}

/** How many of the best-fitting candidates the key stream draws from. Variety against accuracy. */
const CANDIDATE_CHOICES = 3;

/**
 * What is left to fill, under every width this module can measure.
 *
 * `widths` is keyed by `FitProfile.label`, so a profile can be added to the list below and every
 * term here follows without a second place to edit.
 */
type FitTarget = Readonly<{
  widths: ReadonlyMap<string, number>;
  /** Characters still to emit. Stands in for monospace AND for `letter-spacing`. */
  letters: number;
  casing: LetterCasing;
}>;

/**
 * THE PROFILES: every way the slide's CSS could render this word, as far as a width table can
 * tell. This module sees the text of one run and nothing else — not the `font-family`, not the
 * `text-transform` — so instead of guessing which one applies it fits them ALL, and `fitCostOf`
 * scores a candidate by its WORST profile.
 *
 * `uppercase` is not a small correction and that is why it is here. A capital is about a third
 * wider than its lowercase and the ORDER is not preserved: `fixture` is one of the narrowest
 * 7-letter words in lower case and one of the widest in upper (`f`, `i`, `t`, `r` are narrow,
 * `F`, `I`, `T`, `R` are not), so a lowercase-only fit was 3.5% out on fixture 01's
 * `text-transform: uppercase` footer — the worst drift in the whole fidelity run.
 */
type FitProfile = Readonly<{ label: string; model: WidthModel; uppercase: boolean }>;

const FIT_PROFILES: readonly FitProfile[] = WIDTH_MODELS.flatMap((model) => [
  { label: model, model, uppercase: false },
  { label: `${model}-uppercase`, model, uppercase: true },
]);

function fitTargetOf({ word, casing }: { word: string; casing: LetterCasing }): FitTarget {
  return {
    widths: new Map(FIT_PROFILES.map((profile) => [profile.label, profileWidthOf({ text: word, profile })])),
    letters: word.length,
    casing,
  };
}

function fitTargetWithout({ remaining, part }: { remaining: FitTarget; part: string }): FitTarget {
  const cased = casedWord({ word: part, casing: remaining.casing });
  return {
    widths: new Map(
      FIT_PROFILES.map((profile) => [
        profile.label,
        (remaining.widths.get(profile.label) ?? 0) - profileWidthOf({ text: cased, profile }),
      ]),
    ),
    letters: remaining.letters - part.length,
    casing: remaining.casing,
  };
}

/**
 * How badly a candidate fits: its WORST width profile, plus a fraction of the character-count
 * error.
 *
 * Taking the worst profile rather than an average is what makes this robust to the one thing it
 * cannot see — which profile is real. A candidate that fits Georgia beautifully and Helvetica
 * badly is not a good answer, because the slide may well be in Helvetica. There is no weight on
 * the width terms to tune: they are all the same quantity measured under different assumptions.
 *
 * The character-count term DOES have a weight, because it is a different quantity: it is the whole
 * of the width only in a monospace run, and a per-character constant under `letter-spacing`. A
 * quarter of a monospace cell per character is the share that measured best across the four
 * fixtures — `letter-spacing` appears on three of them.
 */
function fitCostOf({ candidate, remaining }: { candidate: string; remaining: FitTarget }): number {
  const cased = casedWord({ word: candidate, casing: remaining.casing });
  let worstWidthError = 0;
  for (const profile of FIT_PROFILES) {
    const error = Math.abs((remaining.widths.get(profile.label) ?? 0) - profileWidthOf({ text: cased, profile }));
    worstWidthError = Math.max(worstWidthError, error);
  }
  const cellError = Math.abs(remaining.letters - candidate.length) * MONOSPACE_ADVANCE_PER_MILLE;
  return worstWidthError + MONOSPACE_FIT_WEIGHT * cellError;
}

const MONOSPACE_FIT_WEIGHT = 0.25;

function profileWidthOf({ text, profile }: { text: string; profile: FitProfile }): number {
  return textAdvanceWidth({ text: profile.uppercase ? text.toUpperCase() : text, model: profile.model });
}

/**
 * Which capitals the original had. Copied onto the lorem word because `text-transform`,
 * `font-variant: small-caps` and a first-letter rule all behave differently under a different
 * pattern — and because a capital is a fifth wider than its lowercase, so the fit depends on it.
 */
type LetterCasing = "lower" | "capitalised" | "upper";

function casingOf(word: string): LetterCasing {
  if (word.length > 1 && word === word.toUpperCase()) return "upper";
  return word.charAt(0) === word.charAt(0).toUpperCase() ? "capitalised" : "lower";
}

function casedWord({ word, casing }: { word: string; casing: LetterCasing }): string {
  switch (casing) {
    case "lower":
      return word;
    case "capitalised":
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    case "upper":
      return word.toUpperCase();
    default:
      return assertNever(casing);
  }
}

/**
 * The form two words are compared in: compatibility-decomposed, combining marks dropped,
 * lowercased, so `Ｌｏｒｅｍ`, `Lorem` and `Lórem` on the slide all ban the candidate `lorem`.
 *
 * It is the same fold `replacement-policy.ts` uses on the echo rule. The two are deliberately
 * separate copies: each file states the comparison its own rule is written in, and a shared helper
 * would make one rule's fold changeable from the other's file.
 */
function foldedForComparison(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled lorem case: ${JSON.stringify(value)}`);
}

// ORDER KEYS: the fractional index strings slide order and z-order are stored as (yjs-schema.ts
// "ORDER IS A FRACTIONAL KEY"). A move is one field write, and a key strictly between any two
// different neighbours always exists, so nothing else in the list is ever rewritten.
//
// Key decisions:
//
//  * OUR OWN BASE-62 MIDPOINT, NO DEPENDENCY. Digits are "0-9A-Za-z", which is also their order in
//    a plain string comparison, so keys compare with `<` everywhere (never `localeCompare`, whose
//    order depends on the locale). A minted key never ends in "0": a key ending in "0" leaves no
//    room below it ("V" < x < "V0" has no solution), which is the classic fractional-indexing trap.
//
//  * A MINTED KEY IS NEVER A PREFIX OF ITS UPPER NEIGHBOUR. That is what lets a random suffix be
//    appended without crossing the upper neighbour: if `key < upper` and `key` is not a prefix of
//    `upper`, then `key + anything < upper`.
//
//  * ONE RANDOM PART PER RUN. Inserting several items into one gap mints ONE base key with a random
//    suffix from the injected random source, then spreads the run under it. Two people pasting
//    three slides into the same gap at once therefore get two contiguous runs (their random parts
//    differ), never A1 B1 A2 B2, and two replicas never mint the same key.
//
//  * BROKEN NEIGHBOURS RE-KEY LOCALLY. Equal keys (old data), a non-canonical key or an upper key
//    with no room below it cannot be minted between; `planGapKeys` then re-keys the smallest run
//    of following siblings that makes room, and as a last resort the whole list, always keeping
//    the displayed order.

import type { RandomSource } from "../contracts/ids.ts";

export const ORDER_KEY_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Characters of randomness appended to every newly minted base key. */
export const RANDOM_SUFFIX_LENGTH = 4;

/** A sibling as ordering sees it: its stored key and its id, the tie-break for equal keys. */
export type OrderedSibling = Readonly<{ id: string; key: string }>;

/** The keys for a gap: `inserted` for the new items in order, `rekeyed` for siblings that had to move. */
export type GapKeys = Readonly<{ inserted: readonly string[]; rekeyed: ReadonlyMap<string, string> }>;

/**
 * Keys for `count` new items inserted at `gapIndex` of `siblings` (sorted with `compareOrderedSiblings`):
 * after `siblings[gapIndex - 1]` and before `siblings[gapIndex]`.
 */
export function planGapKeys(
  options: Readonly<{ siblings: readonly OrderedSibling[]; gapIndex: number; count: number; random: RandomSource }>,
): GapKeys {
  const { siblings, gapIndex, count, random } = options;
  const lower = siblings[gapIndex - 1]?.key ?? null;
  for (let end = gapIndex; end <= siblings.length; end += 1) {
    const upper = siblings[end]?.key ?? null;
    const keys = mintOrderKeys({ lower, upper, count: count + (end - gapIndex), random });
    if (keys === null) continue;
    const rekeyed = new Map<string, string>();
    siblings.slice(gapIndex, end).forEach((sibling, offset) => rekeyed.set(sibling.id, keys[count + offset] ?? sibling.key));
    return { inserted: keys.slice(0, count), rekeyed };
  }
  // The lower neighbour itself is unusable (not canonical): re-key the whole list, in order.
  const keys = mintOrderKeys({ lower: null, upper: null, count: siblings.length + count, random }) ?? [];
  const rekeyed = new Map<string, string>();
  siblings.forEach((sibling, index) => {
    const position = index < gapIndex ? index : index + count;
    rekeyed.set(sibling.id, keys[position] ?? sibling.key);
  });
  return { inserted: keys.slice(gapIndex, gapIndex + count), rekeyed };
}

/**
 * New keys for the siblings in `order` (the wanted order, every sibling once) whose ids are in
 * `moved`; the others keep their keys where possible. Returns only the keys that change.
 */
export function planReorderKeys(
  options: Readonly<{ order: readonly OrderedSibling[]; moved: ReadonlySet<string>; random: RandomSource }>,
): ReadonlyMap<string, string> {
  const { order, moved, random } = options;
  const changes = new Map<string, string>();
  let index = 0;
  let lower: string | null = null;
  while (index < order.length) {
    const sibling = order[index];
    if (sibling === undefined) break;
    if (!moved.has(sibling.id)) {
      if (lower !== null && !(lower < sibling.key)) return renumberAll({ order, random });
      lower = sibling.key;
      index += 1;
      continue;
    }
    let end = index;
    while (end < order.length && moved.has(order[end]?.id ?? "")) end += 1;
    const upper = order[end]?.key ?? null;
    const keys = mintOrderKeys({ lower, upper, count: end - index, random });
    if (keys === null) return renumberAll({ order, random });
    order.slice(index, end).forEach((run, offset) => changes.set(run.id, keys[offset] ?? run.key));
    lower = keys[keys.length - 1] ?? lower;
    index = end;
  }
  return changes;
}

/**
 * `count` ascending keys strictly between `lower` and `upper` (null: open), sharing one random
 * base key; null when no key fits (equal or inverted neighbours, a non-canonical neighbour, or an
 * upper neighbour with no room below it).
 */
export function mintOrderKeys(
  options: Readonly<{ lower: string | null; upper: string | null; count: number; random: RandomSource }>,
): readonly string[] | null {
  const { lower, upper, count, random } = options;
  if (count <= 0) return [];
  if (lower !== null && !isCanonicalOrderKey(lower)) return null;
  if (upper !== null && !isCanonicalOrderKey(upper)) return null;
  if (lower !== null && upper !== null && !(lower < upper)) return null;
  const middle = keyBetween({ lower: lower ?? "", upper });
  if (middle === null) return null;
  const base = middle + randomSuffix(random);
  if (count === 1) return [base];
  return spreadKeys(count).map((spread) => base + spread);
}

/** Display order: by key, then by id for the equal keys only old data has. */
export function compareOrderedSiblings(first: OrderedSibling, second: OrderedSibling): number {
  if (first.key !== second.key) return first.key < second.key ? -1 : 1;
  if (first.id === second.id) return 0;
  return first.id < second.id ? -1 : 1;
}

/** True for a non-empty key made only of order key digits. */
export function isCanonicalOrderKey(key: string): boolean {
  return CANONICAL_KEY_PATTERN.test(key);
}

const CANONICAL_KEY_PATTERN = /^[0-9A-Za-z]+$/;

function renumberAll(options: Readonly<{ order: readonly OrderedSibling[]; random: RandomSource }>): ReadonlyMap<string, string> {
  const keys = mintOrderKeys({ lower: null, upper: null, count: options.order.length, random: options.random }) ?? [];
  const changes = new Map<string, string>();
  options.order.forEach((sibling, index) => {
    const key = keys[index];
    if (key !== undefined && key !== sibling.key) changes.set(sibling.id, key);
  });
  return changes;
}

/**
 * A canonical key strictly between `lower` ("" for none) and `upper` that is not a prefix of
 * `upper` and does not end in "0"; null when none exists (see the header).
 */
function keyBetween(options: Readonly<{ lower: string; upper: string | null }>): string | null {
  const { lower, upper } = options;
  if (upper !== null) {
    let shared = 0;
    while (shared < upper.length && (lower[shared] ?? ZERO_DIGIT) === upper[shared]) shared += 1;
    if (shared === upper.length) return null;
    if (shared > 0) {
      const rest = keyBetween({ lower: lower.slice(shared), upper: upper.slice(shared) });
      return rest === null ? null : upper.slice(0, shared) + rest;
    }
  }
  const lowerDigit = lower.length > 0 ? digitValue(lower.charAt(0)) : 0;
  const upperDigit = upper === null ? ORDER_KEY_DIGITS.length : digitValue(upper.charAt(0));
  if (upperDigit - lowerDigit > 1) return ORDER_KEY_DIGITS.charAt(Math.round((lowerDigit + upperDigit) / 2));
  // Adjacent first digits: stay under the lower digit and open the range above the rest of `lower`.
  const rest = keyBetween({ lower: lower.slice(1), upper: null });
  return rest === null ? null : ORDER_KEY_DIGITS.charAt(lowerDigit) + rest;
}

const ZERO_DIGIT = "0";

function digitValue(character: string): number {
  return ORDER_KEY_DIGITS.indexOf(character);
}

/** Random digits; the last is never "0", so the key keeps room below it. */
function randomSuffix(random: RandomSource): string {
  let suffix = "";
  for (let index = 0; index < RANDOM_SUFFIX_LENGTH - 1; index += 1) {
    suffix += ORDER_KEY_DIGITS.charAt(Math.floor(random() * ORDER_KEY_DIGITS.length) % ORDER_KEY_DIGITS.length);
  }
  const nonZeroDigits = ORDER_KEY_DIGITS.length - 1;
  return suffix + ORDER_KEY_DIGITS.charAt(1 + (Math.floor(random() * nonZeroDigits) % nonZeroDigits));
}

/** `count` ascending keys spread evenly between "" and the open end, none ending in "0". */
function spreadKeys(count: number): readonly string[] {
  const base = ORDER_KEY_DIGITS.length;
  let width = 1;
  while (base ** width < count + 1) width += 1;
  const span = base ** width;
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = Math.floor(((index + 1) * span) / (count + 1));
    keys.push(encodeFixedWidth({ value, width }).replace(TRAILING_ZEROS, ""));
  }
  return keys;
}

const TRAILING_ZEROS = /0+$/;

function encodeFixedWidth(options: Readonly<{ value: number; width: number }>): string {
  let remaining = options.value;
  let text = "";
  for (let index = 0; index < options.width; index += 1) {
    text = ORDER_KEY_DIGITS.charAt(remaining % ORDER_KEY_DIGITS.length) + text;
    remaining = Math.floor(remaining / ORDER_KEY_DIGITS.length);
  }
  return text;
}

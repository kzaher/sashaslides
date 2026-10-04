/**
 * key-stream.ts — the one source of randomness in the anonymiser.
 *
 * It is a CURSOR, not a value: `nextBelow` advances. That is deliberate and it is the only mutable
 * thing in the module, because a substitution needs a fresh choice per character while staying a
 * pure function of its inputs. The stream is SHA-256(seed, label) expanded by a counter, so:
 *
 *   - the same `(seed, label)` always yields the same choices — which is what makes the same
 *     original string substitute to the same replacement everywhere it occurs, so a CSS
 *     `[data-tone="warn"]` selector still matches the attribute it was written for;
 *   - a different `label` (the run's own text) yields an unrelated stream, so the substitution is
 *     not a mono-alphabetic cipher that could be broken by frequency analysis;
 *   - without the seed the stream is not predictable, and the seed never enters the report.
 *
 * `seed` is a dependency, injected from the composition root — never read from a global, never
 * defaulted. Tests pass a fixed seed; a real report passes a freshly random one.
 */
import { sha256Bytes, utf8Bytes } from "./sha256.ts";

export type KeyStream = Readonly<{
  /** The next choice in `[0, bound)`. `bound <= 1` always yields 0. */
  nextBelow(bound: number): number;
}>;

export function keyStream({ seed, label }: { seed: string; label: string }): KeyStream {
  // The length prefix keeps ("ab","c") and ("a","bc") apart, so a run's text cannot be made to
  // collide with a different run by moving the boundary between seed and label.
  const root = utf8Bytes(`${seed.length}:${seed}\u0000${label}`);
  let block: readonly number[] = [];
  let offset = 0;
  let counter = 0;

  const nextByte = (): number => {
    if (offset >= block.length) {
      block = sha256Bytes([...root, 0xff, counter & 0xff, (counter >>> 8) & 0xff, (counter >>> 16) & 0xff]);
      counter += 1;
      offset = 0;
    }
    const byte = block[offset] ?? 0;
    offset += 1;
    return byte;
  };

  return {
    nextBelow: (bound) => {
      if (bound <= 1) return 0;
      // Rejection sampling, so the choice is uniform rather than biased towards low indices by the
      // modulo. 24 bits is plenty for the candidate sets here (at most a few thousand).
      const limit = Math.floor(0x1000000 / bound) * bound;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        const draw = (nextByte() << 16) | (nextByte() << 8) | nextByte();
        if (draw < limit) return draw % bound;
      }
      // Unreachable in practice (each attempt rejects with probability < 2^-8 for any realistic
      // bound); falling through to a modulo is a negligible bias, never a throw in a privacy path.
      return ((nextByte() << 16) | (nextByte() << 8) | nextByte()) % bound;
    },
  };
}

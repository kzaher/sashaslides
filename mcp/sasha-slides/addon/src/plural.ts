/** "1 edit", "3 edits": a count and its noun, in agreement. English, regular nouns only. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The value after `flag` on the command line, or null when the flag (or its value) is absent. */
export function argAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? null;
}

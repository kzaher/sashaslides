/** A bounded worker pool, shared by the open-work listing and the comment bot's scans. */

/** `work` over every item, at most `limit` at a time; results keep the input order. */
export async function mapWithConcurrency<TItem, TResult>(
  options: Readonly<{ items: readonly TItem[]; limit: number; work: (item: TItem) => Promise<TResult> }>,
): Promise<TResult[]> {
  const { items, limit, work } = options;
  const results: TResult[] = new Array<TResult>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await work(items[at] as TItem);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

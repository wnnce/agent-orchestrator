/** One page of rows and whether more rows follow it. */
export interface Page<T> {
  readonly items: T[];
  readonly hasMore: boolean;
}

/** Loads one row more than `limit` to tell whether another page follows. */
export async function fetchPage<T>(
  limit: number,
  load: (limit: number) => Promise<T[]>,
): Promise<Page<T>> {
  const rows = await load(limit + 1);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * PostgreSQL's jsonb key order: shorter keys first, by UTF-8 byte length, and
 * keys of one length by their bytes. The configuration was stored in jsonb
 * columns, so this is the order its records were always read back in.
 */
const jsonbKeyCompare = (left: string, right: string): number =>
  Buffer.byteLength(left) - Buffer.byteLength(right) ||
  Buffer.compare(Buffer.from(left), Buffer.from(right));

/** The record rebuilt with its keys in jsonb order. */
export const jsonbKeyOrder = <Value>(
  record: Readonly<Record<string, Value>>,
): Record<string, Value> =>
  Object.fromEntries(
    Object.keys(record)
      .sort(jsonbKeyCompare)
      .map((key) => [key, record[key] as Value]),
  );

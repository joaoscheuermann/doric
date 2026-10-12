/** Move an existing item to another existing position without mutating the list. */
export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): readonly T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  )
    return items;
  const result = [...items];
  result.splice(to, 0, ...result.splice(from, 1));
  return result;
}

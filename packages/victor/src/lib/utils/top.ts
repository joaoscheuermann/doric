/**
 * Retains only the best `limit` candidates using Array.sort comparator order.
 * Callers include their tie-breaker in `compare`; the heap itself is not stable.
 */
export const selectTop = <Data>(
  candidates: Iterable<Data>,
  limit: number,
  compare: (left: Data, right: Data) => number,
): Data[] => {
  if (limit === 0) {
    return [];
  }

  // The worst retained candidate stays at the root.
  const heap: Data[] = [];

  for (const candidate of candidates) {
    if (heap.length < limit) {
      let index = heap.length;
      heap.push(candidate);

      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);

        if (compare(heap[index], heap[parent]) <= 0) {
          break;
        }

        [heap[index], heap[parent]] = [heap[parent], heap[index]];
        index = parent;
      }

      continue;
    }

    if (compare(candidate, heap[0]) >= 0) {
      continue;
    }

    heap[0] = candidate;
    let index = 0;

    while (index * 2 + 1 < heap.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const worse =
        right < heap.length && compare(heap[right], heap[left]) > 0
          ? right
          : left;

      if (compare(heap[index], heap[worse]) >= 0) {
        break;
      }

      [heap[index], heap[worse]] = [heap[worse], heap[index]];
      index = worse;
    }
  }

  return heap.sort(compare);
};

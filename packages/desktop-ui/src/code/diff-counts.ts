/** Exclude Monaco's empty-model and final-newline sentinels, but keep blank lines. */
const contentLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));

const changedLines = (start: number, end: number, total: number): number =>
  end === 0 ? 0 : Math.max(0, Math.min(end, total) - start + 1);

/** Count real lines in Monaco's changed ranges, including empty-file changes. */
export const changedLineCounts = (
  changes: readonly {
    originalStartLineNumber: number;
    originalEndLineNumber: number;
    modifiedStartLineNumber: number;
    modifiedEndLineNumber: number;
  }[],
  original: string,
  modified: string,
): { added: number; removed: number } => {
  const originalLines = contentLines(original);
  const modifiedLines = contentLines(modified);
  return {
    added: changes.reduce(
      (sum, change) =>
        sum +
        changedLines(
          change.modifiedStartLineNumber,
          change.modifiedEndLineNumber,
          modifiedLines,
        ),
      0,
    ),
    removed: changes.reduce(
      (sum, change) =>
        sum +
        changedLines(
          change.originalStartLineNumber,
          change.originalEndLineNumber,
          originalLines,
        ),
      0,
    ),
  };
};

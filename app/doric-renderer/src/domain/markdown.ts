/**
 * The markdown a turn's text carries, read into the blocks the conversation
 * draws — with every character of the source kept.
 *
 * What this module does not do is the point of it: it never rewrites the text. A
 * heading keeps its `#`, a quote keeps its `>`, a fence keeps its backticks and
 * an emphasis keeps its asterisks. What the source says a line *is* decides the
 * block it becomes and the runs it wears, so `# teste` reads inside a heading
 * rather than becoming one, and the text the editor holds is still exactly what
 * the model wrote. A line's runs therefore concatenate back to that line, and the
 * lines of the blocks back to the source between its blank separators — a blank
 * line ends a block rather than being content of it.
 *
 * A list item's own marker is the exception in shape rather than in text: it
 * travels as a `marker` run of its own, because a list draws a marker for every
 * item and would otherwise draw the source's twice. It is still there to be read,
 * and a surface that draws no marker of its own — the prompt, which only styles
 * what the reader types — still shows it.
 *
 * The rules are deliberately the shallow ones a transcript needs, stated here
 * rather than hidden in a component so they can be checked without a DOM: a fence
 * runs to its own closing fence or to the end, a blank line ends a paragraph,
 * consecutive list items of one kind are one list, and an emphasis runs from an
 * opening marker to the next marker of the same kind on the same line. Text the
 * rules do not recognize is a paragraph, which is the one answer that never loses
 * anything.
 */

/** The emphasis one run wears, and the source it wears it over. */
export type MarkdownRun = {
  readonly kind: 'text' | 'marker' | 'bold' | 'italic' | 'strike' | 'code';
  /** The run's own source, markers included, so no character is dropped. */
  readonly source: string;
};

/** One source line as the runs it is made of; their sources join to the line. */
export type MarkdownLine = readonly MarkdownRun[];

/**
 * One block of the source: the kind a reader would name it by, the depth a
 * heading carries, and the lines (or items) it holds, each already run-split.
 */
export type MarkdownBlock =
  | {
      readonly kind: 'paragraph' | 'quote' | 'code';
      readonly lines: readonly MarkdownLine[];
    }
  | {
      readonly kind: 'heading';
      /** How many `#` opened it, from one to six. */
      readonly depth: number;
      readonly lines: readonly MarkdownLine[];
    }
  | {
      readonly kind: 'bullet';
      readonly items: readonly MarkdownItem[];
    }
  | {
      readonly kind: 'ordered';
      readonly items: readonly MarkdownItem[];
    };

/**
 * One item of a list: the lines it runs over. A list item continues over the
 * lines that follow it without a marker of their own — markdown's lazy
 * continuation — which is what keeps a long item's text inside the item instead
 * of dropping it to the column's edge.
 */
export type MarkdownItem = readonly MarkdownLine[];

/** A fence opener: three backticks or three tildes, whatever follows them. */
const fenceOf = (line: string): string | undefined => {
  const match = /^\s*(`{3,}|~{3,})/.exec(line);
  return match?.[1];
};

/** Whether a line closes the fence an opener of this marker started. */
const closesFence = (line: string, fence: string): boolean => {
  const marker = fence[0] ?? '`';
  const match = new RegExp(`^\\s*\\${marker}{${fence.length},}\\s*$`).exec(
    line,
  );
  return match !== null;
};

/** One line as a single plain run, for text no rule reads as anything else. */
const plainLine = (line: string): MarkdownLine => [
  { kind: 'text', source: line },
];

/**
 * The markers an emphasis can wear, longest first so `**` is read before `*`. A
 * marker's own kind is what its run is said to be.
 */
const emphasisMarkers: readonly (readonly [string, MarkdownRun['kind']])[] = [
  ['**', 'bold'],
  ['__', 'bold'],
  ['~~', 'strike'],
  ['`', 'code'],
  ['*', 'italic'],
  ['_', 'italic'],
];

/**
 * One line as the runs it is made of. An open marker takes the text up to the
 * next marker of its own kind on the same line, and keeps both markers in its
 * source; a marker with no closer is a character of the text, like any other.
 *
 * It is the inline half of the rules, so a surface that holds no line structure
 * — the agent's reasoning, which is one flow of prose — can still wear the
 * emphasis the marks ask for without pretending its text has blocks.
 */
export const markdownRuns = (line: string): MarkdownLine => {
  const runs: MarkdownRun[] = [];
  let text = '';
  let index = 0;

  const flush = (): void => {
    if (text.length > 0) runs.push({ kind: 'text', source: text });
    text = '';
  };

  while (index < line.length) {
    const marker = emphasisMarkers.find(([value]) =>
      line.startsWith(value, index),
    );
    const closer =
      marker === undefined
        ? -1
        : line.indexOf(marker[0], index + marker[0].length);

    if (marker === undefined || closer === -1) {
      text += line[index];
      index += 1;
      continue;
    }

    flush();
    const end = closer + marker[0].length;
    runs.push({ kind: marker[1], source: line.slice(index, end) });
    index = end;
  }

  flush();

  return runs.length === 0 ? plainLine(line) : runs;
};

const blank = (line: string): boolean => line.trim() === '';

const bulletLine = /^\s*[-*+]\s/;
const orderedLine = /^\s*\d+[.)]\s/;
const quoteLine = /^\s*>/;
const headingLine = /^(#{1,6})\s/;
const listMarker = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Whether a line opens something of its own — a fence, a heading, a quote or an
 * item — rather than continuing the item above it.
 */
const opensBlock = (line: string): boolean =>
  fenceOf(line) !== undefined ||
  headingLine.test(line) ||
  quoteLine.test(line) ||
  listMarker.test(line);

/**
 * One list item's line: the marker the list draws, then the runs that follow it.
 * The marker stays in the model, so the item still reads as the source wrote it.
 */
const listItemLine = (line: string): MarkdownLine => {
  const marker = listMarker.exec(line);
  if (marker === null) return markdownRuns(line);

  return [
    { kind: 'marker', source: marker[0] },
    ...markdownRuns(line.slice(marker[0].length)),
  ];
};

/**
 * The source read into blocks, in order. Every block is one the source names:
 * a fence, a heading, a quote, a list, or — for anything else — a paragraph,
 * which gathers the lines between blank lines the way a reader reads them.
 */
export const markdownBlocks = (source: string): readonly MarkdownBlock[] => {
  const lines = source.split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: MarkdownLine[] = [];
  let index = 0;

  const endParagraph = (): void => {
    if (paragraph.length > 0)
      blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (blank(line)) {
      endParagraph();
      index += 1;
      continue;
    }

    const fence = fenceOf(line);
    if (fence !== undefined) {
      endParagraph();
      const body: MarkdownLine[] = [plainLine(line)];
      index += 1;
      while (index < lines.length && !closesFence(lines[index] ?? '', fence)) {
        body.push(plainLine(lines[index] ?? ''));
        index += 1;
      }
      if (index < lines.length) {
        body.push(plainLine(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'code', lines: body });
      continue;
    }

    const heading = headingLine.exec(line);
    if (heading !== null) {
      endParagraph();
      blocks.push({
        kind: 'heading',
        depth: (heading[1] ?? '#').length,
        lines: [markdownRuns(line)],
      });
      index += 1;
      continue;
    }

    if (quoteLine.test(line)) {
      endParagraph();
      const body: MarkdownLine[] = [];
      while (index < lines.length && quoteLine.test(lines[index] ?? '')) {
        body.push(markdownRuns(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    const ordered = orderedLine.test(line);
    if (ordered || bulletLine.test(line)) {
      endParagraph();
      const items: MarkdownItem[] = [];
      const opensItem = (candidate: string): boolean =>
        ordered ? orderedLine.test(candidate) : bulletLine.test(candidate);

      while (index < lines.length && opensItem(lines[index] ?? '')) {
        const item: MarkdownLine[] = [listItemLine(lines[index] ?? '')];
        index += 1;
        // A line that opens nothing of its own continues this item, the way a
        // reader reads it: a wrapped item is still one item.
        while (index < lines.length) {
          const candidate = lines[index] ?? '';
          if (blank(candidate) || opensBlock(candidate)) break;
          item.push(markdownRuns(candidate));
          index += 1;
        }
        items.push(item);
      }

      blocks.push({ kind: ordered ? 'ordered' : 'bullet', items });
      continue;
    }

    paragraph.push(markdownRuns(line));
    index += 1;
  }

  endParagraph();

  return blocks;
};

/** The source one line's runs join back to. */
export const lineSource = (line: MarkdownLine): string =>
  line.map((run) => run.source).join('');

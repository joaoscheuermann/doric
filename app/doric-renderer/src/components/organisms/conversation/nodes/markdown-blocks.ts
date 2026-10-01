/**
 * The markdown a turn's text carries, drawn as the editor's own nodes.
 *
 * Every node here is filled with the source the reader would recognize: the
 * heading holds `# teste`, the item holds `- one`, the fence holds its backticks,
 * and an emphasis holds its asterisks. Only what a node *is* changes — the block
 * it becomes and the format a run wears — so the theme's classes style markdown
 * the reader can still read as markdown, and `getTextContent` still answers with
 * the words the model wrote. The rules that decide all this live in
 * `domain/markdown`, apart from any editor.
 *
 * A table is the block whose shape is a grid: its rows are rows of cells, each
 * cell a paragraph holding the cell's own runs, so the caret crosses the table
 * like any other text and a cell reads as the source wrote it. The pipes it was
 * written with travel as `marker` runs, which no cell draws.
 */
import {
  lineSource,
  type MarkdownAlign,
  type MarkdownBlock,
  markdownBlocks,
  type MarkdownCell,
  type MarkdownLine,
  type MarkdownRun,
} from '@/domain/markdown';
import { $createCodeNode } from '@lexical/code';
import { $createListItemNode, $createListNode } from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  type HeadingTagType,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellHeaderStates,
  type TableCellNode,
  type TableNode,
} from '@lexical/table';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  type ElementFormatType,
  type ElementNode,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';

/** The format a run wears; `text` wears none, which is what plain text is. */
const runFormats: Readonly<
  Record<MarkdownRun['kind'], TextFormatType | undefined>
> = {
  text: undefined,
  marker: undefined,
  bold: 'bold',
  italic: 'italic',
  strike: 'strikethrough',
  code: 'code',
};

const $appendLine = (node: ElementNode, line: MarkdownLine): void => {
  for (const run of line) {
    // A marker the node draws itself — a list item's bullet or number — is not
    // drawn again from the source; every other run reads as it was written.
    if (run.kind === 'marker') continue;

    const text = $createTextNode(run.source);
    const format = runFormats[run.kind];

    node.append(format === undefined ? text : text.setFormat(format));
  }
};

/**
 * The lines of one block, with the source's own line breaks between them: a
 * paragraph the source soft-wrapped reads as the lines it was written in.
 */
const $appendLines = (
  node: ElementNode,
  lines: readonly MarkdownLine[],
): void => {
  lines.forEach((line, index) => {
    if (index > 0) node.append($createLineBreakNode());
    $appendLine(node, line);
  });
};

/** The paragraph format an aligned column's cells wear; `undefined` is none. */
const alignFormats: Readonly<Record<MarkdownAlign, ElementFormatType>> = {
  left: 'left',
  center: 'center',
  right: 'right',
};

/**
 * One table cell: the runs it holds inside the paragraph every cell carries, the
 * paragraph aligned as the column asked. The cell's markers are not drawn here,
 * the way a list's are not — the grid stands in for them.
 */
const $cellNode = (
  cell: MarkdownCell,
  header: boolean,
  align: MarkdownAlign | undefined,
): TableCellNode => {
  const node = $createTableCellNode(
    header ? TableCellHeaderStates.ROW : TableCellHeaderStates.NO_STATUS,
  );
  const paragraph = $createParagraphNode();
  $appendLine(paragraph, cell);
  if (align !== undefined) paragraph.setFormat(alignFormats[align]);
  node.append(paragraph);
  return node;
};

/** One table's rows and cells, the header row first, as the editor's own nodes. */
const $tableNode = (
  block: Extract<MarkdownBlock, { readonly kind: 'table' }>,
): TableNode => {
  const table = $createTableNode();
  const headerRow = $createTableRowNode();
  block.header.forEach((cell, column) => {
    headerRow.append($cellNode(cell, true, block.align[column]));
  });
  table.append(headerRow);

  for (const row of block.rows) {
    const rowNode = $createTableRowNode();
    row.forEach((cell, column) => {
      rowNode.append($cellNode(cell, false, block.align[column]));
    });
    table.append(rowNode);
  }

  return table;
};

/** The node one block becomes, filled with the block's own source. */
const $blockNode = (block: MarkdownBlock): LexicalNode => {
  switch (block.kind) {
    case 'heading': {
      const heading = $createHeadingNode(`h${block.depth}` as HeadingTagType);
      $appendLines(heading, block.lines);
      return heading;
    }
    case 'quote': {
      const quote = $createQuoteNode();
      $appendLines(quote, block.lines);
      return quote;
    }
    case 'code': {
      const code = $createCodeNode();
      // The fence is one preformatted run: its lines are already broken, and
      // `getTextContent` answers them back with the fence the reader sees.
      code.append($createTextNode(block.lines.map(lineSource).join('\n')));
      return code;
    }
    case 'bullet':
    case 'ordered': {
      const list = $createListNode(
        block.kind === 'bullet' ? 'bullet' : 'number',
      );
      for (const item of block.items) {
        const entry = $createListItemNode();
        // The item's lines inside the item: a wrapped one keeps its place under
        // the item's own text rather than falling back to the column's edge.
        $appendLines(entry, item);
        list.append(entry);
      }
      return list;
    }
    case 'paragraph': {
      const paragraph = $createParagraphNode();
      $appendLines(paragraph, block.lines);
      return paragraph;
    }
    case 'table': {
      return $tableNode(block);
    }
  }
};

/**
 * Fills one block with the markdown its source carries, clearing whatever it
 * held. The source is read, never rewritten: what lands is the text the caller
 * passed, arranged as the markdown says it should be.
 */
export const $appendMarkdown = (parent: ElementNode, source: string): void => {
  for (const block of markdownBlocks(source)) parent.append($blockNode(block));
};

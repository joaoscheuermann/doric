/**
 * Where an arrow key or Tab lands inside a table.
 *
 * A table is the editor's own nodes — rows of cells, each a paragraph — so the
 * caret crosses it like any other text and the read-only rule that already holds
 * a turn refuses edits inside it. What the editor does not wire by itself is where
 * an arrow key moves next or how Tab steps from cell to cell; `@lexical/table`
 * keeps those in the registrations its extension would install. The conversation
 * registers the table's nodes itself (`index.tsx`) rather than through that
 * extension, because the extension also configures the HTML import the surface
 * already configures its own way — so the two behaviors are installed here.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  registerTablePlugin,
  registerTableSelectionObserver,
} from '@lexical/table';
import { mergeRegister } from 'lexical';
import { useEffect } from 'react';

export function TableBlocksPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      mergeRegister(
        registerTablePlugin(editor),
        registerTableSelectionObserver(editor),
      ),
    [editor],
  );

  return null;
}

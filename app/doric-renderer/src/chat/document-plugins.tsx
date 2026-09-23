import { $convertToMarkdownString } from '@lexical/markdown';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  DROP_COMMAND,
  FORMAT_TEXT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  PASTE_COMMAND,
  REMOVE_TEXT_COMMAND,
} from 'lexical';
import { useEffect, useRef } from 'react';

import { caretAtLineEdge, caretAtOffsetEdge } from './caret';
import { commentHighlights } from './comment-highlight';
import { $createCommentNode, $isCommentNode } from './comment-node';
import type { CaretEdge, CaretKey, Comment, CommentAnchor } from './editing';
import { documentSyncTag, markdownOf, transformers } from './markdown-document';
import { domRange, selectionAnchor } from './selection';
import { shouldSubmit } from './shortcuts';

/** What a document's caller can observe or answer. */
export type DocumentHandlers = {
  readonly onChange?: (markdown: string) => void;
  readonly onSubmit?: (markdown: string) => Promise<boolean>;
  readonly onType?: (
    text: string,
    anchor: CommentAnchor | undefined,
    block: number,
  ) => void;
  readonly onBackspace?: () => void;
  readonly onRemoveComment?: (id: string) => void;
  readonly onNavigate?: (key: CaretKey) => boolean;
};

/**
 * The index of the rendered block the caret is in, counted over the content
 * blocks only. It reads the DOM rather than the editor state, because a command
 * handler has no committed state to read.
 */
const blockIndexOf = (element: HTMLElement | null): number => {
  if (element === null) return Number.MAX_SAFE_INTEGER;
  const selection = window.getSelection();
  const node =
    selection !== null && selection.rangeCount > 0
      ? selection.getRangeAt(0).startContainer
      : null;
  const blocks = Array.from(element.children).filter(
    (child) =>
      !(
        child instanceof HTMLElement &&
        child.querySelector('[data-comment-block]') !== null
      ),
  );
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (current !== null && current !== element) {
    const index = blocks.indexOf(current);
    if (index >= 0) return index;
    current = current.parentElement;
  }
  return Number.MAX_SAFE_INTEGER;
};

/** The element Lexical renders the document into. */
const rootElement = (editor: LexicalEditor): HTMLElement | null =>
  editor.getRootElement();

/** Places the caret at the document's start or end. */
export function CaretPlugin({ focusEdge }: { readonly focusEdge?: CaretEdge }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (focusEdge === undefined) return;
    // A frame later, so the editability change of this same commit has already
    // reached the DOM. The selection is forced in its own update: `focus`'s
    // callback runs after the update commits, where Lexical helpers are gone.
    const frame = requestAnimationFrame(() => {
      // `editor.focus()` only marks the selection dirty; it does not focus the
      // root element. Move the DOM focus there first: the destination may still
      // be `contenteditable="false"`, which Chrome never focuses on its own,
      // while a root element with `tabindex="-1"` takes focus either way. The
      // destination must own the focus before the selection is placed, or
      // `$updateDOMSelection` re-asserts the selection of the editor that does.
      rootElement(editor)?.focus({ preventScroll: true });
      editor.focus();
      editor.update(
        () => {
          const root = $getRoot();
          if (focusEdge === 'start') root.selectStart();
          else root.selectEnd();
        },
        { tag: documentSyncTag },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, focusEdge]);

  return null;
}

/**
 * The surface is editable in both modes: a read node needs a real caret to be
 * navigable and selectable, and `ReadPlugin` is what stops it from changing.
 */
export function EditabilityPlugin({
  editable,
}: {
  readonly editable: boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return null;
}

/**
 * The handlers a caller passes are a fresh object on every render, so the
 * plugins keep the latest one in a ref: command registration and listener
 * subscriptions must not be torn down while the reader is selecting or typing,
 * which is exactly when they matter.
 */
const useLatestHandlers = (handlers: DocumentHandlers) => {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  return latest;
};

/** Change reporting, submission and the arrow hand-off. */
export function WritePlugin({
  handlers,
  platform,
}: {
  readonly handlers: DocumentHandlers;
  readonly platform: string;
}) {
  const [editor] = useLexicalComposerContext();
  const latest = useLatestHandlers(handlers);

  useEffect(() => {
    if (latest.current.onChange === undefined) return;
    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has(documentSyncTag)) return;
      // The state handed to a listener is the one to read: calling back into the
      // editor here would try to commit an update from inside a commit.
      latest.current.onChange?.(
        editorState.read(() => $convertToMarkdownString(transformers)),
      );
    });
  }, [editor, latest]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (
          latest.current.onSubmit !== undefined &&
          shouldSubmit(event, platform)
        ) {
          event.preventDefault();
          void latest.current.onSubmit(markdownOf(editor));
          return true;
        }
        const key = event.key;
        if (
          key !== 'ArrowLeft' &&
          key !== 'ArrowRight' &&
          key !== 'ArrowUp' &&
          key !== 'ArrowDown'
        ) {
          return false;
        }
        const element = rootElement(editor);
        const atEdge =
          key === 'ArrowUp' || key === 'ArrowDown'
            ? caretAtLineEdge(element, key)
            : caretAtOffsetEdge(element, key);
        if (atEdge && latest.current.onNavigate?.(key) === true) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, latest, platform]);

  return null;
}

/** Mutation blocking, comment typing, comment islands and their markers. */
export function ReadPlugin({
  comments,
  handlers,
}: {
  readonly comments: readonly Comment[];
  readonly handlers: DocumentHandlers;
}) {
  const [editor] = useLexicalComposerContext();
  const latest = useLatestHandlers(handlers);

  useEffect(() => {
    const type = (value: string | undefined) => {
      if (value === undefined || value.length === 0) return;
      const element = rootElement(editor);
      latest.current.onType?.(
        value,
        selectionAnchor(element),
        blockIndexOf(element),
      );
    };
    const offs = [
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      // The rest of the commands that can rewrite the document. Blocking them
      // is what "the answer never mutates" means here: Lexical dispatches
      // these from its own paths — a `beforeinput` that follows a keydown, a
      // formatting shortcut, a programmatic call — not only from the keys
      // handled below, so the keydown handlers alone are not enough.
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DELETE_WORD_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DELETE_LINE_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        REMOVE_TEXT_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        FORMAT_TEXT_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        INSERT_LINE_BREAK_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event: KeyboardEvent) => {
          // Stop the browser's native edit before it starts: an unhandled
          // keydown still fires `beforeinput`, and Lexical answers that by
          // dispatching DELETE_CHARACTER_COMMAND, deleting the answer through
          // a command other than this one.
          event.preventDefault();
          latest.current.onBackspace?.();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        (event: KeyboardEvent) => {
          event.preventDefault();
          latest.current.onBackspace?.();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(DROP_COMMAND, () => true, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if ('clipboardData' in event) {
            type(event.clipboardData?.getData('text/plain') ?? undefined);
          }
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        (payload: string | InputEvent) => {
          type(
            typeof payload === 'string' ? payload : (payload.data ?? undefined),
          );
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event: KeyboardEvent) => {
          const key = event.key;
          if (key.length === 1 && !event.metaKey && !event.ctrlKey) {
            // Consumed here, so the browser must not also insert it: the answer
            // stays untouched and the character belongs to the comment.
            event.preventDefault();
            type(key);
            return true;
          }
          if (
            key !== 'ArrowLeft' &&
            key !== 'ArrowRight' &&
            key !== 'ArrowUp' &&
            key !== 'ArrowDown'
          ) {
            return false;
          }
          const element = rootElement(editor);
          const atEdge =
            key === 'ArrowUp' || key === 'ArrowDown'
              ? caretAtLineEdge(element, key)
              : caretAtOffsetEdge(element, key);
          if (atEdge && latest.current.onNavigate?.(key) === true) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [editor, latest]);

  // One island per comment, right under the block it is about.
  useEffect(() => {
    editor.update(
      () => {
        const root = $getRoot();
        for (const child of root.getChildren()) {
          if ($isCommentNode(child)) child.remove();
        }
        const blocks = root
          .getChildren()
          .filter((node: LexicalNode) => !$isCommentNode(node));
        for (const comment of comments) {
          const target = blocks[Math.min(comment.block, blocks.length - 1)];
          if (target === undefined) continue;
          target.insertAfter(
            $createCommentNode(comment, (id) =>
              latest.current.onRemoveComment?.(id),
            ),
          );
        }
      },
      { tag: documentSyncTag },
    );
  }, [editor, comments, latest]);

  // The quoted excerpt keeps a marker that never touches the answer text. This
  // document publishes its ranges into the shared registry, which merges them
  // with every other mounted document's under the one styled highlight name.
  useEffect(() => {
    const element = rootElement(editor);
    const highlights = commentHighlights();
    if (element === null || highlights === undefined) return;
    const ranges: Range[] = [];
    for (const comment of comments) {
      const anchor = comment.anchor;
      if (anchor === undefined) continue;
      const range = domRange(element, anchor.start, anchor.end);
      if (range === undefined) continue;
      ranges.push(range);
    }
    highlights.set(editor, ranges);
    return () => highlights.clear(editor);
  }, [editor, comments]);

  return null;
}

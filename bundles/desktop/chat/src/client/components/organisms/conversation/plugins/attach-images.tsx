/**
 * An image the reader pastes or drops into the prompt becomes an attachment of
 * the Thread's Project, then a line of the prompt of its own: the image node,
 * whose text is the reference the prompt sends. The bytes go to the host
 * first, so the line only ever names an image the Project holds.
 *
 * Only a paste whose selection lies inside the prompt, or a drop on the
 * editor, is answered for; text keeps its own paste (`paste-into-prompt`).
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { toast } from 'desktop/ui/sonner';
import {
  $createLineBreakNode,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  PASTE_COMMAND,
  type PasteCommandType,
  type RangeSelection,
} from 'lexical';
import { useEffect } from 'react';

import { attachmentsApi } from '../../../../api/attachments-api.js';
import {
  $createAttachmentImageNode,
  $isAttachmentImageNode,
} from '../nodes/attachment-image-node.js';
import { $getUserPromptNode } from '../nodes/user-prompt-node.js';
import { $inPrompt } from './paste-into-prompt.js';

/** The image files a transfer carries, in order. */
const imagesOf = (transfer: DataTransfer | null): readonly File[] =>
  [...(transfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));

/** Whether a node ends a line, so what follows it starts one. */
const endsLine = (node: LexicalNode | null): boolean =>
  node === null || $isLineBreakNode(node) || $isAttachmentImageNode(node);

/** Whether the caret stands where a line of the prompt starts. */
const $atLineStart = (selection: RangeSelection): boolean => {
  const anchor = selection.anchor.getNode();
  if ($isTextNode(anchor))
    return (
      selection.anchor.offset === 0 && endsLine(anchor.getPreviousSibling())
    );
  const before = anchor.getChildAtIndex?.(selection.anchor.offset - 1) ?? null;
  return selection.anchor.offset === 0 || endsLine(before);
};

/**
 * Puts the image on a line of its own where the caret is, or at the end of the
 * prompt when the caret has left it, and leaves the caret on the line after.
 */
const $insertImage = (name: string, id: string): void => {
  const prompt = $getUserPromptNode();
  if (prompt === undefined) return;
  const image = $createAttachmentImageNode(name, id);
  const selection = $getSelection();
  if ($isRangeSelection(selection) && $inPrompt()) {
    selection.insertNodes([
      ...($atLineStart(selection) ? [] : [$createLineBreakNode()]),
      image,
      $createLineBreakNode(),
    ]);
    return;
  }
  if (!endsLine(prompt.getLastChild())) prompt.append($createLineBreakNode());
  prompt.append(image, $createLineBreakNode());
  prompt.selectEnd();
};

/** Attaches each file in order, then writes its line; a refusal is a toast. */
const attach = async (
  editor: LexicalEditor,
  threadId: string,
  files: readonly File[],
): Promise<void> => {
  for (const file of files) {
    const name = file.name === '' ? 'image' : file.name;
    try {
      const attached = await attachmentsApi.attach(threadId, file, name);
      editor.update(() => $insertImage(attached.name, attached.id));
    } catch (error) {
      toast.error(
        `${name} could not be attached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

export function AttachImages({ threadId }: { readonly threadId: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          PASTE_COMMAND,
          (event: PasteCommandType) => {
            const transfer =
              'clipboardData' in event ? event.clipboardData : null;
            const files = imagesOf(transfer);
            if (files.length === 0 || !$inPrompt()) return false;
            event.preventDefault();
            void attach(editor, threadId, files);
            return true;
          },
          COMMAND_PRIORITY_CRITICAL,
        ),
        editor.registerCommand(
          DRAGOVER_COMMAND,
          (event: DragEvent) => {
            if (![...(event.dataTransfer?.types ?? [])].includes('Files'))
              return false;
            event.preventDefault();
            return true;
          },
          COMMAND_PRIORITY_CRITICAL,
        ),
        editor.registerCommand(
          DROP_COMMAND,
          (event: DragEvent) => {
            const files = imagesOf(event.dataTransfer);
            if (files.length === 0) return false;
            event.preventDefault();
            void attach(editor, threadId, files);
            return true;
          },
          COMMAND_PRIORITY_CRITICAL,
        ),
      ),
    [editor, threadId],
  );

  return null;
}

import { $getUserPromptNode } from '@/components/organisms/conversation/nodes/user-prompt-node';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from 'lexical';
import { useEffect } from 'react';

/**
 * Puts the reader's words back into the prompt, when a send was refused — but
 * only while the prompt is empty, so it never collides with typing that
 * continued after the send.
 */
const $restore = (text: string): void => {
  const prompt = $getUserPromptNode();
  if (prompt === undefined || prompt.getTextContent().length > 0) return;
  prompt.append($createTextNode(text));
};

/**
 * Sends the reader's prompt on Cmd/Ctrl+Enter, wherever the caret happens to be:
 * the words are read from the document, because the prompt block is what holds
 * them. The prompt is emptied as the send leaves, so the transcript shows the
 * turn the host accepted rather than a copy still in the input; a send the host
 * refuses puts the words back.
 */
export function SendPrompt({
  send,
}: {
  /** Sends the words, and reports whether the host accepted them. */
  readonly send: (text: string) => Promise<boolean>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null || !(event.metaKey || event.ctrlKey)) return false;

          // A modified Enter is a command, never a line: it is answered here
          // whether or not the prompt holds words to send.
          event.preventDefault();

          const prompt = $getUserPromptNode();
          const text = prompt?.getTextContent().trim() ?? '';
          if (prompt === undefined || text.length === 0) return true;

          prompt.clear();
          void send(text).then((accepted) => {
            if (!accepted) editor.update(() => $restore(text));
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, send],
  );

  return null;
}

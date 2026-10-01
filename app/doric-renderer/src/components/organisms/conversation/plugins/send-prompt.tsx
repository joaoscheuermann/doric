import { $getUserPromptNode } from '@/components/organisms/conversation/nodes/user-prompt-node';
import { type PromptSignal } from '@/utility/prompt-signal';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
} from 'lexical';
import { useCallback, useEffect, useRef } from 'react';

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

/** What the composer's plugin needs from its surface. */
type SendPromptProps = {
  /** Sends the words, and reports whether the host accepted them. */
  readonly send: (text: string) => Promise<boolean>;
  /**
   * The shell's own send request, counted. It changes when the control outside
   * the editor is clicked, and the plugin answers each new count once.
   */
  readonly sendRequest?: number;
  /** Where the editor writes whether the prompt holds words, for the shell. */
  readonly promptSignal?: PromptSignal;
  /**
   * Whether a prompt is running. Escape stops the run instead of blurring the
   * editor while one is, because a reader who presses it mid-answer means the
   * answer, not the focus.
   */
  readonly canStop?: boolean;
  readonly onStop?: () => void;
};

/**
 * The composer's own plugin: what a reader sends with, and what they stop with.
 *
 * Sending reads the words from the document, because the prompt block is what
 * holds them — Cmd/Ctrl+Enter wherever the caret is, and the `sendRequest` the
 * shell changes when its own control is clicked. The prompt is emptied as the
 * send leaves, so the transcript shows the turn the host accepted rather than a
 * copy still in the input; a send the host refuses puts the words back.
 *
 * `sendRequest` is a value and not a callback because the shell cannot reach the
 * editor: it counts requests, this plugin answers the ones it has not seen, and
 * nothing travels the other way. A child that reports to its parent has to write
 * state during the parent's commit, which is what a render loop is made of.
 */
export function SendPrompt({
  canStop = false,
  onStop,
  promptSignal,
  send,
  sendRequest,
}: SendPromptProps) {
  const [editor] = useLexicalComposerContext();
  /**
   * The request this plugin last answered, seeded with the one it mounted under:
   * a surface that opens under a count higher than zero has already answered it,
   * because the count belongs to the shell, which outlives the conversation.
   */
  const answered = useRef(sendRequest);
  /** The send the shell's control calls, kept current without a render. */
  const latest = useRef(send);
  latest.current = send;

  /**
   * Whether the prompt holds words, which the shell draws its control from. It
   * is written through and not rendered here: the value belongs to the shell.
   */
  const $promptHasWords = useCallback(
    (): boolean => $getUserPromptNode()?.getTextContent().trim().length !== 0,
    [],
  );

  useEffect(
    () =>
      editor.registerUpdateListener(() => {
        const held = editor.getEditorState().read($promptHasWords);

        // Read in the update, told after it. A shell reading an external value
        // renders synchronously when it is told, and a render in the middle of
        // the editor's own reconcile is a render over DOM the editor is still
        // writing — which is what moves a reader's caret and scroll. A microtask
        // runs once the update has returned, so the two never overlap.
        queueMicrotask(() => promptSignal?.set(held));
      }),
    [editor, promptSignal, $promptHasWords],
  );


  // The prompt a surface opens on may already hold words — a refused send puts
  // them back, a rewind draws them — so the value is stated once on the way in
  // rather than waiting for the next keystroke.
  useEffect(() => {
    promptSignal?.set(editor.getEditorState().read($promptHasWords));
  }, [editor, promptSignal, $promptHasWords]);

  const sendNow = useCallback((): void => {
    let text = '';
    editor.read(() => {
      text = $getUserPromptNode()?.getTextContent().trim() ?? '';
    });
    if (text.length === 0) return;

    editor.update(() => {
      const prompt = $getUserPromptNode();
      if (prompt === undefined || prompt.getTextContent().trim() !== text)
        return;
      prompt.clear();
    });
    void latest.current(text).then((accepted) => {
      if (!accepted) editor.update(() => $restore(text));
    });
  }, [editor]);

  useEffect(() => {
    if (sendRequest === undefined || answered.current === sendRequest) return;
    answered.current = sendRequest;
    sendNow();
  }, [sendNow, sendRequest]);

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event === null || !(event.metaKey || event.ctrlKey)) return false;

          // A modified Enter is a command, never a line: it is answered here
          // whether or not the prompt holds words to send.
          event.preventDefault();
          sendNow();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, sendNow],
  );

  useEffect(
    () =>
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (!canStop) return false;
          onStop?.();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [canStop, editor, onStop],
  );

  return null;
}

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from 'lexical';
import { useCallback, useEffect, useRef } from 'react';

import type { ComposerItem } from '../../../../../contracts/index.js';
import { promptEnvelope } from '../../../../domain/prompt-envelope.js';
import { composerStackStore } from '../../../../stores/composer-stack.js';
import { queueEditStore } from '../../../../stores/queue-edit.js';
import type { PromptSignal } from '../../../../utility/prompt-signal.js';
import { SAVE_QUEUE_EDIT_COMMAND, SEND_PROMPT_COMMAND } from '../commands.js';
import { $appendPromptText } from '../nodes/attachment-image-node.js';
import { $getUserPromptNode } from '../nodes/user-prompt-node.js';

/**
 * Puts the reader's words back into the prompt, when a send was refused — but
 * only while the prompt is empty, so it never collides with typing that
 * continued after the send. Shared with the composer's own draft sync, which
 * restores the words the service's portrait holds when a Thread opens empty.
 */
export const $restore = (text: string): void => {
  const prompt = $getUserPromptNode();
  if (prompt === undefined || prompt.getTextContent().length > 0) return;
  $appendPromptText(prompt, text);
};

/** What the composer's plugin needs from its surface. */
type SendPromptProps = {
  /** Sends the words, and reports whether the host accepted them. */
  readonly send: (text: string) => Promise<boolean>;
  /**
   * Steers the running prompt with the words; `interrupt` also aborts its
   * current step. Without it, a send while running queues the words.
   */
  readonly steer?: (text: string, interrupt: boolean) => Promise<boolean>;
  /** Resumes waiting work when the input is empty and dispatch is available. */
  readonly onResumeQueue?: () => void;
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
 * How a send reaches the Thread while a prompt runs: `send` steers it (and
 * sends a prompt when nothing runs), `queue` waits for the run to end, and
 * `redirect` steers it after aborting its current step.
 */
type SendMode = 'send' | 'queue' | 'redirect';

/** Whether the reader has selected something Ctrl+C would copy. */
const $hasSelection = (): boolean => {
  const selection = $getSelection();
  if (selection !== null && !$isRangeSelection(selection)) return true;
  if (selection !== null && !selection.isCollapsed()) return true;
  return (globalThis.getSelection?.()?.toString() ?? '').length > 0;
};

/**
 * The composer's own plugin: what a reader sends with, and what they stop with.
 *
 * Sending reads the words from the document, because the prompt block is what
 * holds them — Cmd/Ctrl+Enter wherever the caret is, and the `sendRequest` the
 * shell changes when its own control is clicked. While a prompt runs the keys
 * control it: Cmd/Ctrl+Enter steers it at its next safe point, Tab queues the
 * words for after it, Escape with words aborts its current step and steers it,
 * and Escape without words or Ctrl+C with nothing selected stops it. The prompt is emptied as the
 * send leaves, so the transcript shows the turn the host accepted rather than a
 * copy still in the input; a send the host refuses puts the words back.
 *
 * The comment stack counts too. Every send is the prompt envelope — the
 * stack's comments with their targets and anchors in `<comments>`, the
 * reader's words in `<message>` — because the prompt is the only thing the
 * agent reads; and a send with an empty editor still goes out when the stack
 * carries words, because a comment alone is already something to send. A refused send restores only the reader's
 * words, never the ones the stack composed: they stay in the stack, which is
 * where they still are.
 *
 * `sendRequest` is a value and not a callback because the shell cannot reach the
 * editor: it counts requests, this plugin answers the ones it has not seen, and
 * nothing travels the other way. A child that reports to its parent has to write
 * state during the parent's commit, which is what a render loop is made of.
 */
export function SendPrompt({
  canStop = false,
  onStop,
  onResumeQueue,
  promptSignal,
  send,
  steer,
  sendRequest,
  threadId,
}: SendPromptProps & { readonly threadId: string }) {
  const [editor] = useLexicalComposerContext();
  /**
   * The request this plugin last answered, seeded with the one it mounted under:
   * a surface that opens under a count higher than zero has already answered it,
   * because the count belongs to the shell, which outlives the conversation.
   */
  const answered = useRef(sendRequest);
  /** The send the shell's control calls, kept current without a render. */
  const latest = useRef({ send, steer, onResumeQueue, canStop });
  latest.current = { send, steer, onResumeQueue, canStop };

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

  /** Where one send goes: a steer while a prompt runs, unless it queues. */
  const deliver = useCallback(
    (prompt: string, mode: SendMode): Promise<boolean> => {
      const current = latest.current;
      return mode === 'queue' || !current.canStop || current.steer === undefined
        ? current.send(prompt)
        : current.steer(prompt, mode === 'redirect');
    },
    [],
  );

  /** Sends what the reader wrote; answers whether there was anything to send. */
  const sendNow = useCallback(
    (mode: SendMode = 'send'): boolean => {
      // Saving a queued prompt's edit is the send's job alone; the run's own
      // keys never touch the edit.
      if (mode !== 'send' && queueEditStore.getState().edits[threadId])
        return false;
      if (
        mode === 'send' &&
        editor.dispatchCommand(SAVE_QUEUE_EDIT_COMMAND, undefined)
      )
        return true;
      let words = '';
      editor.read(() => {
        words = $getUserPromptNode()?.getTextContent().trim() ?? '';
      });
      // The stack's comments travel with every send: the prompt is the only
      // thing the agent reads, so the anchors go in it with the reader's words.
      const stack: readonly ComposerItem[] = composerStackStore
        .getState()
        .stack(threadId);
      const prompt = promptEnvelope(words, stack);

      if (words.length === 0) {
        // The stack carries words of its own — a comment alone is already
        // something to send. Only a stack with nothing written waits for the
        // queue instead.
        if (prompt.length > 0) {
          void deliver(prompt, mode);
          return true;
        }

        if (mode !== 'send') return false;
        latest.current.onResumeQueue?.();
        return true;
      }

      editor.update(() => {
        const prompt = $getUserPromptNode();
        if (prompt === undefined || prompt.getTextContent().trim() !== words)
          return;
        prompt.clear();
      });
      void deliver(prompt, mode).then((accepted) => {
        // A refused send gives the reader's own words back; the ones the stack
        // composed were never in the editor, and the stack still holds them.
        if (!accepted) editor.update(() => $restore(words));
      });
      return true;
    },
    [deliver, editor, threadId],
  );

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
          if (!event.repeat) sendNow();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, sendNow],
  );

  // A stack note's own Cmd/Ctrl+Enter: the note is an editing host of its own,
  // so its keys never reach the editor's, and it asks for the send instead.
  useEffect(
    () =>
      editor.registerCommand(
        SEND_PROMPT_COMMAND,
        () => {
          sendNow();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor, sendNow],
  );

  // Tab queues the words for after the running prompt; with nothing to send,
  // or nothing running, it moves the focus as it always does.
  useEffect(
    () =>
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          if (!canStop || event.shiftKey) return false;
          if (!sendNow('queue')) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [canStop, editor, sendNow],
  );

  // Escape with words aborts the running step and steers it with them; without
  // words it stops the run.
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (!canStop) return false;
          if (!sendNow('redirect')) onStop?.();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [canStop, editor, onStop, sendNow],
  );

  // Ctrl+C stops the run when there is nothing selected to copy.
  useEffect(
    () =>
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          if (
            !canStop ||
            !event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.shiftKey ||
            event.key.toLowerCase() !== 'c' ||
            editor.getEditorState().read($hasSelection)
          )
            return false;
          event.preventDefault();
          if (!event.repeat) onStop?.();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [canStop, editor, onStop],
  );

  return null;
}

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'desktop/ui/sonner';
import {
  $createTextNode,
  $parseSerializedNode,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ESCAPE_COMMAND,
  mergeRegister,
  type SerializedElementNode,
} from 'lexical';
import { useEffect, useRef } from 'react';

import { threadsApi } from '../../../../api/threads-api.js';
import { USER_PROMPT_BLOCK } from '../../../../domain/conversation-nodes.js';
import { messageFrom } from '../../../../domain/errors.js';
import {
  promptMessage,
  promptSummary,
  withPromptMessage,
} from '../../../../domain/prompt-envelope.js';
import { queryKeys } from '../../../../queries/keys.js';
import { queueEditStore } from '../../../../stores/queue-edit.js';
import {
  EDIT_QUEUE_PROMPT_COMMAND,
  SAVE_QUEUE_EDIT_COMMAND,
} from '../commands.js';
import { $getUserPromptNode } from '../nodes/user-prompt-node.js';

/** Reuses the composer without letting saving, streaming or switching Threads consume its draft. */
export function EditQueuePrompt({ threadId }: { readonly threadId: string }) {
  const [editor] = useLexicalComposerContext();
  const client = useQueryClient();
  const generation = useRef(0);
  useEffect(() => {
    let mounted = true;
    const current = () => queueEditStore.getState().edits[threadId];
    const root = editor.getRootElement();
    const decorate = () =>
      root?.toggleAttribute('data-queue-editing', current() !== undefined);
    decorate();
    const setText = (text: string) => {
      editor.update(() => {
        const prompt = $getUserPromptNode();
        if (prompt === undefined) return;
        prompt.clear().append($createTextNode(text));
        prompt.selectEnd();
      });
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    };
    const restore = () => {
      const edit = current();
      if (edit === undefined) return;
      queueEditStore.getState().set(threadId, undefined);
      decorate();
      if (!mounted) return;
      editor.update(() => {
        const prompt = $getUserPromptNode();
        if (prompt === undefined) return;
        prompt.clear();
        for (const child of edit.draft.children)
          prompt.append($parseSerializedNode(child));
        prompt
          .setFormat(edit.draft.format)
          .setIndent(edit.draft.indent)
          .setDirection(edit.draft.direction);
        prompt.selectEnd();
      });
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    };
    const existing = current();
    if (existing?.restore) restore();
    else if (existing !== undefined) setText(existing.text);
    const unsubscribe = mergeRegister(
      queueEditStore.subscribe(() => {
        if (current()?.restore) restore();
        else decorate();
      }),
      editor.registerUpdateListener(({ editorState }) => {
        const edit = current();
        if (edit === undefined) return;
        const text = editorState.read(
          () => $getUserPromptNode()?.getTextContent() ?? '',
        );
        if (text === edit.text) return;
        queueMicrotask(() => {
          if (mounted && current()?.item.promptId === edit.item.promptId)
            queueEditStore.getState().patch(threadId, { text });
        });
      }),
      editor.registerCommand(
        EDIT_QUEUE_PROMPT_COMMAND,
        (item) => {
          if (item.source.kind !== 'user' || item.editable !== true)
            return false;
          if (current() !== undefined) {
            if (current()?.item.promptId === item.promptId)
              $getUserPromptNode()?.selectEnd();
            else
              toast.message(
                'Save the current edit or press Escape before editing another prompt.',
              );
            return true;
          }
          const request = ++generation.current;
          void threadsApi
            .queuedPrompt(threadId, item.promptId)
            .then((detail) => {
              if (!mounted || request !== generation.current) return;
              if (!detail.editable) {
                toast.error('This prompt can no longer be edited.');
                return;
              }
              const draft = editor
                .getEditorState()
                .toJSON()
                .root.children.find(
                  (node) => node.type === USER_PROMPT_BLOCK,
                ) as SerializedElementNode | undefined;
              if (draft === undefined) return;
              // A reader's prompt is an envelope: the editor takes only its
              // words, and the comments it carried stay as they were sent.
              const words = promptMessage(detail.text);
              queueEditStore.getState().set(threadId, {
                item,
                revision: detail.revision,
                stored: detail.text,
                original: promptSummary(detail.text),
                text: words,
                draft,
                saving: false,
              });
              setText(words);
              editor.getRootElement()?.focus({ preventScroll: true });
            })
            .catch((error) => {
              if (mounted && request === generation.current)
                toast.error(messageFrom(error));
            });
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        SAVE_QUEUE_EDIT_COMMAND,
        () => {
          const edit = current();
          if (edit === undefined) return false;
          if (edit.saving) return true;
          const text = $getUserPromptNode()?.getTextContent() ?? edit.text;
          const prompt = withPromptMessage(edit.stored, text);
          if (!prompt.trim()) return true;
          queueEditStore
            .getState()
            .patch(threadId, { saving: true, error: undefined, text });
          void threadsApi
            .editQueued(threadId, edit.item.promptId, prompt, edit.revision)
            .then((saved) => {
              const latest = current();
              if (latest?.item.promptId !== edit.item.promptId) return;
              if (mounted) {
                const live = editor
                  .getEditorState()
                  .read(
                    () => $getUserPromptNode()?.getTextContent() ?? latest.text,
                  );
                if (live !== text) {
                  queueEditStore.getState().patch(threadId, {
                    revision: saved.revision,
                    stored: saved.text,
                    original: promptSummary(saved.text),
                    text: live,
                    saving: false,
                  });
                  return;
                }
              } else if (latest.text !== text) {
                queueEditStore.getState().patch(threadId, {
                  revision: saved.revision,
                  stored: saved.text,
                  original: promptSummary(saved.text),
                  saving: false,
                });
                return;
              }
              // A different Thread may be mounted when the request finishes.
              if (mounted) restore();
              else
                queueEditStore.getState().patch(threadId, {
                  revision: saved.revision,
                  stored: saved.text,
                  original: promptSummary(saved.text),
                  saving: false,
                  restore: true,
                });
            })
            .catch((error) => {
              if (current()?.item.promptId === edit.item.promptId)
                queueEditStore.getState().patch(threadId, {
                  saving: false,
                  error: messageFrom(error),
                });
            })
            .finally(() => {
              void client.invalidateQueries({
                queryKey: queryKeys.threadQueue(threadId),
              });
            });
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          ++generation.current;
          const edit = current();
          if (edit === undefined) return false;
          event?.preventDefault();
          if (!edit.saving) restore();
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    );
    return () => {
      mounted = false;
      ++generation.current;
      unsubscribe();
      root?.removeAttribute('data-queue-editing');
    };
  }, [client, editor, threadId]);
  return null;
}

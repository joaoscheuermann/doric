// The composer's own plugin: what keeps the Thread's draft words in step with
// the composer service. The words live in the editor; the draft lives in the
// main process (`chat.composer/v1`), which is what makes it survive the
// navigation — a Thread opened again, in this window or in another, opens with
// the words it was left with, read back from the service's portrait.
//
// Writing goes this way only after the editor settled: a keystroke is not a
// bridge call, and a short debounce carries a run of them as one. Reading
// back happens only when the editor holds nothing — a reader who is typing
// in this window is the master of their own words, and the restore never
// fights them.
//
// A send made elsewhere (`chat.send/v1`, from the papercraft canvas) takes the
// draft's words with it and clears them on the service; the editor empties
// with that clear, but only while it still holds the words this side last
// wrote — words typed since are newer than the send and stay.

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useEffect, useMemo, useRef } from 'react';

import { composerFeed } from '../../../../api/composer.js';
import { $getUserPromptNode } from '../nodes/user-prompt-node.js';
import { $restore as $restoreIntoPrompt } from './send-prompt.js';

/** How long a run of keystrokes waits before it becomes one service write. */
const TEXT_DEBOUNCE_MS = 300;

type Thread = { readonly id: string; readonly projectId: string };

/**
 * Reads the words back from the service when the prompt opens empty, and
 * writes the words to the service while the reader types.
 */
export function ComposerDraft({ thread }: { readonly thread: Thread }) {
  const [editor] = useLexicalComposerContext();
  /** The words this side last handed the service, so its echoes are quiet. */
  const last = useRef<string | undefined>(undefined);
  // The draft belongs to the Thread, not to its record: a record that moves on
  // (a send starts the Thread running) is the same draft, and reading it back
  // then would draw words the reader already sent.
  const scope = useMemo<Thread>(
    () => ({ id: thread.id, projectId: thread.projectId }),
    [thread.id, thread.projectId],
  );

  useEffect(() => {
    let restored = false;
    let settle: ReturnType<typeof setTimeout> | undefined;

    const $promptText = (): string =>
      $getUserPromptNode()?.getTextContent().trim() ?? '';

    const write = (text: string): void => {
      if (last.current === text) return;
      last.current = text;
      composerFeed.setText(scope, text);
    };

    const readBack = async (): Promise<void> => {
      if (restored) return;
      const snapshot = await composerFeed.read(scope);
      if (snapshot === undefined) return;
      last.current = snapshot.text;

      // A Thread opens empty until the log fills it: the portrait's words are
      // the ones the last window left behind, and they go back where they
      // came from, above the queue.
      if (snapshot.text.length === 0) return;
      editor.update(() => {
        if ($promptText().length > 0) return;
        $restoreIntoPrompt(snapshot.text);
      });
    };

    // The prompt may already hold words a rewind drew or a restore put back;
    // those are this surface's words now, so the read back stays quiet about
    // them and the service learns them with the next write.
    void readBack();

    const writeNow = (): void => {
      const text = editor.getEditorState().read($promptText);
      write(text);
    };

    const quiet = (): void => {
      if (settle !== undefined) clearTimeout(settle);
      settle = setTimeout(writeNow, TEXT_DEBOUNCE_MS);
    };

    const unregister = editor.registerUpdateListener(() => {
      quiet();
    });

    const unwatch = composerFeed.watch(scope, (item) => {
      if (item.kind !== 'text' || item.text.length > 0) return;
      if (last.current === undefined || last.current === '') return;
      const held = last.current;
      last.current = '';
      editor.update(() => {
        const prompt = $getUserPromptNode();
        if (prompt === undefined) return;
        if (prompt.getTextContent().trim() !== held) return;
        prompt.clear();
      });
    });

    return () => {
      unwatch();
      restored = true;
      // A run of keystrokes still settling is written now, not dropped: the
      // service keeps the words the editor last held.
      if (settle !== undefined) {
        clearTimeout(settle);
        writeNow();
      }
      unregister();
    };
  }, [editor, scope]);

  return null;
}

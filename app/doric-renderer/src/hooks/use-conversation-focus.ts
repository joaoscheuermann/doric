import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, $setSelection } from 'lexical';
import { useEffect } from 'react';

/**
 * Puts the caret in the composer when a conversation opens, so the first thing a
 * person can do is answer it.
 *
 * The scroll is the scroller's job (`MessageScroller` holds the live edge); this
 * is the part no scroller can do, because the caret lives in the document and not
 * in the viewport. The composer's own turn is marked `data-draft="true"`, which
 * is what tells the two apart — every other turn is sealed and would refuse the
 * words anyway.
 *
 * It runs once per thread. A conversation that is already on screen — a re-render
 * from a live event, a resize — must not snatch the caret back from wherever the
 * person moved it, so the dependency is the thread's identity and nothing that
 * changes while streaming.
 */
export function useComposerFocus(threadId: string): void {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let timer = 0;
    const focus = (): void => {
      editor.update(() => {
        const composer = document.querySelector<HTMLElement>(
          '.doric-turn[data-draft="true"] [data-doric-body]',
        );
        // Nothing to focus yet: the composer is written into the document by the
        // reconcile that follows this mount, so the first frames have no turn —
        // which is why this keeps trying for a moment rather than once.
        if (composer === null) return;

        const root = editor.getRootElement();
        // A conversation that is not on screen is not one a person is answering,
        // and the surface decides when it is shown.
        if (root !== null && root.offsetParent === null) return;

        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        // Only the end: the composer opens empty, and a caret in the middle of an
        // answer the person is reading would be a caret they did not ask for.
        const last = selection.getNodes().at(-1);
        if (last === undefined) return;
        last.selectEnd();
        $setSelection(selection);
        // The scroller owns where the viewport is, and focusing without asking it
        // to leave well alone would scroll the transcript to the caret — the one
        // place it must not jump to by itself.
        composer.focus({ preventScroll: true });
        window.clearInterval(timer);
      });
    };

    focus();
    const until = Date.now() + 2000;
    timer = window.setInterval(() => {
      if (Date.now() > until) window.clearInterval(timer);
      else focus();
    }, 100);
    return () => window.clearInterval(timer);
  }, [editor, threadId]);
}

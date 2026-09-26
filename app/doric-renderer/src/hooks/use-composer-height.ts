import { useEffect } from 'react';

/**
 * Publishes the composer's height as a CSS variable, so the controls that float
 * over the transcript can sit clear of it.
 *
 * The composer is a turn in the document, and it grows with what is typed into
 * it, so its height is not a number anything can know ahead of time. The jump
 * button has to clear it, and a fixed offset is wrong twice over: too far when
 * the composer is one line, and not far enough once it is a paragraph. This
 * measures it and writes the answer down; the stylesheet reads the variable.
 *
 * This is layout, not scroll: nothing here decides where the transcript is
 * looking or when it follows. The follow belongs to the scroller, and this only
 * keeps a float from landing on the input.
 */
export function useComposerHeight(target: HTMLElement | null): void {
  useEffect(() => {
    if (target === null) return;

    let stopped = false;
    let timer = 0;

    const composer = (): HTMLElement | null =>
      target.querySelector<HTMLElement>('.doric-turn[data-draft="true"]');

    const publish = (element: HTMLElement | null): void => {
      if (element === null) {
        target.style.removeProperty('--doric-composer-height');
        return;
      }
      target.style.setProperty(
        '--doric-composer-height',
        `${Math.round(element.getBoundingClientRect().height)}px`,
      );
    };

    // One observer on the transcript, re-attached when the composer node is
    // replaced: Lexical keeps the same element while the turn holds the same key,
    // and a new composer is a new element, so watching the child is what survives a
    // resubmit.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) publish(entry.target as HTMLElement);
    });

    const observe = (element: HTMLElement): void => {
      publish(element);
      observer.observe(element);
    };

    // The composer is written into the document by the reconcile that follows the
    // first render, so the first frames have no turn to measure — and a conversation
    // that opens before its log arrives has none for a while. One attempt per tenth
    // of a second until it appears, then never again: the observer above is what
    // keeps the measurement current after that.
    const watch = (): void => {
      if (stopped) return;
      const element = composer();
      if (element === null) {
        timer = window.setTimeout(watch, 100);
        return;
      }
      first = element;
      observe(element);
    };

    // A resubmit swaps the turn. MutationObserver is cheaper than polling here:
    // the tree changes only when the log does.
    let first: HTMLElement | null = null;
    const mutations = new MutationObserver(() => {
      const current = composer();
      if (current === null || current === first) return;
      first = current;
      observer.disconnect();
      observe(current);
    });

    watch();
    mutations.observe(target, { childList: true, subtree: true });

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [target]);
}

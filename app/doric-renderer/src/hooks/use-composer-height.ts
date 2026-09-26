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

    // The composer is written into the document by the reconcile that follows
    // the first render, so the first frames have no turn to measure.
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

    const first = composer();
    publish(first);

    // One observer on the transcript, re-attached when the composer node is
    // replaced: Lexical keeps the same element while the turn holds the same
    // key, and a new composer is a new element, so watching the child is what
    // survives a resubmit.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) publish(entry.target as HTMLElement);
    });
    if (first !== null) observer.observe(first);

    // A resubmit swaps the turn. MutationObserver is cheaper than polling here:
    // the tree changes only when the log does.
    const mutations = new MutationObserver(() => {
      const current = composer();
      if (current === null || current === first) return;
      observer.disconnect();
      observer.observe(current);
      publish(current);
    });
    mutations.observe(target, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [target]);
}

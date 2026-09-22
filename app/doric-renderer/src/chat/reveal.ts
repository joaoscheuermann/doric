export const graphemes = (value: string): readonly string[] => {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale?: string,
        options?: { readonly granularity: 'grapheme' },
      ) => {
        segment(input: string): Iterable<{ readonly segment: string }>;
      };
    }
  ).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    return [...segmenter.segment(value)].map(({ segment }) => segment);
  }
  return Array.from(value);
};

export type RevealInput = {
  readonly receivedMarkdown: string;
  readonly visibleMarkdown: string;
  readonly terminal: boolean;
};

export const initialVisibleMarkdown = (
  receivedMarkdown: string,
  live: boolean,
): string => (live ? '' : receivedMarkdown);

/**
 * Advances one animation frame. Large backlogs catch up progressively, while a
 * terminal turn drains in at most four frames.
 */
export const revealStep = ({
  receivedMarkdown,
  visibleMarkdown,
  terminal,
}: RevealInput): string => {
  if (
    visibleMarkdown === receivedMarkdown ||
    !receivedMarkdown.startsWith(visibleMarkdown)
  ) {
    return receivedMarkdown;
  }
  const received = graphemes(receivedMarkdown);
  const visible = graphemes(visibleMarkdown);
  const backlog = received.length - visible.length;
  const count = terminal
    ? Math.max(1, Math.ceil(received.length / 4))
    : Math.max(1, Math.ceil(backlog / 12));
  return received.slice(0, visible.length + count).join('');
};

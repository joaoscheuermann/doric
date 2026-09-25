/**
 * The dot that stands for a state — a turn still working, a tool call still
 * running — as chrome rather than as content. It is DOM the surface owns, so it
 * is never a node of the document, never selected with the words beside it, and
 * never something the caret can stop in.
 *
 * The state is carried by the dot's title and label as well as by its colour,
 * because a colour alone is not something a person can read out.
 */
export type StatusTone = 'active' | 'idle' | 'failed';

export const statusDot = (label: string, tone: StatusTone): HTMLElement => {
  const dot = document.createElement('span');
  dot.className = 'doric-dot';
  dot.dataset.tone = tone;
  dot.title = label;
  dot.setAttribute('aria-label', label);
  dot.setAttribute('role', 'status');
  return dot;
};

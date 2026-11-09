// A story's `doric.appearance/v1`: the app's answers, held in memory, or the
// pending and failing answers the section's states draw.

import type { DoricAppearance, DoricTheme } from 'bundle/contracts';

/** How the story's app answers one call. */
export type StoryAnswer = 'resolve' | 'pending' | 'reject';

const never = new Promise<never>(() => undefined);

export const storyAppearance = ({
  theme = 'dark',
  get = 'resolve',
  set = 'resolve',
}: {
  readonly theme?: DoricTheme;
  readonly get?: StoryAnswer;
  readonly set?: StoryAnswer;
} = {}): DoricAppearance => {
  let stored = theme;

  return {
    get: () => {
      if (get === 'pending') return never;
      if (get === 'reject') {
        return Promise.reject(new Error('The appearance store is not open.'));
      }
      return Promise.resolve({ theme: stored });
    },
    set: ({ theme: next }) => {
      if (set === 'pending') return never;
      if (set === 'reject') {
        return Promise.reject(new Error('Could not save the appearance.'));
      }
      stored = next;
      return Promise.resolve();
    },
  };
};

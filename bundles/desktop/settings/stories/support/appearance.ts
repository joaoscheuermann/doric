// A story's `doric.appearance/v1`: the app's answers, held in memory, or the
// pending and failing answers the section's states draw.

import type { DoricAppearance, DoricGlass, DoricTheme } from 'bundle/contracts';

/** How the story's app answers one call. */
export type StoryAnswer = 'resolve' | 'pending' | 'reject';

const never = new Promise<never>(() => undefined);

export const storyAppearance = ({
  theme = 'dark',
  glass,
  get = 'resolve',
  set = 'resolve',
}: {
  readonly theme?: DoricTheme;
  /** The app's `glass` answer; absent draws an app before platform 1.12.0. */
  readonly glass?: DoricGlass;
  readonly get?: StoryAnswer;
  readonly set?: StoryAnswer;
} = {}): DoricAppearance => {
  let stored = theme;
  let storedGlass = glass;

  return {
    get: () => {
      if (get === 'pending') return never;
      if (get === 'reject') {
        return Promise.reject(new Error('The appearance store is not open.'));
      }
      return Promise.resolve(
        storedGlass === undefined
          ? { theme: stored }
          : { theme: stored, glass: storedGlass },
      );
    },
    set: ({ theme: next, glass: enabled }) => {
      if (set === 'pending') return never;
      if (set === 'reject') {
        return Promise.reject(new Error('Could not save the appearance.'));
      }
      if (next !== undefined) stored = next;
      if (enabled !== undefined && storedGlass !== undefined) {
        storedGlass = { ...storedGlass, enabled };
      }
      return Promise.resolve();
    },
  };
};

import { useState } from 'react';

import { SettingsAppearance } from '../../../src/client/components/organisms/settings-appearance.js';
import { type StoryAnswer, storyAppearance } from '../../support/appearance.js';
import { sectionFrame } from '../../support/frames.js';

/** The section over a story app that answers as `answers` says. */
function Section(
  answers: {
    readonly theme?: 'dark' | 'light' | 'system';
    readonly get?: StoryAnswer;
    readonly set?: StoryAnswer;
  } = {},
) {
  const [appearance] = useState(() => storyAppearance(answers));
  return <SettingsAppearance appearance={appearance} />;
}

export default {
  title: 'Settings/Organisms/Settings appearance',
  component: SettingsAppearance,
  decorators: [sectionFrame],
};

export const DarkSelected = { render: () => <Section theme="dark" /> };

export const LightSelected = { render: () => <Section theme="light" /> };

export const SystemSelected = { render: () => <Section theme="system" /> };

/** While `get()` is pending: every tile disabled, none selected. */
export const Reading = { render: () => <Section get="pending" /> };

export const ReadFailed = { render: () => <Section get="reject" /> };

/** Choose any other tile: the save stays pending and the tiles disabled. */
export const Saving = { render: () => <Section set="pending" /> };

/** Choose any other tile: the save fails and the selection stays. */
export const SaveFailed = { render: () => <Section set="reject" /> };

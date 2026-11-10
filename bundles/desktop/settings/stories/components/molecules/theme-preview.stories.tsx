import { ThemePreview } from '../../../src/client/components/molecules/theme-preview.js';
import { controlFrame } from '../../support/frames.js';

/** A preview at its 240×80 size; each half keeps its own theme's colors. */
const Preview = ({
  theme,
}: {
  readonly theme: 'dark' | 'light' | 'system';
}) => (
  <div className="w-60">
    <ThemePreview theme={theme} />
  </div>
);

export default {
  title: 'Settings/Molecules/Theme preview',
  component: ThemePreview,
  decorators: [controlFrame],
};

export const Dark = { render: () => <Preview theme="dark" /> };

export const Light = { render: () => <Preview theme="light" /> };

export const System = { render: () => <Preview theme="system" /> };

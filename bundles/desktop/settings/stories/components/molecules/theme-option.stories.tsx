import { ThemeOption } from '../../../src/client/components/molecules/theme-option.js';
import { controlFrame } from '../../support/frames.js';

/** One tile at the Figma width, selected or not. */
const Option = ({
  theme,
  selected = false,
}: {
  readonly theme: 'dark' | 'light' | 'system';
  readonly selected?: boolean;
}) => (
  <div className="flex w-[242px]">
    <ThemeOption
      theme={theme}
      selected={selected}
      disabled={false}
      focusable
      onSelect={() => undefined}
    />
  </div>
);

export default {
  title: 'Settings/Molecules/Theme option',
  component: ThemeOption,
  decorators: [controlFrame],
};

export const DarkSelected = {
  render: () => <Option theme="dark" selected />,
};

export const Dark = { render: () => <Option theme="dark" /> };

export const LightSelected = {
  render: () => <Option theme="light" selected />,
};

export const Light = { render: () => <Option theme="light" /> };

export const SystemSelected = {
  render: () => <Option theme="system" selected />,
};

export const System = { render: () => <Option theme="system" /> };

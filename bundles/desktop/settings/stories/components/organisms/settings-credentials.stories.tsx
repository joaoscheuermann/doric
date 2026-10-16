import { SettingsCredentials } from '../../../src/client/components/organisms/settings-credentials.js';
import { credentials, manyCredentials } from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';
import { pending, SettingsHost, type StoryHost } from '../../support/host.js';
import { OpenOnMount, type OpenStep } from '../../support/open-on-mount.js';

/** The credentials section over a story host that keeps what it writes. */
function Section({
  host,
  open = [],
}: {
  readonly host?: StoryHost;
  readonly open?: readonly OpenStep[];
}) {
  return (
    <SettingsHost host={host}>
      {() => (
        <OpenOnMount steps={open}>
          <SettingsCredentials />
        </OpenOnMount>
      )}
    </SettingsHost>
  );
}

const firstName = credentials[0]?.name ?? '';

export default {
  title: 'Settings/Organisms/Settings credentials',
  component: SettingsCredentials,
  decorators: [sectionFrame],
};

export const Default = {
  render: () => <Section />,
};

export const AddDialogOpen = {
  render: () => (
    <Section open={[{ selector: 'button', text: 'Add credential' }]} />
  ),
};

export const EditDialogOpen = {
  render: () => (
    <Section
      open={[
        {
          selector: `[aria-label="Actions for ${firstName}"]`,
          gesture: 'pointerdown',
        },
        { selector: '[role="menuitem"]', text: 'Edit' },
      ]}
    />
  ),
};

export const RowMenuOpen = {
  render: () => (
    <Section
      open={[
        {
          selector: `[aria-label="Actions for ${firstName}"]`,
          gesture: 'pointerdown',
        },
      ]}
    />
  ),
};

export const Empty = {
  render: () => <Section host={{ credentials: [] }} />,
};

export const Loading = {
  render: () => <Section host={{ credentials: pending }} />,
};

export const ManyCredentials = {
  render: () => <Section host={{ credentials: manyCredentials }} />,
};

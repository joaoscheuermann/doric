import type { Services } from 'bundle/contracts';
import { useLayoutEffect, useState } from 'react';

import { AccountStatus } from '../../../src/client/components/organisms/account-status.js';
import {
  type AccountFixture,
  bindAccount,
} from '../../support/account-host.js';
import type { RegionItem } from '../../support/fake-host.js';

// The account status of S8 (`267:21908`) in both of its variants, in the
// light and the dark theme side by side. The connection badge is the
// `resources` bundle's item; here a fake item stands in the `account.status`
// slot, drawn as a 14×14 dot in the badge's tone. The menu holds one
// "Settings" data item, as the `settings` bundle adds it to `account.menu`.

/** The tag of the fake badge each variant seeds into the slot. */
const connectedBadge = 'story-connection-badge-connected';
const disconnectedBadge = 'story-connection-badge-disconnected';

const settingsEntry: RegionItem = {
  id: 'settings',
  tag: 'settings-entry-icon',
  owner: 'settings',
  props: {
    label: 'Settings',
    command: 'core.open-settings/v1',
    input: { defaultPath: '/settings' },
  },
};

const regions = (
  tag: string,
): Readonly<Record<string, readonly RegionItem[]>> => ({
  'account.status': [{ id: 'resources', tag, order: 10, owner: 'resources' }],
  'account.menu': [settingsEntry],
});

const connected: AccountFixture = { regions: regions(connectedBadge) };

const disconnected: AccountFixture = { regions: regions(disconnectedBadge) };

/**
 * The placeholder draws a labelled stand-in; these rules shrink the fake
 * badge's placeholder to the slot and tint it as the badge would be.
 */
const badgeStyle = `
[data-story-placeholder^="story-connection-badge"] {
  display: block !important;
  box-sizing: border-box;
  width: 14px !important;
  height: 14px !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 2px solid var(--background) !important;
  border-radius: 9999px !important;
  font-size: 0 !important;
}
[data-story-placeholder="${connectedBadge}"] { background: var(--muted-foreground); }
[data-story-placeholder="${disconnectedBadge}"] { background: var(--destructive); }
`;

/**
 * The account status in the light theme and in the dark one, with the account
 * activated on a fake host built from `fixture` while the story is shown.
 */
function BothThemes({ fixture }: { readonly fixture: AccountFixture }) {
  const [services, setServices] = useState<Services>();

  useLayoutEffect(() => {
    const bound = bindAccount(fixture);
    setServices(bound.services);
    return () => {
      setServices(undefined);
      bound.unbind();
    };
  }, [fixture]);

  if (services === undefined) return null;
  return (
    <div className="flex gap-4">
      <style>{badgeStyle}</style>
      {['light', 'dark'].map((theme) => (
        <div
          key={theme}
          className={`${theme === 'dark' ? 'dark ' : ''}flex items-center gap-2 rounded-md bg-background p-4 text-xs text-foreground`}
        >
          <AccountStatus services={services} />
          <span className="text-muted-foreground">{theme}</span>
        </div>
      ))}
    </div>
  );
}

export default {
  title: 'Account/Organisms/Account status',
  component: AccountStatus,
};

/** Connected: the avatar with the connection badge over its corner. */
export const Connected = {
  render: () => <BothThemes fixture={connected} />,
};

/** Disconnected: the badge in its disconnected tone. */
export const Disconnected = {
  render: () => <BothThemes fixture={disconnected} />,
};

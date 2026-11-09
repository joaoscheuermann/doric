import { AccountStatus } from '../../../src/client/components/organisms/account-status.js';
import type { RegionItem } from '../../support/fake-host.js';
import { type LayoutFixture, LayoutHost } from '../../support/layout-host.js';

// The account status of S8 (`267:21908`) in both of its variants, in the
// light and the dark theme side by side. The connection badge is the
// `resources` bundle's item (2c); here a fake item stands in the
// `layout.account.status` slot, drawn as a 14×14 dot in the badge's tone.

const openSettings = () => console.info('Story: open settings');

/** The tag of the fake badge each variant seeds into the slot. */
const connectedBadge = 'story-connection-badge-connected';
const disconnectedBadge = 'story-connection-badge-disconnected';

const badge = (
  tag: string,
): Readonly<Record<string, readonly RegionItem[]>> => ({
  'layout.account.status': [
    { id: 'resources', tag, order: 10, owner: 'resources' },
  ],
});

const connected: LayoutFixture = {
  connection: 'connected',
  regions: badge(connectedBadge),
};

const disconnected: LayoutFixture = {
  connection: 'disconnected',
  regions: badge(disconnectedBadge),
};

/**
 * The region stand-in draws a labelled placeholder; these rules shrink the
 * fake badge's placeholder to the slot and tint it as the badge would be.
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

/** The account status in the light theme and in the dark one. */
function BothThemes() {
  return (
    <div className="flex gap-4">
      <style>{badgeStyle}</style>
      {['light', 'dark'].map((theme) => (
        <div
          key={theme}
          className={`${theme === 'dark' ? 'dark ' : ''}flex items-center gap-2 rounded-md bg-background p-4 text-xs text-foreground`}
        >
          <AccountStatus onOpenSettings={openSettings} />
          <span className="text-muted-foreground">{theme}</span>
        </div>
      ))}
    </div>
  );
}

export default {
  title: 'Layout/Organisms/Account status',
  component: AccountStatus,
};

/** Connected: the avatar with the connection badge over its corner. */
export const Connected = {
  render: () => (
    <LayoutHost fixture={connected}>
      <BothThemes />
    </LayoutHost>
  ),
};

/** Disconnected: the badge in its disconnected tone. */
export const Disconnected = {
  render: () => (
    <LayoutHost fixture={disconnected}>
      <BothThemes />
    </LayoutHost>
  ),
};

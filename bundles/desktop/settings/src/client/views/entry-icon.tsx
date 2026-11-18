// `settings-entry-icon`: the 16 px glyph of the settings bundle's entries in
// other bundles' menus, first the account menu's "Settings" (`account.menu`,
// bundle isolation 4(b)).

import { defineReactElement } from 'desktop/ui/react-element';
import { SettingsIcon } from 'lucide-react';

/** The settings glyph, muted and hidden from assistive technology. */
function EntryIcon() {
  return <SettingsIcon className="size-4 text-muted-foreground" aria-hidden />;
}

export const EntryIconElement = defineReactElement({
  props: [],
  render: EntryIcon,
});

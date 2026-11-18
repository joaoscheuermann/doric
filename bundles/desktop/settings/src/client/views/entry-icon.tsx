// `settings-entry-icon`: the 16 px glyph of the settings bundle's entries in
// other bundles' menus: the account menu's "Settings" (`account.menu`, bundle
// isolation 4(b)) and the Dashboard's "All settings"
// (`workspace.dashboard.footer`, 4(c)). It takes the colour of the entry that
// draws it (decision O14).

import { defineReactElement } from 'desktop/ui/react-element';
import { SettingsIcon } from 'lucide-react';

/** The settings glyph, in the entry's colour and hidden from assistive technology. */
function EntryIcon() {
  return <SettingsIcon className="size-4" aria-hidden />;
}

export const EntryIconElement = defineReactElement({
  props: [],
  render: EntryIcon,
});

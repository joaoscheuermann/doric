import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import { READER_NAME } from 'desktop/ui/identity';
import { ReaderAvatar } from 'desktop/ui/reader-avatar';
import { InfoIcon, SettingsIcon } from 'lucide-react';
import { createElement } from 'react';

import { useAboutVersion } from '../../domain/about.js';

type AccountStatusProps = {
  /** Opens the settings window; the menu's "Settings" item calls it once per selection. */
  readonly onOpenSettings: () => void;
};

/**
 * The account status of S8 (`267:21908`): a 20×24 box holding the reader's
 * avatar and, over its bottom-right corner, the `layout.account.status`
 * region in a 14×14 slot at left 10 px, top 12 px. The slot is a sibling of
 * the avatar button, so a region item is its own Tab stop.
 *
 * The avatar is a `<button>` named "Account" that opens the account menu
 * (S26, `106:20705`), a 240 px dropdown menu:
 * - header: `READER_NAME` above "Local account";
 * - one item, "Settings", which calls `onOpenSettings`;
 * - footer: "Doric" above "MIT License · v<version>", or "MIT License" alone
 *   while `useAboutVersion()` holds no version.
 *
 * Needs the layout bound (`setLayoutServices`) only for its region; it
 * renders without `doric.about/v1`.
 */
export function AccountStatus({ onOpenSettings }: AccountStatusProps) {
  const version = useAboutVersion();
  const license =
    version === undefined ? 'MIT License' : `MIT License · v${version}`;

  return (
    <div data-slot="account-status" className="relative h-6 w-5 shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account"
          className="absolute top-0 left-0 flex h-6 w-5 items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ReaderAvatar name={READER_NAME} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <div className="flex items-center gap-2 p-1.5">
            <ReaderAvatar name={READER_NAME} className="size-8" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {READER_NAME}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                Local account
              </span>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenSettings}>
            <SettingsIcon className="text-muted-foreground" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="flex items-center gap-1.5 p-1.5 text-xs text-muted-foreground">
            <InfoIcon className="size-4 shrink-0" />
            <div className="flex min-w-0 flex-col">
              <span>Doric</span>
              <span>{license}</span>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="absolute top-3 left-2.5 size-3.5">
        {createElement('core-region', { name: 'layout.account.status' })}
      </div>
    </div>
  );
}

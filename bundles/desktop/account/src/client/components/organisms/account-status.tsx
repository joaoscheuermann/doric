import {
  CommandsV1,
  isContractId,
  RegionsV1,
  type Services,
  UiV1,
} from 'bundle/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import { ElementHost, useRegionItems } from 'desktop/ui/element-host';
import { READER_NAME } from 'desktop/ui/identity';
import { ReaderAvatar } from 'desktop/ui/reader-avatar';
import { InfoIcon } from 'lucide-react';
import { Fragment, useMemo } from 'react';

import { ACCOUNT_STATUS } from '../../../contracts/index.js';
import { useAboutVersion } from '../../domain/about.js';
import { type MenuEntry, useMenuItems } from '../../hooks/use-menu-items.js';

type AccountStatusProps = {
  /** The account's services: `ui/v1`, `regions/v1` and `commands/v1`. */
  readonly services: Services;
};

/**
 * The account status of S8 (`267:21908`): a 20×24 box holding the reader's
 * avatar and, over its bottom-right corner, the `account.status` items in a
 * 14×14 slot at left 10 px, top 12 px. The slot is a sibling of the avatar
 * button, so a slot item is its own Tab stop.
 *
 * The avatar is a `<button>` named "Account" that opens the account menu
 * (S26, `106:20705`), a 240 px dropdown menu:
 * - header: `READER_NAME` above "Local account";
 * - the drawable `account.menu` entries, each its icon element then its
 *   label; a pick executes the entry's command with its input once. The
 *   separator before them is drawn only when there is one (decision O5);
 * - footer: "Doric" above "MIT License · v<version>", or "MIT License" alone
 *   while `useAboutVersion()` holds no version.
 *
 * It renders without `doric.about/v1`.
 */
export function AccountStatus({ services }: AccountStatusProps) {
  const ui = useMemo(() => services.use(UiV1), [services]);
  const regions = useMemo(() => services.use(RegionsV1), [services]);
  const entries = useMenuItems(regions);
  const badges = useRegionItems(regions, ACCOUNT_STATUS);
  const version = useAboutVersion();
  const license =
    version === undefined ? 'MIT License' : `MIT License · v${version}`;

  const pick = ({ props }: MenuEntry): void => {
    const { command, input } = props;
    if (!isContractId(command)) return;
    void services
      .use(CommandsV1)
      .execute(command, input)
      .catch((error: unknown) => {
        console.error(`Doric: the command ${command} could not run:`, error);
      });
  };

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
          {entries.length > 0 && (
            <Fragment>
              <DropdownMenuSeparator />
              {entries.map((entry) => (
                <DropdownMenuItem key={entry.id} onClick={() => pick(entry)}>
                  <ElementHost ui={ui} tag={entry.tag} />
                  {entry.props.label}
                </DropdownMenuItem>
              ))}
            </Fragment>
          )}
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
        {badges.map((badge) => (
          <ElementHost
            key={badge.id}
            ui={ui}
            tag={badge.tag}
            props={badge.props}
          />
        ))}
      </div>
    </div>
  );
}

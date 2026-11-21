// The account bundle's slots (bundle isolation 4(b), spec §7–§8). A filler
// writes the name as a literal checked by `satisfies typeof`, with `import type`
// (D32); this module holds no contract id.

/** The badge over the account avatar's bottom-right corner, a 14×14 slot. Items are elements. */
export const ACCOUNT_STATUS = 'account.status';

/**
 * The entries of the account menu, between its header (the reader's name and
 * "Local account") and its About line. Items are data items: `props` are
 * `AccountMenuItemProps`, and `tag` is the filler's icon element, drawn before
 * the label. The owner does not size it: the filler's element should draw an
 * SVG at 16 px (`size-4`); the menu item's `svg` size rule is the only sizing.
 *
 * An item is dropped (not drawn) when its `label` is not a string, its
 * `command` fails `isContractId`, or its `input` is present but not a plain
 * object. It is reported once per id per activation with a `Doric:` error
 * (`console.error`). A pick that fails is logged with
 * `console.error('Doric: the command … could not run:')`.
 */
export const ACCOUNT_MENU = 'account.menu';

/** The `props` of an item of `account.menu` (D9). */
export interface AccountMenuItemProps {
  readonly label: string;
  /** The command `account` executes through `commands/v1` when the reader picks the entry. */
  readonly command: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

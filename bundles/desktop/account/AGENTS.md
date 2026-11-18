# account

These instructions apply to `bundles/desktop/account` and narrow
`bundles/AGENTS.md` (once it exists) and the root [`AGENTS.md`](../../../AGENTS.md).

## Function

The reader's account status, its menu and About. Read [`README.md`](README.md)
for what it draws and its slots.

## Layers

- `src/contracts/`: the slot names `ACCOUNT_STATUS` and `ACCOUNT_MENU`, and
  `AccountMenuItemProps`. No contract id.
- `src/client/components/organisms/`: `AccountStatus`, the React component.
- `src/client/elements/`: `account-status`, the element built with
  `defineReactElement`.
- `src/client/hooks/`: `useMenuItems`, the drawable entries of `account.menu`.
- `src/client/domain/`: pure modules (`menu-items.ts`, the props check) and
  the About store (`about.ts`).

## Links

- [`manifest.json`](manifest.json): the contracts it provides, requires and
  may use.
- [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json):
  its entries, by the id `account`.
- Feature doc: [bundle isolation](../../../docs/features/bundle-isolation.md).

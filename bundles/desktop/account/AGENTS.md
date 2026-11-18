# account

The account status, its menu and About. Read `README.md` for what it draws
and its slots.

## Layers

- `src/contracts/`: the slot names `ACCOUNT_STATUS` and `ACCOUNT_MENU`, and
  `AccountMenuItemProps`. No contract id.
- `src/client/components/organisms/`: `AccountStatus`, the React component.
- `src/client/elements/`: `account-status`, the element built with
  `defineReactElement`.
- `src/client/hooks/`: `useMenuItems`, the drawable entries of `account.menu`.
- `src/client/domain/`: pure modules (`menu-items.ts`, the props check) and
  the About store (`about.ts`).

## Boundaries

- No value import of another bundle's contracts (D32); slot names of other
  bundles are `import type` with `satisfies typeof`.
- No `<core-region>`: slot items are drawn with `useRegionItems` and
  `ElementHost`.
- Only `ui/v1`, `regions/v1`, `commands/v1` and `doric.about/v1` (followed
  with `whenAvailable`).

## Tests

Each client test renders `account-status` alone through `renderAccount`
(`tests/client/support/render-account.ts`), on the fake host of
`stories/support/fake-host.ts`.

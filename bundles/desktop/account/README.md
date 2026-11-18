# account

The reader's account status, its menu and About, as a client-only bundle
(bundle isolation step 4(b)). It needs platform `^1.8.0`.

## What it draws

`<account-status>`, which the activation adds to the shell's
`shell.window.actions` slot (`layout/contracts`): the end of the Project tab
bar in the page form, the end of the Project panel's header in the
conversation form. It is a 20×24 box holding the reader's avatar, a button
named "Account" that opens the account menu:

- the header: the reader's name above "Local account";
- the entries of `account.menu`, each its icon element then its label;
- the About line: "Doric" above "MIT License · v<version>".

The version comes from `doric.about/v1`, which the bundle follows with
`whenAvailable`; without it the line reads "MIT License" alone.

## Slots

Both names are in `account/contracts`; a filler writes the name as a literal
checked by `satisfies typeof`, with `import type`.

| Slot             | What it holds                                                                                            | Filled by                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `account.status` | elements in a 14×14 slot over the avatar's bottom-right corner, outside the button                       | `resources` (the connection badge)             |
| `account.menu`   | data items: `props` are `AccountMenuItemProps` (`label`, `command`, optional `input`), `tag` is the icon | `settings` ("Settings", `settings-entry-icon`) |

Picking an entry executes its `command` with its `input` through
`commands/v1`, once per pick. An item whose props fail the type is not drawn,
and is reported once with `console.error('Doric: …')`. The separator before
the entries is drawn only when there is one.

Without `settings` the menu has no Settings entry.

# desktop

`packages/desktop` is the workspace package `desktop` (version `1.0.0`, private, ES modules). It holds the code the desktop windows, the Electron main process and the parts of bundles build on. Its four subpath families have different consumers:

- **`desktop/ui`** — the shared UI: the shadcn components, the theme stylesheet, fonts and tokens, and the generic widgets several bundles draw (error notice, panels, code view, custom-element helpers). Client parts of bundles import it and leave it external, and the platform serves one copy of it per window through the window's import map ([`externals.ts`](../bundle/src/build/externals.ts), [`build.mjs`](../../app/desktop/doric-platform/build.mjs)).
- **`desktop/reads`** — browser-safe read helpers: path strings, the refresh queue, the retry policy of a pending read, and the error value every surface renders. Client parts of bundles import it. It is not an external of a part's build, so each part bundles its own copy ([`externals.ts`](../bundle/src/build/externals.ts)).
- **`desktop/protocol`** — the window–main protocol: the types and zod schemas of what the preload exposes, the IPC payloads and `doric.shell/v1`, the channel names, and one function, `remoteMethodSpecFromSchema`. The Electron main process loads it at run time and validates with its schemas what a window sends ([`dispatcher.ts`](../../app/desktop/doric/src/platform/bridge/dispatcher.ts)). The preload ([`desktop.ts`](../../app/desktop/doric/src/app/api/desktop.ts)) and the splash page ([`splash.ts`](../../app/desktop/doric/src/splash-page/splash.ts)) import its types only; the preload states the two channel names itself. It is not an external of a part's build either, so a bundle part that imports it bundles a copy.
- **`desktop/client`** — the window's loader runtime: bootstrap, client activation, the bridge to the main process and the window's platform providers. The renderer's bootstrap imports it ([`bootstrap.ts`](../../app/desktop/doric-renderer/src/bootstrap.ts)). The build of a bundle part fails on `desktop/client` and on every `desktop/client/*` specifier ([What a bundle part may import](#what-a-bundle-part-may-import)).

Most primitives take what they show from the bundle: a bundle passes its own rows, labels, colours and error codes. Some exports name a concept of the bundles that use them: the file tree of the panels (`FileTree`, `TreeNode`, `FileTreeActions`, and `emptyDirectoryNotice`, the text `'This directory is empty.'`) ([`file-tree.tsx`](src/panels/file-tree.tsx)), the diff editor (`DiffEditor`, `DiffControls`) ([`diff-editor.tsx`](src/code/diff-editor.tsx)), `fileLanguage(path)` ([`language.ts`](src/code/language.ts)) and `READER_NAME`, the fixed reader name `'jao.scheuermann'` ([`identity-mark.ts`](src/identity/identity-mark.ts)). How the app serves `desktop/ui` to every window through the import map, which imports a bundle leaves external and how bundle stylesheets combine with the theme is in [Platform packages and theme tokens](../../docs/architecture/bundles/platform-packages.md).

## Entry points

The export map ([`package.json`](package.json)) has two kinds of entries:

- **Conditional entries** — `.`, `./client`, `./protocol`, `./reads`, `./ui`, every other `./ui/<name>` in the table below and the pattern `./ui/*` — point the `@org/source` condition at the TypeScript source under `src/`, and `types`, `import` and `default` at `dist/`.
- **Plain strings** give the same file to every consumer: `./ui/theme.css` and `./ui/tailwind.css` point at `src/styles/`; `./ui/tokens.json` points at `dist/tokens.json`, which only `desktop:build` writes, so it is missing until that build has run, inside the workspace too; `./package.json` points at the manifest itself.

Which file a conditional entry gives depends on the resolver:

- **The source, through `@org/source`**: TypeScript, through `customConditions` ([`tsconfig.base.json`](../../tsconfig.base.json)); the renderer's webpack, through `conditionNames` ([`webpack.config.js`](../../app/desktop/doric-renderer/webpack.config.js)); the root scripts run with `node --conditions=@org/source` ([`package.json`](../../package.json)); and the platform build, which reads the `@org/source` key of each entry directly ([`build.mjs`](../../app/desktop/doric-platform/build.mjs)).
- **`dist/`**: the esbuild build of bundle parts sets no conditions ([`parts.ts`](../bundle/src/build/parts.ts)), so a part that imports `desktop/reads` bundles `dist/reads/index.js` and a part that imports `desktop/protocol` bundles `dist/client/protocol.js`. `desktop:build` runs before such a bundle build: a bundle project that lists `desktop` among its dependencies gets that order from `"dependsOn": ["^build"]` (for example [`bundles/desktop/chat/project.json`](../../bundles/desktop/chat/project.json)).
- **`dist/`**: the nx-electron webpack build of the Electron main process and the preload compiles only its own sources and takes workspace packages from their built entries in `dist/` ([`webpack.config.js`](../../app/desktop/doric/webpack.config.js)). So main runs the `desktop/protocol` of the last `desktop:build`, and a change to `protocol.ts` reaches main only after that build. `doric-app:build` runs the build of the workspace packages it imports first, through `"dependsOn": ["^build", …]` ([`project.json`](../../app/desktop/doric/project.json)).

| Specifier                      | File                                                               | Contents                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop`, `desktop/ui`        | [`src/index.ts`](src/index.ts)                                     | `ChromeBar`, `cn`, `PortalContainerProvider`, `usePortalContainer`, `defineReactElement`, `portalHosts`, `tokens`, `tokensCss`, `resolvedVariables`, `windowVariables`, and the types `ChromeBarProps`, `PortalContainerProviderProps`, `PortalHost`, `PortalHosts`, `ReactElementInstance`, `ReactElementOptions`, `Tokens`, `TokenSet` |
| `desktop/ui/<component>`       | `src/components/<component>.tsx` (pattern `./ui/*`)                | One shadcn component file ([The shadcn components](#the-shadcn-components))                                                                                                                                                                                                                                                              |
| `desktop/ui/utils`             | [`src/lib/utils.ts`](src/lib/utils.ts)                             | `cn` ([`cn`](#cn))                                                                                                                                                                                                                                                                                                                       |
| `desktop/ui/portal-container`  | [`src/portal-container.tsx`](src/portal-container.tsx)             | `PortalContainerProvider`, `usePortalContainer` ([`PortalContainerProvider`](#portalcontainerprovider-and-useportalcontainer))                                                                                                                                                                                                           |
| `desktop/ui/react-element`     | [`src/react-element.ts`](src/react-element.ts)                     | `defineReactElement`, `portalHosts` and their types ([`defineReactElement`](#definereactelement-and-portalhosts))                                                                                                                                                                                                                        |
| `desktop/ui/chrome-bar`        | [`src/chrome-bar.tsx`](src/chrome-bar.tsx)                         | `ChromeBar`, `ChromeBarProps` ([`ChromeBar`](#chromebar))                                                                                                                                                                                                                                                                                |
| `desktop/ui/element-host`      | [`src/element-host.tsx`](src/element-host.tsx)                     | `ElementHost`, `useRegionItems` ([`ElementHost`](#elementhost-and-useregionitems))                                                                                                                                                                                                                                                       |
| `desktop/ui/error-notice`      | [`src/error-notice.tsx`](src/error-notice.tsx)                     | `ErrorNotice`, `ErrorNoticeProps`, `toastError`, `ToastErrorInput` ([The error notice](#the-error-notice-desktopuierror-notice))                                                                                                                                                                                                         |
| `desktop/ui/model-icon`        | [`src/model-icon.tsx`](src/model-icon.tsx)                         | `ModelIcon` ([`ModelIcon`](#modelicon-and-svgmask))                                                                                                                                                                                                                                                                                      |
| `desktop/ui/choice-list`       | [`src/choice-list.tsx`](src/choice-list.tsx)                       | `ChoiceList`, `ChoiceListProps` ([`ChoiceList`](#choicelist))                                                                                                                                                                                                                                                                            |
| `desktop/ui/collapsible-block` | [`src/collapsible-block.tsx`](src/collapsible-block.tsx)           | `CollapsibleBlock`, `blockOpen`, `blockToggled`, `Chosen`, `Openness`, `CollapsibleBlockProps` ([`CollapsibleBlock`](#collapsibleblock-blockopen-and-blocktoggled))                                                                                                                                                                      |
| `desktop/ui/comment-pin`       | [`src/comment-pin.tsx`](src/comment-pin.tsx)                       | `CommentPin`, `commentPinVariants`, `CommentPinState`, `CommentPinSize`, `CommentPinProps` ([`CommentPin`](#commentpin))                                                                                                                                                                                                                 |
| `desktop/ui/identity`          | [`src/identity/index.ts`](src/identity/index.ts)                   | `initials`, `identityTone`, `identityRing`, `READER_NAME` ([Identity](#identity-desktopuiidentity-desktopuireader-avatar))                                                                                                                                                                                                               |
| `desktop/ui/reader-avatar`     | [`src/identity/reader-avatar.tsx`](src/identity/reader-avatar.tsx) | `ReaderAvatar` ([Identity](#identity-desktopuiidentity-desktopuireader-avatar))                                                                                                                                                                                                                                                          |
| `desktop/ui/panels`            | [`src/panels/index.ts`](src/panels/index.ts)                       | The panel widgets and the `@dnd-kit` sorting they use ([Panels](#panels-desktopuipanels))                                                                                                                                                                                                                                                |
| `desktop/ui/code`              | [`src/code/index.ts`](src/code/index.ts)                           | `CodeView`, `DiffEditor`, `DiffControls`, `fileLanguage` ([Code view](#code-view-and-diff-editor-desktopuicode))                                                                                                                                                                                                                         |
| `desktop/ui/viewport`          | [`src/viewport.ts`](src/viewport.ts)                               | Pan-and-zoom math ([Viewport](#viewport-desktopuiviewport))                                                                                                                                                                                                                                                                              |
| `desktop/ui/svg-mask`          | [`src/svg-mask.ts`](src/svg-mask.ts)                               | `svgMask` ([`svgMask`](#modelicon-and-svgmask))                                                                                                                                                                                                                                                                                          |
| `desktop/ui/cmdk`              | [`src/cmdk.ts`](src/cmdk.ts)                                       | `CommandPrimitive`, the `Command` of `cmdk` ([`CommandPrimitive`](#commandprimitive))                                                                                                                                                                                                                                                    |
| `desktop/ui/tokens`            | [`src/tokens/tokens.ts`](src/tokens/tokens.ts)                     | `tokens`, `Tokens`, `TokenSet` ([Tokens](#tokens))                                                                                                                                                                                                                                                                                       |
| `desktop/ui/tokens.json`       | `dist/tokens.json`                                                 | The `tokens` value as JSON, written by `desktop:build`. The platform build copies it into the window assets ([`build.mjs`](../../app/desktop/doric-platform/build.mjs)) and the main process reads it ([`tokens.ts`](../../app/desktop/doric/src/platform/tokens.ts)) ([Tokens](#tokens))                                                |
| `desktop/ui/theme.css`         | [`src/styles/theme.css`](src/styles/theme.css)                     | The stylesheet every window loads once ([Stylesheets](#stylesheets))                                                                                                                                                                                                                                                                     |
| `desktop/ui/tailwind.css`      | [`src/styles/tailwind.css`](src/styles/tailwind.css)               | The Tailwind reference entry bundle stylesheets `@reference` ([Stylesheets](#stylesheets))                                                                                                                                                                                                                                               |
| `desktop/reads`                | [`src/reads/index.ts`](src/reads/index.ts)                         | [Reads](#reads-desktopreads)                                                                                                                                                                                                                                                                                                             |
| `desktop/protocol`             | [`src/client/protocol.ts`](src/client/protocol.ts)                 | [The window–main protocol](#the-windowmain-protocol-desktopprotocol)                                                                                                                                                                                                                                                                     |
| `desktop/client`               | [`src/client/index.ts`](src/client/index.ts)                       | [The window runtime](#the-window-runtime-desktopclient), and everything `desktop/protocol` exports                                                                                                                                                                                                                                       |
| `desktop/package.json`         | [`package.json`](package.json)                                     | The manifest ([Build and test](#build-and-test))                                                                                                                                                                                                                                                                                         |

The `./ui/*` pattern and the explicit `./ui/<name>` subpaths share one name space, and the resolvers treat a clash differently. TypeScript and webpack take the explicit subpath, so a component file named like one is unreachable through them. The platform build lists `src/components/*.tsx` when it runs and gives every file its own import-map entry `desktop/ui/<file>`, emitted as `<file>.js`, next to the explicit entries (`./ui` is emitted as `index.js`). It throws `<dir>: two entries emit <file>.js.` when two entries emit the same file, so a component file named `code`, `panels`, `identity`, `tokens`, `viewport`, like any other explicit subpath, or `index`, fails the window build ([`build.mjs`](../../app/desktop/doric-platform/build.mjs)). No component file clashes with an explicit subpath.

The import map serves `desktop/ui`, every conditional `./ui/<name>` entry and every component file. It leaves out `desktop`, `desktop/ui/theme.css`, `desktop/ui/tailwind.css` and `desktop/ui/tokens.json`: the platform build skips every key outside `./ui` and every plain-string entry ([`build.mjs`](../../app/desktop/doric-platform/build.mjs)). `desktop` and `desktop/ui` are the same module, and a client part imports it as `desktop/ui`.

The top-level `main` and `module` fields name `./dist/index.js` and `types` names `./dist/index.d.ts`, for tools that do not read `exports`.

### What a bundle part may import

The build of a bundle part fails on a forbidden import with `A <part> part must not import "<specifier>".` ([`parts.ts`](../bundle/src/build/parts.ts)). For this package:

- **desktopMain part**: no specifier of this package — neither `desktop` nor any `desktop/*`.
- **client part**: not bare `desktop` (it imports `desktop/ui`), and neither `desktop/client` nor any `desktop/client/*`. `desktop/ui` and `desktop/ui/*` stay external and come from the import map; `desktop/reads` and `desktop/protocol` are bundled into the part ([`externals.ts`](../bundle/src/build/externals.ts)).
- **frame** (an entry under `src/client/frames/` and the modules it bundles): neither `desktop` nor any `desktop/*`, `desktop/ui` included.

### Dependencies

The runtime dependencies are React and ReactDOM, Base UI (`@base-ui/react`), `cmdk`, `cn`, `class-variance-authority`, `lucide-react`, `sonner`, `@dnd-kit/*`, `react-resizable-panels`, `monaco-editor`, Tailwind CSS, `tw-animate-css`, `shadcn`, `tslib`, `zod` and the workspace package `bundle`; their version ranges are in [`package.json`](package.json). `@tanstack/query-core` (`^5.104.1`) is a peer dependency, required (the manifest has no `peerDependenciesMeta`), and a devDependency. The package imports only its types `Query` and `QueryClient` ([`refresh.ts`](src/reads/refresh.ts)); the caller of `refreshQueries` passes in its own `QueryClient` ([Refresh](#refresh)).

## Shared UI (`desktop/ui`)

### `cn`

```ts
function cn(...inputs: ClassValue[]): string;
```

`cn` joins class names and merges conflicting Tailwind classes; it is the `cn` package's function re-exported, and a `ClassValue` is a string, number, bigint, boolean, `null`, `undefined`, or an array or dictionary of them ([`utils.ts`](src/lib/utils.ts)).

### The shadcn components

`src/components/` holds shadcn/ui files in the `base-nova` style, built on Base UI primitives, with Tailwind CSS and `lucide` icons ([`components.json`](components.json)). Each file is one subpath, `desktop/ui/<file>`. The platform build emits every explicit subpath and every component file as `<name>.js` in one folder, so a component file named like an explicit subpath (`index`, `tokens`, `utils`, `code`, `panels` and the others of [Entry points](#entry-points)) fails the build with `<dir>: two entries emit <name>.js.` ([`build.mjs`](../../app/desktop/doric-platform/build.mjs)):

| Subpath         | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alert`         | `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `alert-dialog`  | `AlertDialog`, `AlertDialogTrigger`, `AlertDialogPortal`, `AlertDialogOverlay`, `AlertDialogContent`, `AlertDialogHeader`, `AlertDialogFooter`, `AlertDialogMedia`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel`                                                                                                                                                                                                                   |
| `badge`         | `Badge`, `badgeVariants` (variants `default`, `secondary`, `destructive`, `outline`, `ghost`, `link`)                                                                                                                                                                                                                                                                                                                                                                        |
| `breadcrumb`    | `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbPage`, `BreadcrumbSeparator`, `BreadcrumbEllipsis`                                                                                                                                                                                                                                                                                                                                            |
| `button`        | `Button`, `buttonVariants`: `variant` `default` (default), `outline`, `secondary`, `solid`, `ghost`, `destructive`, `link`; `size` `default` (default), `xs`, `sm`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`                                                                                                                                                                                                                                                            |
| `button-group`  | `ButtonGroup`, `ButtonGroupSeparator`, `ButtonGroupText`, `buttonGroupVariants`                                                                                                                                                                                                                                                                                                                                                                                              |
| `checkbox`      | `Checkbox`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `collapsible`   | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `combobox`      | `Combobox`, `ComboboxInput`, `ComboboxContent`, `ComboboxList`, `ComboboxItem`, `ComboboxGroup`, `ComboboxLabel`, `ComboboxCollection`, `ComboboxEmpty`, `ComboboxSeparator`, `ComboboxChips`, `ComboboxChip`, `ComboboxChipsInput`, `ComboboxTrigger`, `ComboboxValue`, `useComboboxAnchor`                                                                                                                                                                                 |
| `command`       | `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandShortcut`, `CommandSeparator`                                                                                                                                                                                                                                                                                                                              |
| `context-menu`  | `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuCheckboxItem`, `ContextMenuRadioItem`, `ContextMenuRadioGroup`, `ContextMenuLabel`, `ContextMenuSeparator`, `ContextMenuShortcut`, `ContextMenuGroup`, `ContextMenuPortal`, `ContextMenuSub`, `ContextMenuSubTrigger`, `ContextMenuSubContent`                                                                                                                                     |
| `dialog`        | `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose`                                                                                                                                                                                                                                                                                                               |
| `dropdown-menu` | `DropdownMenu`, `DropdownMenuPortal`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent`                                                                                                                      |
| `empty`         | `Empty`, `EmptyHeader`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`, `EmptyMedia`                                                                                                                                                                                                                                                                                                                                                                                       |
| `field`         | `Field`, `FieldLabel`, `FieldDescription`, `FieldError`, `FieldGroup`, `FieldLegend`, `FieldSeparator`, `FieldSet`, `FieldContent`, `FieldTitle`                                                                                                                                                                                                                                                                                                                             |
| `input`         | `Input`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `input-group`   | `InputGroup`, `InputGroupAddon`, `InputGroupButton`, `InputGroupText`, `InputGroupInput`, `InputGroupTextarea`                                                                                                                                                                                                                                                                                                                                                               |
| `kbd`           | `Kbd`, `KbdGroup`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `label`         | `Label`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `marker`        | `Marker`, `MarkerIcon`, `MarkerContent`, `markerVariants` (variants `default`, `separator`, `border`)                                                                                                                                                                                                                                                                                                                                                                        |
| `popover`       | `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverHeader`, `PopoverTitle`, `PopoverDescription`                                                                                                                                                                                                                                                                                                                                                                         |
| `progress`      | `Progress`, `ProgressTrack`, `ProgressIndicator`, `ProgressLabel`, `ProgressValue`                                                                                                                                                                                                                                                                                                                                                                                           |
| `resizable`     | `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` (`react-resizable-panels`)                                                                                                                                                                                                                                                                                                                                                                                        |
| `scroll-area`   | `ScrollArea`, `ScrollBar`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `select`        | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton`                                                                                                                                                                                                                                                                                                   |
| `separator`     | `Separator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sheet`         | `Sheet`, `SheetTrigger`, `SheetClose`, `SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription`                                                                                                                                                                                                                                                                                                                                                        |
| `sidebar`       | `SidebarProvider`, `Sidebar`, `SidebarScope`, `useSidebar`, `SidebarTrigger`, `SidebarRail`, `SidebarInset`, `SidebarInput`, `SidebarHeader`, `SidebarFooter`, `SidebarSeparator`, `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupAction`, `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarMenuAction`, `SidebarMenuBadge`, `SidebarMenuSkeleton`, `SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton` |
| `skeleton`      | `Skeleton`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sonner`        | `Toaster`, `toast`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `switch`        | `Switch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `table`         | `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, `TableCaption`                                                                                                                                                                                                                                                                                                                                                                     |
| `tabs`          | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `tabsListVariants` (variants `default`, `line`)                                                                                                                                                                                                                                                                                                                                                                            |
| `textarea`      | `Textarea`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `toggle`        | `Toggle`, `toggleVariants` (variants `default`, `outline`; sizes `default`, `sm`, `lg`)                                                                                                                                                                                                                                                                                                                                                                                      |
| `toggle-group`  | `ToggleGroup`, `ToggleGroupItem`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tooltip`       | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`                                                                                                                                                                                                                                                                                                                                                                                                             |

Behavior that differs from the stock shadcn files:

- **Portal container.** The overlays — `AlertDialog`, `Combobox`, `ContextMenu`, `Dialog`, `DropdownMenu`, `Popover`, `Select`, `Sheet`, `Tooltip` and the components built on them — portal their content into the container the nearest `PortalContainerProvider` names, or into `document.body` outside one (for example [`dialog.tsx`](src/components/dialog.tsx)). Only `AlertDialogPortal`, `DialogPortal`, `ContextMenuPortal` and `DropdownMenuPortal` are exported; a `container` passed directly to one of them wins. The content of `Popover`, `Select`, `Combobox`, `Tooltip` and `Sheet` takes no container from the caller, only the provider's.
- **`ScrollArea`** takes `scrollbars?: 'vertical' | 'both'` (default `'vertical'`, the vertical bar alone). `'both'` renders a horizontal `ScrollBar` after the vertical one, which Base UI mounts only while the content overflows sideways. The prop is not passed to the root element ([`scroll-area.tsx`](src/components/scroll-area.tsx)).
- **`Button`** ([`button.tsx`](src/components/button.tsx)): the `default` variant hovers with `color-mix(in oklch, var(--primary), var(--foreground) 60%)` in light and `color-mix(in oklch, var(--primary), var(--primary-foreground) 8%)` in dark. The `solid` variant is a white control whose text stays dark in either theme: `border-[var(--border)] bg-white text-[#101010] shadow-sm hover:bg-[#fafafa]`.
- **Dialog footers.** `DialogFooter` and `AlertDialogFooter` have no `border-t`, so no rule is drawn above a footer ([`dialog.tsx`](src/components/dialog.tsx), [`alert-dialog.tsx`](src/components/alert-dialog.tsx)).
- **Font weights.** Labels and titles take `font-normal` (400) where shadcn writes `font-medium`, in `alert-dialog`, `alert`, `badge`, `button-group`, `button`, `combobox`, `command`, `context-menu`, `dialog`, `dropdown-menu`, `empty`, `field`, `input-group`, `input`, `kbd`, `label`, `popover`, `progress`, `sheet`, `sidebar`, `table`, `tabs` and `toggle`. `field`'s description and error take `font-light` (300) ([`field.tsx`](src/components/field.tsx)).
- **Sidebar menu action.** `SidebarMenuAction` also carries the `group-hover/menu-sub-item` and `group-focus-within/menu-sub-item` classes, so it shows on hover and focus inside a sub-item as well as inside an item ([`sidebar.tsx`](src/components/sidebar.tsx)).
- **`SidebarScope`** provides the sidebar context alone, with no wrapper element and no keyboard shortcut: inside it, a component reads the outer `SidebarProvider`'s context when there is one, and otherwise an expanded, non-mobile state whose setters do nothing. An element that draws sidebar rows from its own React root uses it ([`sidebar.tsx`](src/components/sidebar.tsx)).
- **`Toaster`** follows the system theme by default (`theme="system"`), uses lucide icons for each toast type and paints toasts with `--popover`, `--popover-foreground`, `--border` and `--radius`. Each toast also gets the class `cn-toast`, which no stylesheet defines. `toast` is re-exported from `sonner`, so every caller in a window reaches the store the window's `Toaster` reads ([`sonner.tsx`](src/components/sonner.tsx)).

Stock shadcn behavior callers rely on: `SidebarProvider` writes the open state to the cookie `sidebar_state` (path `/`, max-age seven days) on every change and never reads it back, so the initial state comes from its `defaultOpen` or `open` prop; it toggles on ⌘B / Ctrl+B and lays the sidebar out at `16rem` (`18rem` on mobile, `3rem` collapsed to icons); below 768 px wide the window counts as mobile ([`sidebar.tsx`](src/components/sidebar.tsx), [`use-mobile.ts`](src/hooks/use-mobile.ts)). `useSidebar` outside both a `SidebarProvider` and a `SidebarScope` throws `useSidebar must be used within a SidebarProvider.`

#### Provenance check

Each component file, plus [`use-mobile.ts`](src/hooks/use-mobile.ts) and [`utils.ts`](src/lib/utils.ts), has a recorded origin in [`provenance.json`](tests/fixtures/provenance.json): `registry` (the output of the shadcn CLI `shadcn@4.21.0`, style `base-nova`, formatted with the repository's Prettier) or `renderer` (the file `app/doric-renderer` holds at commit `20775a6`, read with `git show`, so it need not exist in the working tree), with the SHA-256 of that original. [`PROVENANCE.md`](PROVENANCE.md) is the record of each file's origin and patches that the check's messages refer to. A component is changed through a recorded patch, never by hand alone.

Imports are relative `.js` paths, so the platform's esbuild and Node resolve them alike. The check maps them back to what the origin writes:

| Origin     | Origin's import          | `desktop/ui` import      |
| ---------- | ------------------------ | ------------------------ |
| `registry` | `@/components/<name>`    | `./<name>.js`            |
| `registry` | `@/hooks/use-mobile`     | `../hooks/use-mobile.js` |
| `renderer` | `@/components/ui/<name>` | `./<name>.js`            |
| `renderer` | `@/utility/utils`        | `../lib/utils.js`        |
| `renderer` | `@/hooks/use-mobile`     | `../hooks/use-mobile.js` |

The `registry` files import `cn` from `'cn'`, as the CLI writes them. A leading `'use client';` directive, which the CLI writes in some files only, is dropped from the vendored files and ignored on both sides ([`verify-provenance.mjs`](scripts/verify-provenance.mjs)).

`node packages/desktop/scripts/verify-provenance.mjs` (the second command of `desktop:test`, after the test compile) lists the `.tsx` files of `src/components/` plus the two helpers. For each listed file, it applies the reverse import rewrites, undoes each local patch (a `[patched, before]` text pair the script holds per file, among them the patches listed above), hashes the result and compares it with the record. It prints one line per problem to stderr and exits with 1 when there is any; `<file>` is the path under `src/`, for example `components/button.tsx`:

- `<file>: not in the provenance record` — a file present but unlisted.
- `<file>: listed but missing` — a listed file that is absent.
- `<file>: differs from shadcn@4.21.0 base-nova beyond the import rewrites and PROVENANCE.md patches` (a `registry` file), or `<file>: differs from <renderer path> at 20775a6 beyond the import rewrites and PROVENANCE.md patches` (a `renderer` file).

To add a component, run `npx shadcn@4.21.0 add <name> -c packages/desktop`, rewrite its imports to the table above, add its entry to `files` in `provenance.json`, keyed by its path under `src/` (`components/<name>.tsx`), with `origin: 'registry'` and any `sha256`, and refresh the `registry` hashes, which fills in its hash. A local change to a component is added as a patch pair in the script in the same change. To refresh the record:

- **`registry`**: in a scratch directory holding `components.json` (style `base-nova`), a `tsconfig.json` mapping `@/*` to `./src/*` and a `package.json` naming `react` and `react-dom`, run `npx shadcn@4.21.0 add <names> --yes --overwrite`, where `<names>` is every `registry` component in the record, a new one included, format the output with `npx prettier --config .prettierrc --ignore-path /dev/null --write`, then run `node scripts/verify-provenance.mjs --record-registry <scratch>/src/components`. It rewrites the hash of every `registry` entry already in the record from `<dir>/<name>.tsx`, without its directive; a missing file stops it with an uncaught `ENOENT` error, before it writes the record.
- **`renderer`**: `node scripts/verify-provenance.mjs --record <commit>` rewrites every `renderer` entry from `git show <commit>:<renderer path>` and records the commit; without `<commit>`, the recorded one.

### `PortalContainerProvider` and `usePortalContainer`

```ts
interface PortalContainerProviderProps {
  readonly container: HTMLElement | null | undefined;
  readonly children?: React.ReactNode;
}
function PortalContainerProvider(
  props: PortalContainerProviderProps,
): React.JSX.Element;
function usePortalContainer(): HTMLElement | undefined;
```

The provider names where every overlay below it portals its content; `null` or `undefined` keeps the default, the document body. `usePortalContainer` returns the nearest provider's container, or `undefined` outside one. A React root mounted inside a shadow root names itself, so its overlays stay under its own styles ([`portal-container.tsx`](src/portal-container.tsx)).

### `ChromeBar`

```ts
interface ChromeBarProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly inset?: boolean; // default true
}
function ChromeBar(props: ChromeBarProps): React.JSX.Element;
```

A window's draggable title strip: a `div` with `data-slot="chrome-bar"`, the class `chrome-bar` (height `var(--doric-titlebar-height)`, from [`theme.css`](src/styles/theme.css)), flex row and `app-region: drag`. With `inset`, it pads its leading edge by `--doric-safe-left`, the room the macOS window buttons take. Controls inside it that must stay clickable set `[app-region:no-drag]` ([`chrome-bar.tsx`](src/chrome-bar.tsx)).

### `defineReactElement` and `portalHosts`

```ts
interface ReactElementOptions<P extends object> {
  readonly render: ComponentType<P & { readonly services: Services }>;
  readonly props: readonly (keyof P & string)[];
  readonly wrap?: (
    services: Services,
  ) => ComponentType<{ readonly children?: ReactNode }>;
  readonly display?: string; // default 'contents'
}
interface ReactElementInstance extends HTMLElement {
  services: Services;
  dispose(): void;
}
function defineReactElement<P extends object>(
  options: ReactElementOptions<P>,
): new () => ReactElementInstance;
```

`defineReactElement` returns a custom element class and does not register it: the caller defines its tag, a bundle through `ui.define(tag, Class)` ([React inside Web Components](../../docs/architecture/bundles/react-web-components.md)). The element's content is `render`, drawn in the element's light DOM with the services of the bundle that owns the element ([`react-element.ts`](src/react-element.ts)):

- Each name in `props` becomes a property of the element; setting it, or setting `services`, re-renders. Nothing renders until the element is connected and has `services`.
- On connection the element sets its own `style.display` to `display` (default `contents`), not in its constructor.
- `wrap`, when given, is called once per element, with the services of its first render, and wraps the content (a query client or a state provider). A later `services` value, a disposal and a new connection keep that wrapper.
- All elements of one class render through portals of one React root the class creates on first render, in mount order; each element's content sits in its own error boundary, so content that throws empties only its own element. The boundary stays failed: the element stays empty through later property and `services` changes, until it is disposed and connected again, which mounts it under a new key and a new boundary.
- When an element is disconnected and still disconnected one microtask later, its content unmounts. `dispose()` unmounts it at once with `flushSync`; it is idempotent, and a later connection mounts again.

```ts
interface PortalHost<P extends object> {
  readonly element: HTMLElement;
  readonly props: Readonly<Partial<P>>;
}
interface PortalHosts<P extends object> {
  readonly Element: new () => HTMLElement;
  useHosts(): readonly PortalHost<P>[];
}
function portalHosts<P extends object>(
  properties: readonly (keyof P & string)[],
): PortalHosts<P>;
```

`portalHosts` makes host elements with no React root of their own: `Element` is `display: contents`, carries a `services` field and the listed properties, and `useHosts()` returns the connected hosts in connection order (frozen snapshots), re-rendering when one connects, disconnects or, while connected, has a listed property set. Setting `services` notifies no one, nor does setting a property on a disconnected host; a host that reconnects moves to the end. The root that owns them renders their content with `createPortal` and reads a host's services as `host.element.services` ([`react-element.ts`](src/react-element.ts)). How bundles build elements on these classes is in [React inside Web Components](../../docs/architecture/bundles/react-web-components.md).

### `ElementHost` and `useRegionItems`

```ts
function ElementHost(props: {
  readonly ui: Ui; // the caller's ui/v1
  readonly tag: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly className?: string; // default 'contents'
}): ReactElement;
function useRegionItems(
  regions: Regions,
  region: string,
): readonly RegionEntry[];
```

`ElementHost` draws another bundle's element (a panel view, a view's badge). On mount and whenever `tag` changes it calls `ui.create(tag, props)` with the props current at that moment and places the element in its host `div`; on unmount or tag change it empties the host and calls `ui.dispose(element)`, ignoring a dispose that throws. A new `ui` object or new `props` alone do not create the element again, and later `props` never reach the element. When `ui.create` throws, it logs `Doric: the element <tag> could not be created:` to the console and draws, for that tag, a compact, announced `ErrorNotice` with code `element_failed` (title "View failed to open", not retryable), message `The element <tag> could not be created.`, the thrown error as its cause and the context line `Element: <tag>`. The notice takes the place of the host `div`, so `className` does not apply to it ([`element-host.tsx`](src/element-host.tsx)).

`useRegionItems` returns `regions.items(region)`, the region's items in the order `regions/v1` gives, through `useSyncExternalStore` on `regions.subscribe(region, …)`, and an empty frozen array on the server snapshot. It adds no memoisation: the array stays the same until the region changes because `regions.items` returns the same array. `Ui`, `Regions` and `RegionEntry` come from `bundle/contracts` ([Contracts](../../docs/architecture/bundles/contracts.md)).

### The error notice (`desktop/ui/error-notice`)

`ErrorNotice` shows one `ErrorInfo` the same way on every surface; `ErrorInfo` and `ErrorCatalog` are the types of [`desktop/reads`](#the-error-value) ([`error-notice.tsx`](src/error-notice.tsx)):

```ts
interface ErrorNoticeProps {
  readonly error: ErrorInfo;
  readonly variant?: 'block' | 'compact' | 'inline'; // default 'block'
  readonly icon?: LucideIcon;
  readonly catalog?: ErrorCatalog;
  readonly fallbackCode?: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly onRetry?: () => void;
  readonly retrying?: boolean; // default false
  readonly announce?: boolean; // default false
  readonly className?: string;
}
function ErrorNotice(props: ErrorNoticeProps): React.JSX.Element;
```

- **Layout.** Row 1: the tone icon (`icon` when given; else a triangle for tone `warning`, a circle for `error`), the title, Retry and Copy details. Row 2 (`block` and `compact`): the explanation and a Details/Hide details link. Below: the details in a collapsible, closed on first render, as a focusable `<pre>` labelled "Error details", at most `max-h-40` with its own scroll. `block` draws a thin card; `compact` has no card; `inline` is row 1 only. The root carries `data-slot="error-notice"`, `data-variant` and `data-tone`.
- **Words.** Title, explanation, Retry flag and tone come from `describeError` (below). Retry shows only when `onRetry` is given and the copy is retryable; `retrying` disables it, spins its icon and sets `aria-busy`.
- **Details text.** `Code: <code or none>`, then `Provider:`, `Status:` and `Message:` when present, one `Caused by: [code] message (provider, status)` line per cause, one `<label>: <value>` line per `context` entry, and `Time: <at>` when `at` is present; continuation lines are indented by two spaces.
- **Copy details** writes `title`, `explanation`, a blank line and the details text to the clipboard, and shows "Copied" or "Copy failed" for 1,500 ms; no clipboard, a thrown call or a rejected write all report "Copy failed", and nothing is thrown.
- **Buttons.** Retry and Copy details are ghost `icon-xs` buttons whose word ("Retry"; "Copy details", "Copied" or "Copy failed") is both their `aria-label` and their `title`; the copy icon becomes a check while "Copied".
- **Screen readers.** The root has `aria-labelledby` on the title and, when an explanation is shown (`block` and `compact` with a non-blank explanation), `aria-describedby` on it. Outside a toast, a visually hidden `role="status"`, `aria-live="polite"` span announces "Copied" or "Copy failed". Inside a toast there is no such live region, and the details carry `aria-live="off"`.
- **Announcement.** With `announce`, the notice has `role="alert"` the first time this window shows its key (code, message, `at` and context), else `role="group"`. The window remembers the last 200 keys. The role is decided at mount and when the key changes, so a repeated render gives the same answer.
- It never throws while rendering and never moves focus.

```ts
interface ToastErrorInput {
  readonly id: string;
  readonly error: ErrorInfo;
  readonly catalog?: ErrorCatalog;
  readonly fallbackCode?: string;
  readonly context?: Readonly<Record<string, string>>;
}
function toastError(input: ToastErrorInput): void;
```

`toastError` shows a `compact`, unannounced notice, without Retry, as a `sonner` custom toast (`data-slot="error-toast"`, 356 px wide). It lives 4,000 ms (sonner pauses it while the pointer is over the toaster or the window is hidden) and does not expire while its details are open; closing them shows it again for a fresh 4,000 ms. A later call with the same `id` replaces it in place, with its details closed. It needs the window's `Toaster` mounted to be seen; it returns nothing and never throws.

#### How a notice words an error

`describeError(info, { catalog?, fallbackCode? })` returns `{ title, explanation, retryable, tone }`. No entry point exports it or the shared catalog, so the shared entries exist once per window, in the platform's `error-notice` file ([`error-copy.ts`](src/error-copy.ts)):

1. The catalog is `catalog` merged over the shared catalog; the caller's entry wins for a code both list.
2. The headline level is the first of `[info, ...info.causes]` whose code has an entry and is not `internal`. Without one, `fallbackCode`'s entry titles the outermost level; without that, the first `internal` level takes the `internal` entry; without that, the `unknown` entry titles the outermost level.
3. `explanation` is the entry's explanation with `{provider}` filled with the headline level's provider, else `info.provider`, else `the provider`. Without one, it is the first line of the headline level's message, trimmed, else that of `info.message`, else `The operation could not be completed.`; a first line that is empty after trimming falls through to the next source, and a line over 200 characters is cut to 199 and ends with `…`.
4. `retryable` is the entry's flag unless the headline level says `retryable: false`; under the `unknown` fallback it is the headline level's own flag, default `true`. `tone` is the entry's, default `error`.

The shared catalog holds the codes the platform packages define (`bundle`, `llms`, `agent`, `tool`); every entry has tone `error`. A bundle passes its own codes, and its own wording for a shared code, in its own `catalog` ([`error-copy.ts`](src/error-copy.ts)):

| Code                               | Title                      | Explanation                                                          | Retry |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------- | ----- |
| `unknown`                          | Something went wrong       | —                                                                    | yes   |
| `internal`                         | Something went wrong       | —                                                                    | yes   |
| `unavailable`                      | Doric host unavailable     | This window lost its connection to the Doric host.                   | yes   |
| `disconnected`                     | Doric host unavailable     | This window lost its connection to the Doric host.                   | yes   |
| `generation_lost`                  | Doric host unavailable     | This window lost its connection to the Doric host.                   | yes   |
| `protocol_error`                   | Doric host unavailable     | This window lost its connection to the Doric host.                   | yes   |
| `invalid_output`                   | Unexpected output          | —                                                                    | yes   |
| `invalid_input`                    | Request refused            | —                                                                    | no    |
| `not_found`                        | Not found                  | —                                                                    | no    |
| `conflict`                         | Not possible right now     | —                                                                    | no    |
| `revision_conflict`                | Changed elsewhere          | Something else changed this first. Retry to use the latest version.  | yes   |
| `limit_exceeded`                   | Limit reached              | —                                                                    | no    |
| `credential_missing`               | Credential not found       | —                                                                    | no    |
| `credential_invalid`               | Credential rejected        | —                                                                    | no    |
| `credential_name_taken`            | Name already used          | Another credential already has this name.                            | no    |
| `credential_kind_immutable`        | Kind cannot change         | A stored credential keeps its kind; create a new credential instead. | no    |
| `credential_storage_unavailable`   | Secret storage unavailable | The host cannot store credential secrets right now.                  | yes   |
| `network_error`                    | Provider unreachable       | Doric could not reach {provider}.                                    | yes   |
| `incomplete_stream`                | Response cut off           | {provider} ended the response before it finished.                    | yes   |
| `rate_limit_error`                 | Rate limit reached         | {provider} is limiting requests; wait a moment, then retry.          | yes   |
| `overloaded_error`                 | Provider overloaded        | {provider} is overloaded; wait a moment, then retry.                 | yes   |
| `api_error`                        | Provider error             | {provider} reported an error while answering.                        | yes   |
| `provider_error`                   | Provider error             | {provider} reported an error while answering.                        | yes   |
| `http_error`                       | Provider request failed    | {provider} answered with an error status.                            | yes   |
| `auth_failed`                      | Sign-in rejected           | {provider} refused the credentials.                                  | no    |
| `auth_missing`                     | Credentials missing        | {provider} needs a credential.                                       | no    |
| `auth_ambiguous`                   | Credentials ambiguous      | More than one credential matches {provider}.                         | no    |
| `malformed_stream_event`           | Unreadable response        | {provider} sent a response Doric could not read.                     | yes   |
| `missing_stream_finish`            | Unreadable response        | {provider} sent a response Doric could not read.                     | yes   |
| `invalid_json`                     | Unreadable data            | —                                                                    | yes   |
| `missing_model`                    | No model chosen            | —                                                                    | no    |
| `unsupported_model_feature`        | Not supported by the model | —                                                                    | no    |
| `incompatible_model_request`       | Not supported by the model | —                                                                    | no    |
| `output_truncated`                 | Response too long          | The model stopped at its output limit.                               | yes   |
| `provider_refusal`                 | The model refused          | —                                                                    | no    |
| `turn_limit_exceeded`              | Turn limit reached         | The agent stopped after its maximum number of turns.                 | yes   |
| `missing_provider_finish`          | Response ended early       | The model's response ended without a finish.                         | yes   |
| `invalid_structured_output`        | Unexpected model output    | —                                                                    | yes   |
| `concurrent_run`                   | Already running            | A run is already in progress.                                        | no    |
| `tool_call_id_collision`           | Invalid tool call          | —                                                                    | yes   |
| `tool_call_id_invalid`             | Invalid tool call          | —                                                                    | yes   |
| `tool_input_serialization_failed`  | Invalid tool call          | —                                                                    | yes   |
| `tool_result_serialization_failed` | Invalid tool call          | —                                                                    | yes   |
| `handler_failed`                   | Tool failed                | —                                                                    | no    |
| `invalid_payload`                  | Invalid tool input         | —                                                                    | no    |
| `unknown_tool`                     | Unknown tool               | —                                                                    | no    |
| `invalid_schema`                   | Invalid tool definition    | —                                                                    | no    |

The behavior of error messages across the app is in the feature doc [Error messages](../../docs/features/error-messages.md).

### `ModelIcon` and `svgMask`

```ts
function svgMask(svg: string): string; // url("data:image/svg+xml,<percent-encoded svg>")
function ModelIcon(props: {
  readonly svg?: string;
  readonly inlineStart?: boolean;
  readonly className?: string;
}): JSX.Element;
```

`svgMask` turns SVG markup into a CSS image URL with the markup percent-encoded, so no character ends the quoted URL; the SVG is decoded as an image, which runs no script and loads nothing ([`svg-mask.ts`](src/svg-mask.ts)). `ModelIcon` is a 16 px `<span aria-hidden="true" data-slot="model-icon">` filled with the text colour and masked by the SVG (`center / contain no-repeat`, also as `-webkit-mask`); without `svg` it is an empty slot of the same size. `inlineStart` sets `data-icon="inline-start"`, so a `Button` pads for it as for a leading icon ([`model-icon.tsx`](src/model-icon.tsx)).

### `ChoiceList`

```ts
interface ChoiceListProps {
  readonly choices: readonly {
    readonly label: string;
    readonly note?: string;
    readonly value: string;
    readonly icon?: string;
  }[];
  readonly onSelect: (value: string) => void;
  readonly compact?: boolean; // default false
  readonly iconSlot?: boolean; // default false
  readonly value?: string;
}
function ChoiceList(props: ChoiceListProps): React.JSX.Element;
```

A column of ghost `Button`s, one per choice, each calling `onSelect(value)` on click; the row whose value equals `value` shows a check. `compact` uses size `xs`, rounded rows, `aria-pressed` and a muted fill on the current row; otherwise size `sm`. `note` is a muted mark after the label; with `iconSlot`, each row draws a `ModelIcon` of its `icon` before the label ([`choice-list.tsx`](src/choice-list.tsx)).

### `CollapsibleBlock`, `blockOpen` and `blockToggled`

```ts
type Chosen = boolean | null;
type Openness = {
  readonly active: boolean;
  readonly hasContent: boolean;
  readonly defaultOpen?: boolean;
};
const blockOpen: (chosen: Chosen, open: Openness) => boolean; // chosen ?? ((defaultOpen ?? active) && hasContent)
const blockToggled: (chosen: Chosen, open: Openness) => boolean; // !blockOpen(chosen, open)
```

A transcript section the reader opens and closes. While the reader has not chosen (`chosen === null`) a block is open while its work is active and it has content, and folds when the work settles; `defaultOpen` keeps it open after it settles. The reader's choice stands over every later change. Both functions are pure and total ([`collapsible-block.tsx`](src/collapsible-block.tsx)).

`CollapsibleBlock` props: `label`, `openness`, `chosen`, `onChosenChange(next)` (called with `blockToggled(chosen, openness)` on a header click), `action?` (`{ content, toggleLabel }`), `focused?` (header in the hover style), `guide?` (default `true`, the left guide line of the open content), `trailing?` (a control at the header's right end), `toggleLabel?` and `children`. It holds no state; the chevron points right when closed and down when open, and the children render only while open ([`collapsible-block.tsx`](src/collapsible-block.tsx)). The header takes one of two forms:

- **Without `action`**: one trigger holding the label and the chevron, with `toggleLabel` as its `aria-label`. The label carries the `shimmer` utility of `shadcn/tailwind.css` while `openness.active`.
- **With `action`**: the label is one trigger, `action.content` follows it, and the chevron is a second trigger that fills the rest of the row; `action.toggleLabel` is the `aria-label` of both. The label does not shimmer, and `toggleLabel` is not used.

### `CommentPin`

```ts
type CommentPinState = 'open' | 'await' | 'done' | 'draft'; // default 'open'
type CommentPinSize = 'sm' | 'md' | 'lg'; // default 'md'
interface CommentPinProps
  extends
    Omit<ComponentProps<'button'>, 'type'>,
    VariantProps<typeof commentPinVariants> {}
function CommentPin(props: CommentPinProps): React.JSX.Element;
const commentPinVariants: (props?: {
  state?: CommentPinState | null;
  size?: CommentPinSize | null;
  className?: string;
}) => string; // a cva
```

A teardrop `<button type="button">` with `data-state` (the `state` prop as passed, absent when it is not) and `data-size` (`md` when not passed): `open` is primary on `--primary-foreground` text, `await` `--paper-orange` with `#1d1300` text, `done` `--paper-green` with `--primary-foreground` text, `draft` a 1.5 px dashed primary border over `--popover` with primary text; sizes are 20, 24 and 28 px with 10, 11 and 12 px text. Every pin has `tabular-nums` and `shadow-md`, scales to 110 % from its bottom-left corner on hover and on keyboard focus (120 ms), and on keyboard focus draws a 2 px outline in `--ring`. It is presentation only: the caller wires what a press does ([`comment-pin.tsx`](src/comment-pin.tsx)).

`commentPinVariants` returns those classes for a `state` and `size` (default `open` and `md`), for an element that is not a `CommentPin` but must look like one.

### Identity (`desktop/ui/identity`, `desktop/ui/reader-avatar`)

Plain strings, no React ([`identity-mark.ts`](src/identity/identity-mark.ts)):

- `initials(name)`: the first letters of the first two parts of `name`, split at any run of characters that are neither letters nor digits, uppercased (`'jao.scheuermann'` → `'JS'`); `'?'` when there is none.
- `identityTone(name)`: `color-mix(in oklch, oklch(0.55 0.18 <h>) 92%, var(--muted))`, where `<h>` is the 32-bit FNV-1a hash of the name modulo 360: starting from `0x811c9dc5`, each code point is XORed in and the hash multiplied by `0x01000193`, kept unsigned.
- `identityRing(name)`: `color-mix(in oklch, <identityTone(name)> 85%, var(--background))`.
- `READER_NAME`: the reader's name, fixed to `'jao.scheuermann'`; the host does not report who the reader is.

`ReaderAvatar({ name, className? })` draws the initials in a 20 px rounded square over `identityTone(name)`, bordered by `identityRing(name)`, hidden from screen readers ([`reader-avatar.tsx`](src/identity/reader-avatar.tsx)).

### Panels (`desktop/ui/panels`)

The panel widgets more than one bundle draws, served once per window so `@dnd-kit` and the toast store are shared. It re-exports `DndContext`, `closestCenter`, `SortableContext`, `horizontalListSortingStrategy`, `restrictToHorizontalAxis` and `restrictToFirstScrollableAncestor`; a bundle's own sortable strip uses these, not a copy of its own ([`panels/index.ts`](src/panels/index.ts)).

**File tree** ([`file-tree.tsx`](src/panels/file-tree.tsx)):

```ts
type TreeNode = {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly children?: readonly TreeNode[];
};
type TreeDecoration = {
  readonly description: string;
  readonly count: number;
  readonly tone?: string;
  readonly letter?: string;
  readonly struck?: boolean;
};
type FileTreeActions = {
  readonly open: (path: string) => void;
  readonly toggle: (path: string) => void;
};
const emptyDirectoryNotice = 'This directory is empty.';
const loadingDirectoryNotice = 'Loading…';
function FileTree(props: {
  actions: FileTreeActions;
  depth: number;
  entries: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  selectedPath?: string;
  decorations?: ReadonlyMap<string, TreeDecoration>;
  rowMenu?: (node: TreeNode) => ReactNode | null;
  pending?: { directory: string; row: ReactNode };
  loading?: ReadonlySet<string>;
}): JSX.Element;
```

`FileTree` renders `<li>` items to hang from a `SidebarMenu` (`role="tree"`) or a `SidebarMenuSub`, starting at `depth`. It reads nothing: the whole tree arrives in `entries`, and `expanded` decides what is drawn. Under each open directory it draws the `pending` row first (when `pending.directory` is that path), then one `loadingDirectoryNotice` line when the path is in `loading` (the row is marked `aria-busy`), else its children, else — with no pending row — `emptyDirectoryNotice`. Rows are `role="treeitem"` with `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded` (directories) and `aria-selected`, which is true only on the file row whose path is `selectedPath`: a directory row is never selected; click, Enter or Space opens a file (`actions.open`) or toggles a directory (`actions.toggle`), ArrowRight expands a closed directory and ArrowLeft collapses an open one. A decoration adds its `description` to the row's label and tooltip (the tooltip is the path) and draws a pinned badge: a directory's `count`, a file's `letter`; the name and the badge take the `tone` classes; `struck` strikes a file's name through, and a row whose decoration has no `tone` shows no change colour. `rowMenu(node)` gives the content of the row's context menu; `null` or no `rowMenu` means none. The tree is windowed: only the lines that intersect the visible part of the nearest clipping ancestors are drawn, plus an overscan of half a viewport and at least 12 lines (64 lines before the first measurement), with spacers holding the height of the rest; the focused row and the pending row stay drawn when scrolled away. A row is 1.75 rem, a notice 1.5 rem ([`tree-window.ts`](src/panels/tree-window.ts)).

**Tree helpers** ([`tree-guides.tsx`](src/panels/tree-guides.tsx), [`tree-skeleton.tsx`](src/panels/tree-skeleton.tsx), [`expansion.ts`](src/panels/expansion.ts)):

- `indentation(depth)`: a row's left padding, `` `${0.375 + 1.25 × depth}rem` ``.
- `treeClassName`: `'mx-0 w-full min-w-0 translate-x-0 gap-0 overflow-hidden border-0 px-0 py-0'`, the class of the nested `SidebarMenuSub` that holds a level.
- `TreeGuides({ depth })`: `null` at depth 0; otherwise an `aria-hidden`, `pointer-events-none` overlay (`absolute inset-0 z-10`) holding one 1 px `bg-sidebar-border` vertical line per level, at `left: ${0.875 + 1.25 × level}rem` for `level` 0 to `depth − 1`.
- `rowInteraction(selected)`: `'hover:bg-sidebar-accent active:bg-sidebar-accent'` when `selected`, else `'hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent active:text-sidebar-foreground'`. No product code calls it; `tests/tree-guides.test.ts` pins its values.
- `TreeSkeleton({ label, root? })`: a `role="status"`, `aria-busy` placeholder named by `label` that mirrors tree rows during the first read; `root` adds one row above, for the node the tree hangs from.
- `toggleExpanded(expanded, path)`: a new set with `path` added when absent and removed when present.

**Tab strip** ([`tab-strip.tsx`](src/panels/tab-strip.tsx), [`use-tab-strip.ts`](src/panels/use-tab-strip.ts)):

```ts
type StripTab = {
  id: string;
  label: string;
  ariaLabel?: string;
  title?: string;
  icon: ReactNode;
  badge?: ReactNode;
  iconOnly?: boolean;
};
function TabStrip(props: {
  items: readonly StripTab[];
  selected?: string;
  label: string;
  onMove: (from: string, to: string) => void;
  onClose?: (id: string) => void;
  onReselect?: (id: string) => void;
  onSelect?: (id: string) => void;
  variant?: 'line' | 'default' | 'toggle' | 'project'; // default 'line'
  tabMenu?: (id: string) => ReactNode;
}): JSX.Element;
const compactTabClassName: string;
```

A horizontally scrolling row of shadcn tabs (`TabsList` with `activateOnFocus`) or, for `toggle`, a `role="group"` of toggles, labelled `label`. Tabs reorder by drag (after 6 px of pointer movement, along the horizontal axis, auto-scrolling the strip) or by keyboard (dnd-kit's Space sort, or Alt+Shift+ArrowLeft/ArrowRight to swap with a neighbour); each reorder calls `onMove(from, to)`. While sorting, tab widths are frozen. The selected tab scrolls into view when the selection, order or strip size changes; a wheel over an overflowing strip without Ctrl scrolls it sideways by the larger of `deltaX` and `deltaY`, times 1, 16 or the strip's `clientWidth` for `deltaMode` 0, 1, 2. Clicking or pressing Enter on the selected tab calls `onReselect`; clicking a toggle calls `onSelect`. With `onClose`, each tab has a close button labelled `Close <ariaLabel ?? label>`, focusable (`tabIndex` 0) only on the selected tab and disabled while sorting; in the `project` variant a middle click also closes. `tabMenu(id)` gives the content of a tab's context menu. `compactTabClassName` is the shared chrome of project and resource tabs, the string `'relative flex h-[28px] items-center gap-[6px] rounded-[6px] px-[8px] text-[12px] leading-[16px] font-[500] text-[var(--paper-gray-3)] hover:bg-[color-mix(in_srgb,currentColor_7.5%,transparent)] hover:text-[var(--paper-gray-2)] data-[active=true]:bg-[var(--paper-control)] data-[active=true]:text-[var(--paper-gray-1)] shadow-none data-[active=true]:hover:bg-[var(--paper-control)] [-webkit-app-region:no-drag] [&:has(:focus-visible)]:outline-2 [&:has(:focus-visible)]:-outline-offset-1 [&:has(:focus-visible)]:outline-[var(--paper-focus)]'`.

The `line`, `default` and `project` variants hold no selection of their own: the caller renders the strip inside a `Tabs` root from `desktop/ui/tabs` whose `value` equals `selected`, and the root's `onValueChange` receives the tab the reader selects (for example [`workspace-view.tsx`](../../bundles/desktop/layout/src/client/views/workspace-view.tsx)). Outside such a root, rendering throws `Base UI: TabsRootContext is missing. Tabs parts must be placed within <Tabs.Root>.` (a minified error code in production builds). Focusing a tab selects it (`activateOnFocus`), so arrow keys select as they move. Only `toggle` uses `onSelect`, and a toggle is `pressed` while its id is `selected`.

What each variant draws ([`tab-strip.tsx`](src/panels/tab-strip.tsx)):

- The strip is `[-webkit-app-region:drag]` and every tab `no-drag`, so empty strip space drags the window. Its scrollbar is hidden. Drag auto-scroll starts within 15 % of the strip's width from an edge, with acceleration 8.
- Every tab carries `data-tab-id`, `data-active="true"` when selected, `data-dragging`, `aria-label` (`ariaLabel ?? label`), `title` (`title ?? label`), `aria-roledescription="sortable tab"` and `aria-keyshortcuts="Space Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"`. It shows `icon`, then the label unless `iconOnly`, then `badge`.
- `line`: the list is `h-9` with a 4 px gap; a tab not selected shows its underline at 30 % on hover. `toggle`: `Toggle`s in `text-xs`, `font-normal`, with a 4 px gap. In these and `default`, the label truncates at `max-w-40`, and the close control is a ghost `icon-xs` button in a 24 px wide span, shown on the selected tab and on hover of the others.
- `project`: tabs styled by `compactTabClassName`, 28 px tall, 100–280 px wide, 4 px apart, with a 16 px icon slot and a label that fills the rest and truncates. The close control is a 28 px button with an 8 px × glyph, at 50 % opacity on the selected tab and 0 % on the others, 50 % while the pointer is over the tab, and 100 % on its own hover or keyboard focus.

The hooks behind it are exported for strips that compose their own tabs:

```ts
type FrozenTab = { readonly width: number; readonly close?: CSSProperties }; // not exported by name
function useTabStrip(
  ids: readonly string[],
  selected: string | undefined,
  onMove: (from: string, to: string) => void,
): {
  root: RefObject<HTMLDivElement | null>; // the scrolling strip
  frozen: ReadonlyMap<string, FrozenTab> | undefined; // set while sorting
  sorting: boolean; // frozen !== undefined
  sensors: SensorDescriptor[]; // pointer (6 px activation) and keyboard (sortable coordinates)
  start(): void;
  end(event: DragEndEvent): void;
  cancel(): void;
  canScroll(element: Element): boolean; // only the strip auto-scrolls
  keyDown(event: KeyboardEvent, id: string): void;
};
function useSortableTab(
  id: string,
  frozen?: FrozenTab,
): ReturnType<typeof useSortable> & {
  style: CSSProperties;
  closeStyle: CSSProperties | undefined; // frozen?.close
};
```

- `start` measures every `[data-tab-id]` element of the strip and freezes its width, and the width, `marginLeft` and `opacity` of its `[data-slot="tab-close"]` control (with `transition: 'none'`). `end` unfreezes and calls `onMove(active.id, over.id)` when the tab was dropped over another tab; `cancel` unfreezes.
- `keyDown`: while sorting, it prevents the default of the arrow keys, Space and Enter, so dnd-kit's listener handles them alone; otherwise Alt+Shift+ArrowLeft/ArrowRight prevents the default, stops propagation and calls `onMove(id, neighbour)` when there is a neighbour on that side.
- The selection reveal (`scrollIntoView` with `nearest`, on selection, order and strip resize, not while sorting) and the sideways wheel listener (non-passive) are effects of `useTabStrip`.
- `useSortableTab` returns dnd-kit's `useSortable(id)` result with a transition of 150 ms `ease-out`, plus `style`: `width` from `frozen`, the dnd-kit translate transform, `transition: 'none'` while dragging (else the sortable transition or `'none'`) and `zIndex: 1` while dragging.

**State and feedback** ([`panel-state.tsx`](src/panels/panel-state.tsx), [`read-feedback.tsx`](src/panels/read-feedback.tsx), [`use-read-error.ts`](src/panels/use-read-error.ts), [`move-item.ts`](src/panels/move-item.ts), [`toolbar-divider.tsx`](src/panels/toolbar-divider.tsx)):

- `PanelState({ title, description, icon? })`: an `Empty` state with a folder icon by default.
- `useReadError(error, refreshing, onRetry, toastId?)`: while `error` is a string and the surface is not refreshing, shows one `toast.error('Unable to update', { description: error, duration: 8000, action: 'Try again' })` each time the message differs from the last one shown, under `toastId` or an id of its own, so a new message replaces the toast in place and A, B, A shows A again; "Try again" calls `onRetry` and lets the same message show again; `error === undefined` or unmount dismisses it. `ReadFeedback({ error?, refreshing, onRetry, toastId? })` is the same as a component that renders nothing. Cached content stays on screen.
- `moveItem(items, from, to)`: a new array with the item at `from` placed at `to`; the same array when either index is out of range or they are equal.
- `ToolbarDivider()`: a vertical `Separator`, 16 px tall (`h-4`), centred in its row. No product surface draws it.

### Code view and diff editor (`desktop/ui/code`)

Monaco loads with a dynamic import the first time an editor mounts, once per window, so importing the subpath does not load it ([`monaco.ts`](src/code/monaco.ts)). The loaded module registers the codicon font and the CSS, HTML, JavaScript, Markdown, Python, Rust, shell, SQL, TypeScript, XML and YAML languages, and starts only Monaco's editor worker, from `workers/editor.worker.js` beside the loaded chunk ([`monaco-runtime.ts`](src/code/monaco-runtime.ts), [`editor.worker.ts`](src/code/editor.worker.ts)). Loading it sets `self.MonacoEnvironment` for the whole window, and Monaco's themes are window-wide too (see Theme below).

- **Build.** The platform build compiles `src/code/editor.worker.ts` on its own, with nothing external, to `workers/editor.worker.js` in the `desktop/ui` folder; the list of such workers is `desktopUi.workers` in [`packages.config.mjs`](../../app/desktop/doric-platform/packages.config.mjs). The CSS that `desktop/ui`'s JavaScript imports (Monaco's) is collected once, in import order, and appended to the window's `theme.css`, with the fonts it names written beside it ([`build.mjs`](../../app/desktop/doric-platform/build.mjs)).
- **Load failure.** When the dynamic import rejects, the editor's container stays empty, nothing is shown, and the rejection is not handled. The rejected promise is kept, so every later editor in that window fails the same way ([`monaco.ts`](src/code/monaco.ts), [`code-view.tsx`](src/code/code-view.tsx), [`diff-editor.tsx`](src/code/diff-editor.tsx)).

- `fileLanguage(path)`: the Monaco language id by extension, case-insensitive (`ts`, `tsx`, `cts`, `mts` → `typescript`; `js`, `jsx`, `cjs`, `mjs` → `javascript`; `md`, `markdown`; `py`; `rs`; `sh`, `bash`, `zsh` → `shell`; `sql`; `css`; `html`, `htm`; `xml`, `svg` → `xml`; `yaml`, `yml`); anything else, a name without an extension or a dotfile is `plaintext`. JSON is `plaintext`, because its language service needs a worker of its own ([`language.ts`](src/code/language.ts)).
- `CodeView({ language, value })`: one read-only editor per mounted view, created with the first text and disposed on unmount; later text and language are applied to the same model, keeping the view state. It uses the container's `font-mono` family at 12 px, 12 px of padding above and below, `scrollBeyondLastLine: false`, no minimap, no overview ruler, no sticky scroll, no line highlight, 10 px scrollbars without shadows that pass the wheel on at an edge, and no word wrap. The container is a `div` with `data-slot="code-view"` and `min-h-0 flex-1 font-mono` ([`code-view.tsx`](src/code/code-view.tsx)).
- `DiffEditor(props)`: a read-only inline diff that keeps its editor and models across refreshes. `toolbar` and `footer` are required, and render before and after a `<section aria-label="File comparison">` with `DiffControls`:

  ```ts
  function DiffEditor(props: {
    readonly original: string;
    readonly modified: string;
    readonly language: string;
    readonly diffTokens: { readonly added: string; readonly removed: string }; // DiffTokens, not exported
    readonly toolbar: (controls: DiffControls) => ReactNode;
    readonly footer: (controls: DiffControls) => ReactNode;
  }): JSX.Element;
  type DiffControls = {
    readonly counts:
      | { readonly added: number; readonly removed: number }
      | undefined;
    readonly layout: string; // 'unified' at first
    readonly onLayout: (value: string) => void;
    readonly onNavigate: (direction: 'previous' | 'next') => void; // goToDiff
  };
  ```

  `counts` are `{ added: 0, removed: 0 }` when the texts are equal, `undefined` until Monaco computes the diff, and otherwise the lines inside Monaco's changed ranges, clamped to each text's line count, where a text's final newline does not count as a line. The diff is compact (inline) when `layout` is `'unified'` or the editor is 700 px wide or less; `'split'` wider than that shows the sides side by side. Whitespace changes count (`ignoreTrimWhitespace: false`), and there is no revert icon and no overview ruler. `diffTokens` gives the colours of the added and removed lines: each value is a CSS custom property name (`--x`, read from the root element) or a literal `#rrggbb` or `oklch(…)` value. `desktop/ui/code` does not export its type `DiffTokens`, so a caller writes the object shape. The editor is themed with the `diffTokens` of the render on which Monaco arrived; a later `diffTokens` value takes effect only at the next colour-scheme change ([`diff-editor.tsx`](src/code/diff-editor.tsx), [`diff-counts.ts`](src/code/diff-counts.ts), [`code-view-theme.ts`](src/code/code-view-theme.ts)).

- Theme: both editors define a Monaco theme at creation and again when the system colour scheme changes, reading the palette from `getComputedStyle(document.documentElement)`. The mode is `dark` when the root element has the class `dark`, else `light`. The theme is named `doric-light` or `doric-dark`, or `<that name>-diff-<added>-<removed>` for a diff (one theme per pair of tokens); its base is `vs` or `vs-dark` with `inherit: false`. A value is used as is when it is `#rrggbb`, and otherwise converted from `oklch(…)` to hex, each channel clamped to 0–255, as `#rrggbbaa` when its alpha is not 1; a colour that does not resolve is left out, so Monaco's default answers for it ([`code-view-theme.ts`](src/code/code-view-theme.ts), [`oklch.ts`](src/code/oklch.ts)). The alpha suffixes of the diff colours below are appended to that hex, so a diff token with alpha gives a ten-digit hex value Monaco cannot read.

  Monaco has one active theme per window: the `theme` an editor is created with, and each `setTheme` on a colour-scheme change, apply to every editor in the window. A `CodeView` created after a `DiffEditor` switches the window to `doric-<mode>`, and the diff's added and removed lines fall back to Monaco's default diff colours, since that theme states none (`inherit: false`); a `DiffEditor` created later switches it back ([`code-view.tsx`](src/code/code-view.tsx), [`diff-editor.tsx`](src/code/diff-editor.tsx)).

  | Monaco colour                                                                                                                                                                                      | Source                                                    |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
  | `editor.background`                                                                                                                                                                                | `--background`                                            |
  | `editor.foreground`, `editorWidget.foreground`                                                                                                                                                     | `--foreground`                                            |
  | `editorLineNumber.foreground`, `editorLineNumber.activeForeground`                                                                                                                                 | `--muted-foreground`                                      |
  | `editorIndentGuide.background1`, `editorIndentGuide.activeBackground1`, `editorWidget.border`, `scrollbarSlider.background`, `scrollbarSlider.hoverBackground`, `scrollbarSlider.activeBackground` | `--border`                                                |
  | `editorCursor.foreground`                                                                                                                                                                          | `--primary`                                               |
  | `editor.selectionBackground`                                                                                                                                                                       | `--accent`                                                |
  | `editorError.foreground`                                                                                                                                                                           | `--destructive`                                           |
  | `editorWidget.background`                                                                                                                                                                          | `--card`                                                  |
  | `diffEditor.insertedTextBackground`, `diffEditor.removedTextBackground`                                                                                                                            | the `added` / `removed` token with alpha `33` (diff only) |
  | `diffEditor.insertedLineBackground`, `diffEditor.removedLineBackground`                                                                                                                            | the `added` / `removed` token with alpha `18` (diff only) |
  | `editorBracketHighlight.foreground1`, `2`, `3`                                                                                                                                                     | the `keyword`, `type` and `number` hues                   |

  | Hue       | Light                  | Dark                   | Token rules                              |
  | --------- | ---------------------- | ---------------------- | ---------------------------------------- |
  | `comment` | `--muted-foreground`   | `--muted-foreground`   | `comment`                                |
  | `keyword` | `oklch(0.5 0.13 152)`  | `oklch(0.78 0.13 152)` | `keyword`, `tag`                         |
  | `string`  | `oklch(0.51 0.11 62)`  | `oklch(0.81 0.09 70)`  | `string`, `regexp`, `attribute.value`    |
  | `number`  | `oklch(0.5 0.1 200)`   | `oklch(0.8 0.09 205)`  | `number`                                 |
  | `type`    | `oklch(0.48 0.13 285)` | `oklch(0.79 0.09 288)` | `type`, `keyword.type`, `attribute.name` |
  | `name`    | `oklch(0.46 0.1 250)`  | `oklch(0.82 0.06 245)` | `identifier`, `variable`, `predefined`   |

  Each rule sets the token's `foreground`; a rule matches its own token name and every dotted name below it, and a name no rule states keeps the default foreground. Two more rules set `emphasis` to italic and `strong` to bold.

### Viewport (`desktop/ui/viewport`)

Pure pan-and-zoom math for surfaces that draw content under one CSS transform (Papercraft's canvas, OpenUI diagrams); nothing here is stored ([`viewport.ts`](src/viewport.ts)):

```ts
interface Viewport {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}
const IDENTITY: Viewport; // { scale: 1, tx: 0, ty: 0 }
const ZOOM_STEP = 1.2;
function clampScale(scale: number): number; // clamped to 0.25–4
function zoomAt(
  viewport: Viewport,
  factor: number,
  origin?: { x: number; y: number },
): Viewport;
function fitViewport(
  content: ContentBounds,
  area: { width: number; height: number },
  margin?: number,
): Viewport | undefined;
function zoomPercent(viewport: Viewport): string; // '100%' at identity
function toContent(
  viewport: Viewport,
  point: { x: number; y: number },
): { x: number; y: number };
function viewportTransform(viewport: Viewport): string; // 'translate(<tx>px, <ty>px) scale(<scale>)'
function wheelGesture(input: WheelGestureInput): WheelGesture | undefined;
```

- `zoomAt` multiplies the scale by `factor` (clamped) and keeps `origin` (default `0, 0`) under the pointer. `ZOOM_STEP` is a factor for callers' zoom buttons; nothing in this file uses it.
- `zoomPercent` rounds `scale × 100` to a whole percent.
- `ContentBounds` is `{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }`, a box in content coordinates. `fitViewport` scales by `clampScale(min(1, (area.width − 2 × margin) / content.width, (area.height − 2 × margin) / content.height))` with `margin` default 24, and centres the box: `tx = (area.width − content.width × scale) / 2 − content.x × scale`, and `ty` alike. It returns `undefined` when the content's width or height is 0 or less, and `IDENTITY` when the area minus margins has none.
- `toContent` maps a surface point to content coordinates: `((x − tx) / scale, (y − ty) / scale)`.
- `WheelGestureInput` is `{ deltaX; deltaY; deltaMode; zoom: boolean; captured: boolean; pageHeight: number }`, and `WheelGesture` is `{ kind: 'zoom'; factor } | { kind: 'pan'; dx; dy }`.
- `wheelGesture({ deltaX, deltaY, deltaMode, zoom, captured, pageHeight })`: with `zoom` (Ctrl/⌘ or a pinch), `{ kind: 'zoom', factor: 1.1 }` when `deltaY < 0`, else `1 / 1.1`, so a `deltaY` of 0 zooms out; otherwise, when `captured`, `{ kind: 'pan', dx: −deltaX × s, dy: −deltaY × s }` with `s` = 1, 16 or `pageHeight || 800` for `deltaMode` 0, 1, 2; otherwise `undefined`, and the caller leaves the wheel to the page.

### `CommandPrimitive`

`desktop/ui/cmdk` exports `cmdk`'s `Command` as `CommandPrimitive`, the window's one `cmdk` instance, for a bundle that composes part of `desktop/ui/command` itself; a copy bundled into the caller would not see the store `Command` provides ([`cmdk.ts`](src/cmdk.ts)).

## Theme, tokens and fonts

### Tokens

The design tokens are stated once, in [`tokens.ts`](src/tokens/tokens.ts):

```ts
interface TokenSet {
  readonly [cssVar: `--${string}`]: string;
}
interface Tokens {
  readonly version: string; // '1.0.0', the platform assets version
  readonly defaultVariant: 'light';
  readonly variants: { readonly light: TokenSet; readonly dark: TokenSet };
  readonly shared: TokenSet;
  readonly window: {
    readonly titlebarHeight: number; // 40
    readonly trafficLight: {
      readonly size: number;
      readonly insetX: number;
      readonly reservedWidth: number;
    }; // 12, 14, 80
    readonly backgrounds: {
      readonly window: { readonly light: string; readonly dark: string };
    }; // '#fbf8f2', '#1c1a17'
  };
}
```

- Each variant sets the shadcn colours, the `--paper-*` palette and the shadows; the values are the tables below.
- `shared` sets `--font-sans` and `--font-serif` (`'Noto Sans', -apple-system, BlinkMacSystemFont, sans-serif`), `--font-mono` and `--font-conversation` (`'IBM Plex Mono', monospace`), `--font-weight-normal` (400), `--font-weight-medium` (500), `--radius` (6px), `--paper-radius-control` (6px), `--paper-radius-panel` (8px), `--paper-text-sm|base|lg` (10, 12, 13 px), the shadow parameters, `--tracking-normal` and `--spacing` (0.25rem).
- `trafficLight.reservedWidth` is `insetX + 3 × size + 2 × 8 + insetX`, the room a chrome bar keeps for the macOS window buttons.
- The shared shadow parameters are `--shadow-x` `0px`, `--shadow-y` `4px`, `--shadow-blur` `12px`, `--shadow-spread` `-2px`, `--shadow-opacity` `0.1`; `--tracking-normal` is `0em`.

The colours of each variant:

| Variable                       | Light                                                                                                  | Dark                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `--background`                 | `#fbf8f2`                                                                                              | `#1c1a17`                                                                                     |
| `--foreground`                 | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--card`                       | `#f3eee5`                                                                                              | `#24211d`                                                                                     |
| `--card-foreground`            | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--popover`                    | `#f3eee5`                                                                                              | `#24211d`                                                                                     |
| `--popover-foreground`         | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--primary`                    | `#3b352e`                                                                                              | `#ede4d3`                                                                                     |
| `--primary-foreground`         | `#f3ecdf`                                                                                              | `#1c1a17`                                                                                     |
| `--secondary`                  | `#f7f3ec`                                                                                              | `#332f29`                                                                                     |
| `--secondary-foreground`       | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--muted`                      | `#ece6db`                                                                                              | `#2d2924`                                                                                     |
| `--muted-foreground`           | `#6e665c`                                                                                              | `#a39a8e`                                                                                     |
| `--accent`                     | `#e3dccf`                                                                                              | `#36312b`                                                                                     |
| `--accent-foreground`          | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--destructive`                | `#b3361f`                                                                                              | `#f0a08f`                                                                                     |
| `--destructive-foreground`     | `#fbf8f2`                                                                                              | `#1c1a17`                                                                                     |
| `--warning`                    | `#8f5a12`                                                                                              | `#e9b75a`                                                                                     |
| `--warning-foreground`         | `#fbf8f2`                                                                                              | `#1c1a17`                                                                                     |
| `--border`                     | `#e2dbce`                                                                                              | `#3a3530`                                                                                     |
| `--input`                      | `#d8d0c2`                                                                                              | `#423c36`                                                                                     |
| `--ring`                       | `#8a7f70`                                                                                              | `#d9cdb6`                                                                                     |
| `--chart-1`                    | `#3b352e`                                                                                              | `#ede4d3`                                                                                     |
| `--chart-2`                    | `#5a5248`                                                                                              | `#d2c3a6`                                                                                     |
| `--chart-3`                    | `#7a7064`                                                                                              | `#a39a8e`                                                                                     |
| `--chart-4`                    | `#a39a8e`                                                                                              | `#7a7064`                                                                                     |
| `--chart-5`                    | `#c9bda8`                                                                                              | `#5a5248`                                                                                     |
| `--sidebar`                    | `#f3eee5`                                                                                              | `#24211d`                                                                                     |
| `--sidebar-foreground`         | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--sidebar-primary`            | `#3b352e`                                                                                              | `#ede4d3`                                                                                     |
| `--sidebar-primary-foreground` | `#f3ecdf`                                                                                              | `#1c1a17`                                                                                     |
| `--sidebar-accent`             | `#ece6db`                                                                                              | `#2d2924`                                                                                     |
| `--sidebar-accent-foreground`  | `#2e2a25`                                                                                              | `#e8e2d6`                                                                                     |
| `--sidebar-border`             | `#e2dbce`                                                                                              | `#3a3530`                                                                                     |
| `--sidebar-ring`               | `#8a7f70`                                                                                              | `#d9cdb6`                                                                                     |
| `--paper-root`                 | `#fbf8f2`                                                                                              | `#1c1a17`                                                                                     |
| `--paper-panel`                | `#f3eee5`                                                                                              | `#24211d`                                                                                     |
| `--paper-panel-highlight-1`    | `#ece6db`                                                                                              | `#2d2924`                                                                                     |
| `--paper-panel-highlight-2`    | `#e3dccf`                                                                                              | `#36312b`                                                                                     |
| `--paper-separator`            | `#e2dbce`                                                                                              | `#3a3530`                                                                                     |
| `--paper-separator-highlight`  | `#d8d0c2`                                                                                              | `#423c36`                                                                                     |
| `--paper-control`              | `#f7f3ec`                                                                                              | `#332f29`                                                                                     |
| `--paper-control-border`       | `#e2dbce`                                                                                              | `transparent`                                                                                 |
| `--paper-control-pressed`      | `#faf7f1`                                                                                              | `#36312b`                                                                                     |
| `--paper-control-icon`         | `#2e2a2559`                                                                                            | `#e8e2d666`                                                                                   |
| `--paper-ghost-hover`          | `#2e2a250f`                                                                                            | `#e8e2d60f`                                                                                   |
| `--paper-ghost-pressed`        | `#2e2a2516`                                                                                            | `#e8e2d616`                                                                                   |
| `--paper-thumbnail`            | `#2e2a2513`                                                                                            | `#e8e2d61a`                                                                                   |
| `--paper-thumbnail-selected`   | `#f1eadc`                                                                                              | `#3a342c`                                                                                     |
| `--paper-gray-1`               | `#2e2a25cc`                                                                                            | `#e8e2d6e6`                                                                                   |
| `--paper-gray-2`               | `#2e2a2599`                                                                                            | `#e8e2d6a6`                                                                                   |
| `--paper-gray-3`               | `#2e2a2580`                                                                                            | `#e8e2d693`                                                                                   |
| `--paper-gray-4`               | `#2e2a256c`                                                                                            | `#e8e2d680`                                                                                   |
| `--paper-gray-5`               | `#2e2a251a`                                                                                            | `#e8e2d61a`                                                                                   |
| `--paper-blue-2`               | `#8a7f70`                                                                                              | `#ede4d3`                                                                                     |
| `--paper-blue-3`               | `#776c5e`                                                                                              | `#e2d6bf`                                                                                     |
| `--paper-blue-4`               | `#64594c`                                                                                              | `#d2c3a6`                                                                                     |
| `--paper-blue-5`               | `#4a433b`                                                                                              | `#bba986`                                                                                     |
| `--paper-orange`               | `#c98a2b`                                                                                              | `#e9a94a`                                                                                     |
| `--paper-red`                  | `#c0442f`                                                                                              | `#f08a7a`                                                                                     |
| `--paper-green`                | `#5e8a4c`                                                                                              | `#9cc48a`                                                                                     |
| `--paper-focus`                | `#a89b86`                                                                                              | `#d9cdb6`                                                                                     |
| `--paper-selection`            | `#d9cdb680`                                                                                            | `#d9cdb640`                                                                                   |
| `--paper-shadow-control`       | `inset 0 1px #fff8, inset 0 0 1px 1px #fff8, 0 0.5px 1px #00000018, 0 0 1px #0001, 0 0 4px -1px #0001` | `inset 0 1px #ffffff08, inset 0 0 1px 0.5px #fff1, 0 1px 0.5px #00000018, 0 0 3px -1px #000a` |

| Variable         | Both variants                                                              |
| ---------------- | -------------------------------------------------------------------------- |
| `--shadow-color` | `hsl(0 0% 0%)`                                                             |
| `--shadow-2xs`   | `0 1px 2px 0 hsl(0 0% 0% / 0.05)`                                          |
| `--shadow-xs`    | `0 1px 3px 0 hsl(0 0% 0% / 0.07)`                                          |
| `--shadow-sm`    | `0 2px 6px -1px hsl(0 0% 0% / 0.08), 0 1px 2px 0 hsl(0 0% 0% / 0.05)`      |
| `--shadow`       | `0 2px 6px -1px hsl(0 0% 0% / 0.08), 0 1px 2px 0 hsl(0 0% 0% / 0.05)`      |
| `--shadow-md`    | `0 4px 12px -2px hsl(0 0% 0% / 0.1), 0 2px 4px -1px hsl(0 0% 0% / 0.06)`   |
| `--shadow-lg`    | `0 8px 20px -4px hsl(0 0% 0% / 0.1), 0 2px 6px -2px hsl(0 0% 0% / 0.06)`   |
| `--shadow-xl`    | `0 12px 28px -6px hsl(0 0% 0% / 0.12), 0 4px 8px -2px hsl(0 0% 0% / 0.06)` |
| `--shadow-2xl`   | `0 16px 40px -8px hsl(0 0% 0% / 0.16)`                                     |

[`css.ts`](src/tokens/css.ts) turns them into CSS:

- `windowVariables(tokens)`: `--doric-titlebar-height` (`<titlebarHeight>px`), `--doric-window-background` (`var(--background)`), and `--doric-safe-top`, `--doric-safe-left`, `--doric-safe-right` (`0px`).
- `tokensCss(tokens)`: the text of `tokens.css` — a generated-file comment, `:root` with the light variant and the shared tokens, the dark variant under `@media (prefers-color-scheme: dark)` and under `.dark`, then `:root` with the window variables.
- `resolvedVariables(tokens, variant = tokens.defaultVariant)`: the shared tokens, that variant and the window variables in one record. The platform contract `doric.tokens/v1` answers this record ([`doric.tokens/v1`](../../docs/architecture/bundles/platform-packages.md#dorictokensv1)).

`desktop:build` runs [`build-tokens.mjs`](scripts/build-tokens.mjs) after compiling, which writes `src/styles/tokens.css` and `dist/tokens.json` from the compiled module. Both are generated: edit `tokens.ts` and rebuild. The main process reads `tokens.json` for the chrome bar's measures and the native window background.

### Stylesheets

- [`theme.css`](src/styles/theme.css) (`desktop/ui/theme.css`) is loaded once per window. It declares the layers `theme, base, components, utilities` and imports `tailwind.css`, Tailwind's preflight (layer `base`), [`fonts.css`](src/styles/fonts.css), `tokens.css` and Tailwind's utilities, generated from `src/components/`, `chrome-bar.tsx`, `element-host.tsx`, `error-notice.tsx`, `model-icon.tsx`, `choice-list.tsx` and `collapsible-block.tsx`. Its base layer gives every element `border-border` and `outline-ring/50`, sets `:root` to weight 300 and headings to `--font-weight-normal`; `.chrome-bar` takes `height: var(--doric-titlebar-height)`. The classes of `panels`, `code`, `comment-pin` and `reader-avatar` come from the bundle stylesheets that scan `packages/desktop/src`.
- [`tailwind.css`](src/styles/tailwind.css) (`desktop/ui/tailwind.css`) is the reference entry: Tailwind's theme, `tw-animate-css`, shadcn's Tailwind CSS, the `dark` variant (`&:is(.dark *)`), the colour, font and shadow tokens as Tailwind theme variables, and the radius scale (`--radius-sm` … `--radius-xl`, from `--radius`) in `@theme static`. A stylesheet that `@reference`s it gets those names and emits none of them.

The rules a bundle stylesheet follows (no `@theme`, `@source` of `packages/desktop/src`, link order) are in [Styles and the Tailwind rule](../../docs/architecture/bundles/platform-packages.md#styles-and-the-tailwind-rule).

### Fonts

The faces are vendored under [`assets/fonts`](assets/fonts) as variable `woff2` files, one per subset, and declared in [`fonts.css`](src/styles/fonts.css): **Noto Sans** (weights 100–900, normal and italic; Latin and Latin Extended; license `NotoSans-OFL.txt`) and **IBM Plex Mono** (weights 100–700, normal and italic; Latin1, Latin2, Latin3 and Pi; license `IBMPlexMono-OFL.txt`). Each of the 12 `@font-face` rules covers one face, style and subset, with `font-display: swap` and the subset's `unicode-range`, so a window downloads only the subsets its text uses. The URLs are relative to `src/styles/`; the platform build copies the files and rewrites the URLs ([Fonts](../../docs/architecture/bundles/platform-packages.md#fonts)).

## Reads (`desktop/reads`)

Browser-safe helpers every read surface shares; nothing here names a bundle's concept ([`reads/index.ts`](src/reads/index.ts)).

### Paths

Workspace-relative path strings ([`paths.ts`](src/reads/paths.ts)):

- `ROOT_PATH = ''`, the workspace root.
- `joinPath(dir, name)`: `name` at the root, else `` `${dir}/${name}` ``.
- `parentPath(path)`: everything before the last `/`, or `ROOT_PATH` when there is none.
- `baseName(path)`: everything after the last `/`, or the whole path.
- `compactPath(path, keep = 2)`: the last `keep` non-empty components prefixed with `…/` when more were dropped (`/home/me/projetos/doric` → `…/projetos/doric`); a path with `keep` components or fewer is returned whole.

### Refresh

```ts
function createRefreshQueue(
  read: () => Promise<void>,
  delayMs = 250,
): {
  request(): Promise<void>;
  dispose(): void;
};
function refreshQueries(
  client: QueryClient,
  scope: string,
  matches: (query: Query) => boolean,
  periodic = false,
): Promise<void>;
```

- `createRefreshQueue` coalesces bursts: the first `request()` schedules `read` after `delayMs`; requests while a run is scheduled join it, and requests during a run cause exactly one more run after it. Every waiting `request()` resolves when a run finishes with no request left pending. `dispose()` cancels the timer and resolves every waiter; later requests resolve at once. When `read` rejects, the waiters resolve all the same (no `request()` ever rejects) and the rejection is left unhandled ([`refresh.ts`](src/reads/refresh.ts)).
- `refreshQueries` keeps one such queue per `QueryClient` and `scope`. A run invalidates (without refetching) and then refetches the active queries `matches` selects, never cancelling a fetch in flight; queries that were fetching when it started are refetched once more after they settle, when they succeeded with ready data. A periodic call (`periodic = true`) skips queries in error and queries whose data is an object with a `status` other than `'ready'`, because those own their retry schedule; any non-periodic call in the same burst includes them.

### Read policy and messages

- `readRetry = { retry: 3, retryDelay: (attempt) => min(1000 × 2^attempt, 8000) }`, the bounded retry of a failed read ([`read-policy.ts`](src/reads/read-policy.ts)).
- `pendingReadInterval(result)`: for `{ status: 'pending', retryAfterSeconds? }`, `max(1000, retryAfterSeconds × 1000)` ms when the hint is a finite positive number, else 3,000 ms; for anything else `false` (no polling).
- `messageFrom(error)`: `error.message` for an `Error`, else `'The operation could not be completed.'` ([`messages.ts`](src/reads/messages.ts)).

### The error value

Plain data, so the copies of this module each client part bundles exchange values freely; nothing reads `instanceof` ([`errors.ts`](src/reads/errors.ts)).

```ts
interface ErrorCause {
  readonly code?: string;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly message: string;
}
interface ErrorInfo {
  readonly code: string; // '' when the error names none
  readonly provider?: string;
  readonly status?: number;
  readonly message: string; // trimmed; '' when none
  readonly retryable?: boolean;
  readonly causes: readonly ErrorCause[]; // outermost first, at most 7
  readonly at?: string; // ISO 8601
}
class ClientError extends Error {
  readonly name: string; // 'ClientError'
  readonly code: string;
  readonly retryable?: boolean; // only when options.retryable is given
  constructor(
    code: string,
    message: string,
    options?: { readonly cause?: unknown; readonly retryable?: boolean },
  );
}
interface ErrorCatalogEntry {
  readonly title: string;
  readonly explanation?: string; // may contain {provider}
  readonly retryable: boolean;
  readonly tone?: 'error' | 'warning'; // default 'error'
}
type ErrorCatalog = Readonly<Record<string, ErrorCatalogEntry>>;
```

- `errorInfo(value, { at? })` reads any value — an `Error`, a `ClientError`, a `ContractError`, the JSON of a stored event, a string, `undefined` — into an `ErrorInfo`. Each level reads only `code` and `provider` (strings), `status` (number), `retryable` (boolean) and `message` (string, trimmed), at the top of the object or else under its `data`, and the next level is its `cause`; a string is a level with that message, and any other non-object a level with message `''`. An outermost `handler_failed` level with a cause is skipped. At most 8 levels are read, which also ends a cyclic chain. A cause is left out when its message is empty or contained in a message above it and its code is absent or equal to a code above it; at most 7 causes are kept. `at`: a string is kept, `null` leaves it absent, and omitted it is the current time. A getter that throws reads as absent; the function never throws.
- `errorFrom(code, message, cause?, { at? })`: an `ErrorInfo` with the given outer code and message whose causes are `cause`'s chain as `errorInfo` reads it, its outermost level included, with the same omission rule; no `provider`, `status` or `retryable` of its own.
- `sameErrorInfo(left, right)`: whether both carry the same `code`, `provider`, `status`, `message`, `retryable` and causes; `at` is ignored, and two `undefined` values are the same.

`ErrorNotice` and `toastError` ([above](#the-error-notice-desktopuierror-notice)) render these values with an `ErrorCatalog`.

## The window–main protocol (`desktop/protocol`)

Browser-safe types, zod schemas and constants, plus the function `remoteMethodSpecFromSchema`; every object schema is `.strict()` ([`protocol.ts`](src/client/protocol.ts)). How main and the window use them — the bridge, scopes, exposure and the host — is in [Services and channels](../../docs/architecture/bundles/services-and-channels.md#calls-from-a-desktop-window).

| Export                                               | Value or shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESKTOP_CHANNEL`                                    | `'doric:desktop'`, the one `ipcMain.handle` channel of every window and the splash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CONNECT_CHANNEL`                                    | `'doric:connect'`, the channel of a window's Connect requests to the host (slice S64); `DoricConnectApi` (`window.doric.connect`, `request(request: ConnectRequest): Promise<ConnectReply>`), `connectRequestSchema` (`{ path, headers, body }`, headers as pairs, body as bytes), `ConnectReply` and `ConnectPort` (a stream's port, handed over by the preload since `contextBridge` cannot pass ports)                                                                                                                                                                                                                                                                                                                                                  |
| `DESKTOP_PUSH_CHANNEL`                               | `'doric:desktop:push'`, main's pushes to a window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SHELL_CONTRACT`                                     | `'doric.shell/v1'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `WindowChrome`, `windowChromeSchema`                 | `{ titleBar: 'native' \| 'integrated' \| 'none'; height: number; safeArea: { top, left, right: number } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WindowMode`                                         | `'connected' \| 'disconnected-copy' \| 'last-good-core'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WindowDescription`, `windowDescriptionSchema`       | `{ key: string \| null; kind: 'window' \| 'technical'; primary: boolean; path: string; generation: number \| null; chrome: WindowChrome; mode: WindowMode; tokens: Record<string, string>; app: { version: string } }`; `key` and `generation` are `null` for the splash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `WindowFailure`, `windowFailureSchema`               | `{ kind: 'core' \| 'bootstrap'; bundleId?: string; message: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CloseRequest`, `closeRequestSchema`                 | `{ phase: 'close' \| 'flush'; forced: boolean; deadline: number }` (epoch ms, `0` = none)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CloseAnswer`, `closeAnswerSchema`                   | `{ allow: true } \| { allow: false; reason: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RemoteMethodSpec`, `remoteMethodSpecSchema`         | `{ tuple: number \| null; local: boolean; stream: boolean; expose?: MethodExposure }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `remoteMethodSpecFromSchema(input, output, expose?)` | The spec of a method from its JSON Schemas: `tuple` is the `prefixItems` length of an array input; `stream` when the input has a stream item; `local` when any process-local value (a `LOCAL_KEY` marker) appears in the input other than the stream listener, or in the output of a non-stream method                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RemoteContract`, `remoteContractSchema`             | `{ id; environment: 'desktopMain' \| 'host'; bundleId; version; contractVersion; cardinality: 'one' \| 'many'; methods: Record<string, RemoteMethodSpec> }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WindowPart`                                         | `{ entry: string; styles?: string }`, the `doric://app/bundles/<id>@<version>/client/` URLs of a client part                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `WindowCatalog`                                      | `{ generation; resolved: ResolvedEnvironment; parts: Record<string, WindowPart>; remote: readonly RemoteContract[]; hostId: string; storageGeneration: number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BridgeScope`                                        | A call scope (`callScopeSchema`) without the key `windowKey` in any letter case; the schema refuses it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BridgeCallEnvelope`, `bridgeCallEnvelopeSchema`     | `{ id (non-empty); contract; method; input; bundleId: string \| null; scope?; deadline; traceparent }`; `bundleId: null` is the window platform                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BridgeError`, `bridgeErrorSchema`                   | `{ code; message; details? }`, a `ContractError` as it crosses the IPC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `BridgeResultPayload`, `bridgeResultPayloadSchema`   | `{ ok: true; output } \| { ok: false; error: BridgeError }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `BridgeStreamEvent`                                  | `{ type: 'event'; event } \| { type: 'end'; error? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DoricDesktopApi`                                    | What the preload exposes as `window.doric.desktop` ([below](#doricdesktopapi))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `desktopRequestSchema`, `DesktopRequest`             | What the preload sends on `doric:desktop`, discriminated by `op`: `describeWindow`, `ready`, `reportFailure` (`info: WindowFailure`), `catalog`, `call` (`envelope: BridgeCallEnvelope`), `cancel` (`id: string`, the `envelope.id` of the call), `subscribe` (`envelope: BridgeCallEnvelope`), `unsubscribe` (`id: string`, the `envelope.id` of the `subscribe`), `closeAnswer` (`id: string`, the `id` of the `close-requested` push; `answer: CloseAnswer`); each also takes an optional integer `generation`, the generation the window's page was rendered with, which main uses on `describeWindow` and `catalog` to pin a window not yet pinned ([`dispatcher.ts`](../../app/desktop/doric/src/platform/bridge/dispatcher.ts)), and no other field |
| `desktopPushSchema`, `DesktopPush`                   | What main pushes on `doric:desktop:push`, discriminated by `type`: `close-requested` (`id: string`, `request: CloseRequest`), `chrome` (`chrome: WindowChrome`), `event` (`id: string`, the `envelope.id` of the `subscribe`; `event: unknown`, the stream item), `end` (`id: string`, likewise; `error?: BridgeError`); each takes no other field                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ShellKeybinding`, `shellKeybindingSchema`           | `{ key: string; command: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ShellCommandRequest`, `shellCommandRequestSchema`   | `{ id; command; input }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ShellCommandResult`, `shellCommandResultSchema`     | `{ id; ok: true } \| { id; ok: false; error: BridgeError }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ShellDiagnostic`, `shellDiagnosticSchema`           | `{ kind: 'quarantine'; bundleId; reason: { code; message } } \| { kind: 'report'; entry: { bundleId; kind; message; details? } } \| { kind: 'recovery'; reason }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `shellMethods`, `ShellMethod`                        | The methods of `doric.shell/v1` and whether each is a stream: `keybindings`, `commands`, `connection` (streams); `keybinding`, `commandResult`, `log`, `diagnostic`, `openExternal`, `appearanceGet`, `appearanceSet` (calls)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### The window's Connect path

`windowFetch(api)` ([`connect.ts`](src/client/connect.ts)) is a `fetch` that carries a Connect request over `window.doric.connect`: a unary call in one request, a stream's response body fed through a port of its own; a dead channel is a `TypeError`, which Connect reads as `UNAVAILABLE`. `windowHostClients(api, catalog)` gives the runtime its `hostClients`: one `createClientPart` of `bundle/client` per bundle id over `windowFetch`, and each host contract's provider from `WindowCatalog.hostProviders`, which main fills. `bootstrap.ts` and `activate.ts` pass it to the runtime, so a client part's `services.use` of a generated service descriptor answers a Connect client.

### `DoricDesktopApi`

```ts
interface DoricDesktopApi {
  describeWindow(): Promise<WindowDescription>;
  ready(): Promise<void>;
  reportFailure(info: WindowFailure): Promise<void>;
  onCloseRequested(
    handler: (request: CloseRequest) => Promise<CloseAnswer | undefined>,
  ): () => void;
  onChromeChanged(listener: (chrome: WindowChrome) => void): () => void;
  catalog(): Promise<WindowCatalog>;
  call(envelope: BridgeCallEnvelope): Promise<BridgeResultPayload>;
  cancel(id: string): void;
  subscribe(
    envelope: BridgeCallEnvelope,
    listener: (event: BridgeStreamEvent) => void,
  ): () => void;
}
```

The `on*` methods and `subscribe` return the function that unsubscribes. `call` is a plain IPC invoke, so it can reject. Main rejects it with a plain `Error`, not a `ContractError`, before handling it: `The request source is not allowed.` when the sender is refused (a frame URL outside the shell, a sub-frame, or a sender that is neither a known window nor the splash), and `Invalid desktop request: …` when the request fails `desktopRequestSchema` (for example a scope carrying `windowKey`). Every failure past those checks is an answer, `{ ok: false, error }` ([`dispatcher.ts`](../../app/desktop/doric/src/platform/bridge/dispatcher.ts)). Through `remoteContractRecord`, such a rejection reaches the caller as that plain `Error`.

### `doric.shell/v1`

`doric.shell/v1` is platform-internal: a window calls it only with `bundleId: null`. A stream takes no input (`[]`) and delivers its items through `subscribe`. What each method carries, as the window runtime sends and reads it ([`bridge.ts`](src/client/bridge.ts) and the callers below):

| Method          | Input                                                                          | Output or stream item                         | Window caller             |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------- |
| `keybindings`   | none (stream)                                                                  | the whole `ShellKeybinding[]` table, per item | `installKeybindings`      |
| `keybinding`    | `{ key }`, the accelerator string of the matched binding (not the key pressed) | none                                          | `installKeybindings`      |
| `commands`      | none (stream)                                                                  | one `ShellCommandRequest` per item            | `serveShellCommands`      |
| `commandResult` | a `ShellCommandResult`                                                         | none                                          | `serveShellCommands`      |
| `log`           | a `LogRecord` (`bundle/contracts`)                                             | none                                          | `doric.log/v1` sink       |
| `diagnostic`    | a `ShellDiagnostic`                                                            | none                                          | `WindowDiagnostics`       |
| `connection`    | none (stream)                                                                  | one `ConnectionStatus` per item               | `provideConnection`       |
| `openExternal`  | `{ url }`                                                                      | none                                          | `doric.browser/v1.open`   |
| `appearanceGet` | `{}`                                                                           | `{ theme }`                                   | `doric.appearance/v1.get` |
| `appearanceSet` | `{ theme }`                                                                    | none                                          | `doric.appearance/v1.set` |

`keybinding`, `commandResult`, `log` and `diagnostic` are sent fire-and-forget (`shellNotify`, not exported): a throw or a rejection is dropped.

## The window runtime (`desktop/client`)

No React and no product code. It re-exports `desktop/protocol` ([`client/index.ts`](src/client/index.ts)).

### `bootstrapWindow`

```ts
interface BootstrapOptions {
  readonly mount?: (context: {
    readonly description: WindowDescription;
  }) => void | Promise<void>;
  readonly desktop?: DoricDesktopApi; // default window.doric.desktop
  readonly document?: Document;
  readonly importPart?: ImportPart; // default dynamic import()
  readonly elementRegistry?: () => ElementRegistry; // default customElements
  readonly keyTarget?: Pick<
    EventTarget,
    'addEventListener' | 'removeEventListener'
  >; // default window
}
function bootstrapWindow(options: BootstrapOptions): Promise<void>;
```

The shell sequence of every window ([`bootstrap.ts`](src/client/bootstrap.ts)):

1. `describeWindow()`; apply the chrome to the root element and follow `onChromeChanged`.
2. `catalog()`; `activateClientBundles` (below).
3. Wire the close answers, install the keybindings and serve the shell commands.
4. Decide, with `<core>` the composition's core bundle and `quarantined` its failure when the diagnostics hold it quarantined (`bundleId: <core>`, message: its quarantine reasons joined by `; `, or `Core bundle "<core>" is quarantined.` when there are none):
   - With `mount`: await `mount({ description })`; the failure is `quarantined` in the primary window, else none.
   - Without `mount`, in this order: in the primary window with `quarantined`, that is the failure and the body is left untouched; else, when the registry has no `<core>-outlet`, the failure is `quarantined` (in any window) or else `Core bundle "<core>" did not define <<core>-outlet>.`, and the body is left untouched; else the body's children become one `<<core>-outlet>` element and there is no failure.
5. Report: a failure → `reportFailure({ kind: 'core', bundleId, message })`; none → `ready()`. An exception thrown in steps 1–4 (a rejected call, a failed activation step, a throwing `mount`) → `reportFailure({ kind: 'bootstrap', message })` with the error's message, and neither `ready()` nor a core report follows. None of these reports is guarded: when `ready()` or either `reportFailure` rejects, `bootstrapWindow` rejects with that error.

```ts
interface ElementRegistry {
  define(tag: string, element: CustomElementConstructor): void;
  get(tag: string): CustomElementConstructor | undefined;
}
```

`ElementRegistry` is the part of `customElements` the runtime uses ([`elements.ts`](src/client/elements.ts)).

`applyChrome(chrome, root = document.documentElement)` sets `--doric-titlebar-height`, `--doric-safe-top`, `--doric-safe-left` and `--doric-safe-right` in px on the root's inline style ([`chrome.ts`](src/client/chrome.ts)).

### `activateClientBundles`

```ts
type ImportPart = (url: string) => Promise<{ activate?: Activate }>;
interface ClientActivation {
  readonly result: ActivationResult;
  readonly windowHooks: HookHandle<typeof WindowHooksV1> | undefined;
  readonly services: Services; // of the window platform principal `doric`
  readonly diagnostics: WindowDiagnostics;
}
function activateClientBundles(input: {
  catalog: WindowCatalog;
  desktop: DoricDesktopApi;
  description: WindowDescription;
  importPart?: ImportPart;
  document?: Document;
  elementRegistry?: () => ElementRegistry;
  now?: () => number;
}): Promise<ClientActivation>;
```

The client environment of one window, pinned to the catalog's generation ([`activate.ts`](src/client/activate.ts)):

1. A `WindowDiagnostics` loads the resolved environment.
2. A service directory — a `WindowDirectory` when the window has a key — and a runtime for environment `client`, with an abort signal for the generation.
3. The platform principal `doric` (version `PLATFORM_VERSION`) gets the window's platform providers: `provideClientPlatform`, `provideElements`, `provideConnection`, `provideBrowser`, `provideAppearance`.
4. Every remote contract of the catalog that no client part of this window provides is registered as a remote record (`remoteContractRecord`).
5. The stylesheets of the scheduled client parts are linked in activation order (`insertBundleStyles`).
6. The generic activation loop of `bundle/runtime` imports each part's `entry` and calls its `activate`; a failing part is quarantined and the others continue. When the hooks provider is ready, the window defines `WindowHooksV1` through it.

`result.stop()` stops the activation, ends the connection stream and aborts the generation signal.

`WindowDirectory(inner, windowKey, generationSignal)` wraps a `ServiceDirectory`: every local provider record it returns receives calls whose `scope.windowKey` is this window's, re-wrapping any other call in a hop call that carries it, which binds `WindowHooksV1` registrations to their window. Remote records are returned unchanged; main fills `windowKey` for calls that leave the window.

### The window's platform providers

All are registered under the principal `doric` ([`platform.ts`](src/client/platform.ts), [`elements.ts`](src/client/elements.ts), [`connection.ts`](src/client/connection.ts), [`browser.ts`](src/client/browser.ts), [`appearance.ts`](src/client/appearance.ts)):

- `provideClientPlatform(platform, { resolved, diagnostics, desktop, tokens, app })` provides the platform services shared with the other environments (`doric.catalog/v1`, `doric.bundle/v1`, `doric.log/v1`, `doric.diagnostics/v1`) — log records go to main with `doric.shell/v1.log`, fire-and-forget — and two client contracts with cardinality `one`: `doric.tokens/v1.get()` answers a copy of the description's `tokens`, and `doric.about/v1.get()` answers `{ version }` from the description's `app`.
- `WindowDiagnostics` is a `DiagnosticsStore` that also forwards each quarantine, report and recovery to main with `doric.shell/v1.diagnostic` (a `ShellDiagnostic`), fire-and-forget.
- `provideElements(platform, { principals, diagnostics, registry? })` provides `doric.elements/v1`, callable only by the window's active `ui/v1` provider (else `ContractError('not_owner')`). `define({ tag, element, owner })` defines the custom element and records its owner; a tag already defined in the registry or recorded fails with `registration_conflict`, and disposing the registration leaves the tag defined with no owner. `owner(tag)` answers the owner while its principal is open and not quarantined. `attach(element)` gives the element a child scope of its owner's services as `element.services` (`unavailable` when the tag has no active owner); `release(element)` disposes that scope and reports a failed dispose as `dispose_failed`. With no `customElements`, calls fail with `unavailable`.
- `provideConnection(platform, desktop)` provides `doric.connection/v1`: `status()` is a `ConnectionStatus`, `'connected'` or `'disconnected'` ([Contracts](../../docs/architecture/bundles/contracts.md)); it starts as `'disconnected'`, follows main's `doric.shell/v1.connection` stream, ignoring items that are not a valid status, and `subscribe(listener)` reports only changes; a listener that throws does not stop the others. It returns the stream's subscription.
- `provideBrowser(platform, desktop)` provides `doric.browser/v1.open(url)`, which calls `doric.shell/v1.openExternal({ url })`; main checks the URL before the system browser opens it.
- `provideAppearance(platform, desktop)` provides `doric.appearance/v1`: `get()` calls `appearanceGet` and `set({ theme })` calls `appearanceSet`; the window holds no preference of its own.

The contracts themselves are defined in `bundle/contracts` ([Contracts](../../docs/architecture/bundles/contracts.md)); `doric.catalog/v1` and `doric.diagnostics/v1` are described in [Core and quarantine](../../docs/architecture/bundles/core.md).

### The bridge

[`bridge.ts`](src/client/bridge.ts):

- `remoteContractRecord(desktop, contract)`: a provider record with `origin: 'remote'` whose `invoke` sends a `BridgeCallEnvelope` (a call id unique in the window, `<prefix>-<n>` with a prefix of up to 8 random base-36 characters drawn once per window and a counter from 1, `bundleId` of the caller, the scope without `windowKey`, the call's deadline and `traceparent`) through `desktop.call` and returns the output, or throws the answer's error as a `ContractError`. A method with a tuple input splits its trailing call argument by the tuple length; main validates the input. A `local` method throws `ContractError('local_only')`. A stream method takes its listener as the last input item (else `invalid_input`), subscribes, and returns a Disposable; items reach the listener until main sends `end` (with the error, if any) or the Disposable unsubscribes. Aborting a plain call's signal sends `cancel(id)`, at once when the signal is already aborted; the call is still sent, and the provider decides how it ends. Stream subscriptions use the same id scheme; `shellCall`/`shellStream` envelopes too.
- `bridgeError(error)`: the `ContractError` of a `BridgeError`.
- `withoutWindowKey(call)`: the call's scope without `windowKey`, or `undefined` when nothing else is left.
- `shellCall(desktop, method, input)` and `shellStream(desktop, method, listener)`: a `doric.shell/v1` call or stream with `bundleId: null`, deadline `0` and a new trace.

### Close, commands, keybindings and styles

- `answerClose(request, windowHooks)` ([`close.ts`](src/client/close.ts)): in phase `close`, `{ allow: true }` when forced or without hooks, else the answer of `WindowHooksV1.onClose`, with no deadline; when that hook throws or rejects, `answerClose` rejects and builds no answer. In phase `flush`, runs `onFlush` with the request's deadline (when non-zero), ignores its outcome and answers `{ allow: true }`; main enforces the deadline. `wireClose({ desktop, windowHooks })` answers every `onCloseRequested` with it and returns the unsubscribe function.
- `serveShellCommands({ desktop, services })` ([`commands.ts`](src/client/commands.ts)): for each request of main's `doric.shell/v1.commands` stream, runs `CommandsV1.execute(command, input ?? {})` and answers `commandResult` with `{ id, ok: true }` or `{ id, ok: false, error }`.
- `installKeybindings({ desktop, target?, mac? })` ([`keybindings.ts`](src/client/keybindings.ts)): follows the window's table from the `doric.shell/v1.keybindings` stream and installs one capture-phase `keydown` listener; a key that matches a binding is prevented and sent to main with `keybinding({ key })`. An empty table intercepts nothing. `mac` defaults to whether `navigator.platform` starts with `mac` in any letter case (`/^mac/i`). Returns a Disposable. How main builds the table and dispatches the command is in [Menus and keybindings](../../docs/architecture/bundles/menus-and-keybindings.md).
- `parseAccelerator(accelerator, mac)`: an Electron-style accelerator (`CmdOrCtrl+Shift+P`) as a chord; modifiers `cmd`/`command`/`meta`/`super`, `ctrl`/`control`, `cmdorctrl`/`commandorcontrol` (Meta on macOS, Control elsewhere), `alt`/`option`, `shift`, case-insensitive; key aliases `esc`, `return`, `space`, `plus`, `up`, `down`, `left`, `right`, `del`. `undefined` for an unknown modifier or an empty key. `matchesChord(event, chord)`: the event's lowercased `key` and all four modifier flags match.
- `insertBundleStyles({ order, parts, document? })` ([`styles.ts`](src/client/styles.ts)): appends one `<link rel="stylesheet" data-bundle="<id>">` to `<head>` for each id in `order` whose part has `styles`, and returns the links.

## Build and test

| Target                     | What it runs                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nx run desktop:build`     | `tsc --build tsconfig.lib.json` into `dist/`, then [`build-tokens.mjs`](scripts/build-tokens.mjs), which writes `src/styles/tokens.css` and `dist/tokens.json`. Depends on the build of `bundle`                                                                                           |
| `nx run desktop:typecheck` | `tsc --build tsconfig.json --emitDeclarationOnly`, after the build of `bundle`                                                                                                                                                                                                             |
| `nx run desktop:test`      | After `build`: compiles the tests and the component stories with `tsconfig.spec.json` into `dist-tests/`, runs [`verify-provenance.mjs`](scripts/verify-provenance.mjs), then `node --test` over `tests/`, `tests/client/`, `tests/reads/` and `tests/identity/` (DOM through `happy-dom`) |

The targets are defined in [`project.json`](project.json). `stories/` holds the components' stories. [`.storybook/preview.tsx`](.storybook/preview.tsx) is the harness Papercraft previews and Storybook wrap every story in: it imports `theme.css` and has one decorator that puts the story inside a `TooltipProvider` and a `div` with `bg-background p-6 text-foreground`. The platform build in `app/desktop/doric-platform` bundles `desktop/ui` and its subpaths for the windows ([Platform packages and theme tokens](../../docs/architecture/bundles/platform-packages.md#how-the-platform-files-are-built)).

## Related documents

- [Platform packages and theme tokens](../../docs/architecture/bundles/platform-packages.md): how the windows share this package, the import map, the Tailwind rule and `doric.tokens/v1`.
- [React inside Web Components](../../docs/architecture/bundles/react-web-components.md): custom elements built on `defineReactElement` and `portalHosts`.
- [Services and channels](../../docs/architecture/bundles/services-and-channels.md): calls from a desktop window over the bridge.
- [Menus and keybindings](../../docs/architecture/bundles/menus-and-keybindings.md): the keybinding table and command dispatch.
- [Boundaries](../../docs/architecture/bundles/boundaries.md): which parts may import which entry point.
- [Error messages](../../docs/features/error-messages.md): how the app shows failures.

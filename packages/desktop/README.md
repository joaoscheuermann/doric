# desktop

`packages/desktop` is the workspace package `desktop` (version `1.0.0`, private, ES modules). It holds the browser code every desktop window shares:

- **`desktop/ui`** — the shared UI: the shadcn components, the theme stylesheet, fonts and tokens, and the generic widgets several bundles draw (error notice, panels, code view, custom-element helpers). Client parts of bundles import it; the platform serves one copy of it per window.
- **`desktop/reads`** — browser-safe read helpers: path strings, the refresh queue, the retry policy of a pending read, and the error value every surface renders. Client parts of bundles import it; each part bundles its own copy.
- **`desktop/protocol`** — the window–main protocol: types and zod schemas of what the preload exposes, the IPC payloads and `doric.shell/v1`. The Electron main process and the preload import it to validate what a window sends.
- **`desktop/client`** — the window's loader runtime: bootstrap, client activation, the bridge to the main process and the window's platform providers. The renderer's bootstrap imports it ([`bootstrap.ts`](../../app/desktop/doric-renderer/src/bootstrap.ts)); bundles never import it in production code.

Nothing here names a bundle's concept (files, Git, changes): a bundle passes its own rows, labels, colours and error codes to these primitives. How the app serves `desktop/ui` to every window through the import map, which imports a bundle leaves external and how bundle stylesheets combine with the theme is in [Platform packages and theme tokens](../../docs/architecture/bundles/platform-packages.md).

## Entry points

The export map points the `@org/source` condition at the TypeScript source (used inside the workspace) and `types`, `import` and `default` at `dist/` ([`package.json`](package.json)).

| Specifier                      | File                                                               | Contents                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop`, `desktop/ui`        | [`src/index.ts`](src/index.ts)                                     | `ChromeBar`, `cn`, `PortalContainerProvider`, `usePortalContainer`, `defineReactElement`, `portalHosts`, `tokens`, `tokensCss`, `resolvedVariables`, `windowVariables`, and the types `ChromeBarProps`, `PortalContainerProviderProps`, `PortalHost`, `PortalHosts`, `ReactElementInstance`, `ReactElementOptions`, `Tokens`, `TokenSet` |
| `desktop/ui/<component>`       | `src/components/<component>.tsx` (pattern `./ui/*`)                | One shadcn component file ([The shadcn components](#the-shadcn-components))                                                                                                                                                                                                                                                              |
| `desktop/ui/utils`             | [`src/lib/utils.ts`](src/lib/utils.ts)                             | `cn`                                                                                                                                                                                                                                                                                                                                     |
| `desktop/ui/portal-container`  | [`src/portal-container.tsx`](src/portal-container.tsx)             | `PortalContainerProvider`, `usePortalContainer`                                                                                                                                                                                                                                                                                          |
| `desktop/ui/react-element`     | [`src/react-element.ts`](src/react-element.ts)                     | `defineReactElement`, `portalHosts` and their types                                                                                                                                                                                                                                                                                      |
| `desktop/ui/chrome-bar`        | [`src/chrome-bar.tsx`](src/chrome-bar.tsx)                         | `ChromeBar`, `ChromeBarProps`                                                                                                                                                                                                                                                                                                            |
| `desktop/ui/element-host`      | [`src/element-host.tsx`](src/element-host.tsx)                     | `ElementHost`, `useRegionItems`                                                                                                                                                                                                                                                                                                          |
| `desktop/ui/error-notice`      | [`src/error-notice.tsx`](src/error-notice.tsx)                     | `ErrorNotice`, `ErrorNoticeProps`, `toastError`, `ToastErrorInput`                                                                                                                                                                                                                                                                       |
| `desktop/ui/model-icon`        | [`src/model-icon.tsx`](src/model-icon.tsx)                         | `ModelIcon`                                                                                                                                                                                                                                                                                                                              |
| `desktop/ui/choice-list`       | [`src/choice-list.tsx`](src/choice-list.tsx)                       | `ChoiceList`, `ChoiceListProps`                                                                                                                                                                                                                                                                                                          |
| `desktop/ui/collapsible-block` | [`src/collapsible-block.tsx`](src/collapsible-block.tsx)           | `CollapsibleBlock`, `blockOpen`, `blockToggled`, `Chosen`, `Openness`, `CollapsibleBlockProps`                                                                                                                                                                                                                                           |
| `desktop/ui/comment-pin`       | [`src/comment-pin.tsx`](src/comment-pin.tsx)                       | `CommentPin`, `commentPinVariants`, `CommentPinState`, `CommentPinSize`, `CommentPinProps`                                                                                                                                                                                                                                               |
| `desktop/ui/identity`          | [`src/identity/index.ts`](src/identity/index.ts)                   | `initials`, `identityTone`, `identityRing`, `READER_NAME`                                                                                                                                                                                                                                                                                |
| `desktop/ui/reader-avatar`     | [`src/identity/reader-avatar.tsx`](src/identity/reader-avatar.tsx) | `ReaderAvatar`                                                                                                                                                                                                                                                                                                                           |
| `desktop/ui/panels`            | [`src/panels/index.ts`](src/panels/index.ts)                       | The panel widgets and the `@dnd-kit` sorting they use ([Panels](#panels-desktopuipanels))                                                                                                                                                                                                                                                |
| `desktop/ui/code`              | [`src/code/index.ts`](src/code/index.ts)                           | `CodeView`, `DiffEditor`, `DiffControls`, `fileLanguage` ([Code view](#code-view-and-diff-editor-desktopuicode))                                                                                                                                                                                                                         |
| `desktop/ui/viewport`          | [`src/viewport.ts`](src/viewport.ts)                               | Pan-and-zoom math ([Viewport](#viewport-desktopuiviewport))                                                                                                                                                                                                                                                                              |
| `desktop/ui/svg-mask`          | [`src/svg-mask.ts`](src/svg-mask.ts)                               | `svgMask`                                                                                                                                                                                                                                                                                                                                |
| `desktop/ui/cmdk`              | [`src/cmdk.ts`](src/cmdk.ts)                                       | `CommandPrimitive`, the `Command` of `cmdk`                                                                                                                                                                                                                                                                                              |
| `desktop/ui/tokens`            | [`src/tokens/tokens.ts`](src/tokens/tokens.ts)                     | `tokens`, `Tokens`, `TokenSet`                                                                                                                                                                                                                                                                                                           |
| `desktop/ui/tokens.json`       | `dist/tokens.json`                                                 | The `tokens` value as JSON, written by the build                                                                                                                                                                                                                                                                                         |
| `desktop/ui/theme.css`         | [`src/styles/theme.css`](src/styles/theme.css)                     | The stylesheet every window loads once                                                                                                                                                                                                                                                                                                   |
| `desktop/ui/tailwind.css`      | [`src/styles/tailwind.css`](src/styles/tailwind.css)               | The Tailwind reference entry bundle stylesheets `@reference`                                                                                                                                                                                                                                                                             |
| `desktop/reads`                | [`src/reads/index.ts`](src/reads/index.ts)                         | [Reads](#reads-desktopreads)                                                                                                                                                                                                                                                                                                             |
| `desktop/protocol`             | [`src/client/protocol.ts`](src/client/protocol.ts)                 | [The window–main protocol](#the-windowmain-protocol-desktopprotocol)                                                                                                                                                                                                                                                                     |
| `desktop/client`               | [`src/client/index.ts`](src/client/index.ts)                       | [The window runtime](#the-window-runtime-desktopclient), and everything `desktop/protocol` exports                                                                                                                                                                                                                                       |
| `desktop/package.json`         | [`package.json`](package.json)                                     | The manifest                                                                                                                                                                                                                                                                                                                             |

An explicit subpath wins over the `./ui/*` pattern, so `desktop/ui/<name>` resolves to a component file only when no entry above names it.

Runtime dependencies: React 19 and ReactDOM, Base UI (`@base-ui/react`), `cmdk`, `cn`, `class-variance-authority`, `lucide-react`, `sonner`, `@dnd-kit/*`, `react-resizable-panels`, `monaco-editor`, Tailwind CSS 4, `tw-animate-css`, `shadcn`, `zod` and the workspace package `bundle`. `@tanstack/query-core` is a peer dependency, used by `refreshQueries` ([`package.json`](package.json)).

## Shared UI (`desktop/ui`)

### `cn`

`cn(...inputs)` joins class names and merges conflicting Tailwind classes; it is the `cn` package re-exported ([`utils.ts`](src/lib/utils.ts)).

### The shadcn components

`src/components/` holds shadcn/ui files in the `base-nova` style, built on Base UI primitives, with Tailwind CSS and `lucide` icons ([`components.json`](components.json)). Each file is one subpath, `desktop/ui/<file>`:

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

- **Portal container.** The overlays — `AlertDialog`, `Combobox`, `ContextMenu`, `Dialog`, `DropdownMenu`, `Popover`, `Select`, `Sheet`, `Tooltip` and the components built on them — portal their content into the container the nearest `PortalContainerProvider` names, or into `document.body` outside one; a `container` passed directly to an overlay's `*Portal` wins (for example [`dialog.tsx`](src/components/dialog.tsx)).
- **`SidebarScope`** provides the sidebar context alone, with no wrapper element and no keyboard shortcut: inside it, a component reads the outer `SidebarProvider`'s context when there is one, and otherwise an expanded, non-mobile state whose setters do nothing. An element that draws sidebar rows from its own React root uses it ([`sidebar.tsx`](src/components/sidebar.tsx)).
- **`SidebarProvider`** keeps the open state in the cookie `sidebar_state` (path `/`, max-age seven days), toggles on ⌘B / Ctrl+B, and lays the sidebar out at `16rem` (`18rem` on mobile, `3rem` collapsed to icons); below 768 px wide the window counts as mobile ([`sidebar.tsx`](src/components/sidebar.tsx), [`use-mobile.ts`](src/hooks/use-mobile.ts)).
- **`Toaster`** follows the system theme by default (`theme="system"`), uses lucide icons for each toast type and paints toasts with `--popover`, `--popover-foreground`, `--border` and `--radius`. `toast` is re-exported from `sonner`, so every caller in a window reaches the store the window's `Toaster` reads ([`sonner.tsx`](src/components/sonner.tsx)).

#### Provenance check

Each component file, plus [`use-mobile.ts`](src/hooks/use-mobile.ts) and [`utils.ts`](src/lib/utils.ts), has a recorded origin in [`provenance.json`](tests/fixtures/provenance.json): `registry` (the shadcn CLI `shadcn@4.21.0`, style `base-nova`) or `renderer` (a copy read from Git at commit `20775a6`), with the SHA-256 of the original. [`PROVENANCE.md`](PROVENANCE.md) lists each file's origin and local patches. [`verify-provenance.mjs`](scripts/verify-provenance.mjs) undoes the import rewrites and the local patches, hashes the result and fails on any other difference or on a component file the record does not list. A component is changed through a recorded patch, never by hand alone.

### `PortalContainerProvider` and `usePortalContainer`

```ts
function PortalContainerProvider(props: {
  readonly container: HTMLElement | null | undefined;
  readonly children?: React.ReactNode;
}): React.JSX.Element;
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

`defineReactElement` returns a custom element class whose content is `render`, drawn in the element's light DOM with the services of the bundle that owns the element ([`react-element.ts`](src/react-element.ts)):

- Each name in `props` becomes a property of the element; setting it, or setting `services`, re-renders. Nothing renders until the element is connected and has `services`.
- On connection the element sets its own `style.display` to `display` (default `contents`), not in its constructor.
- `wrap`, when given, is called once per element with its services and wraps the content (a query client or a state provider).
- All elements of one class render through portals of one React root the class creates on first render, in mount order; each element's content sits in its own error boundary, so content that throws empties only its own element.
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

`portalHosts` makes host elements with no React root of their own: `Element` is `display: contents`, carries a `services` field and the listed properties, and `useHosts()` returns the connected hosts in connection order (frozen snapshots), re-rendering when one connects, disconnects or has a listed property set. The root that owns them renders their content with `createPortal`. How bundles build elements on these classes is in [React inside Web Components](../../docs/architecture/bundles/react-web-components.md).

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

`ElementHost` draws another bundle's element (a panel view, a view's badge). On mount and whenever `tag` changes it calls `ui.create(tag, props)` with the props current at that moment and places the element in its host `div`; on unmount or tag change it empties the host and calls `ui.dispose(element)`, ignoring a dispose that throws. A new `ui` object or new `props` alone do not create the element again. When `ui.create` throws, it logs `Doric: the element <tag> could not be created:` to the console and draws, for that tag, a compact, announced `ErrorNotice` with code `element_failed` (title "View failed to open", not retryable), message `The element <tag> could not be created.`, the thrown error as its cause and the context line `Element: <tag>` ([`element-host.tsx`](src/element-host.tsx)).

`useRegionItems` returns a region's items in the order `regions/v1` gives, through `useSyncExternalStore` on `regions.subscribe(region, …)`; the array is the same until the region changes, and empty on the server snapshot. `Ui`, `Regions` and `RegionEntry` come from `bundle/contracts` ([Contracts](../../docs/architecture/bundles/contracts.md)).

### The error notice (`desktop/ui/error-notice`)

`ErrorNotice` shows one `ErrorInfo` (from [`desktop/reads`](#the-error-value)) the same way on every surface ([`error-notice.tsx`](src/error-notice.tsx)):

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

`toastError` shows a `compact`, unannounced notice, without Retry, as a `sonner` custom toast (`data-slot="error-toast"`, 356 px wide). It lives 4,000 ms (sonner pauses it while the pointer is over the toaster or the window is hidden) and does not expire while its details are open. A later call with the same `id` replaces it in place, with its details closed. It needs the window's `Toaster` mounted to be seen; it returns nothing and never throws.

#### How a notice words an error

`describeError(info, { catalog?, fallbackCode? })` returns `{ title, explanation, retryable, tone }`; it is internal to the module, so the shared entries exist once per window ([`error-copy.ts`](src/error-copy.ts)):

1. The catalog is `catalog` merged over the shared catalog; the caller's entry wins for a code both list.
2. The headline level is the first of `[info, ...info.causes]` whose code has an entry and is not `internal`. Without one, `fallbackCode`'s entry titles the outermost level; without that, the first `internal` level takes the `internal` entry; without that, the `unknown` entry titles the outermost level.
3. `explanation` is the entry's explanation with `{provider}` replaced by the headline level's provider, else `info.provider`, else `the provider`. Without one, it is the first line of the headline level's message, else of `info.message`, else `The operation could not be completed.`; a line over 200 characters is cut to 199 and ends with `…`.
4. `retryable` is the entry's flag unless the headline level says `retryable: false`; under the `unknown` fallback it is the headline level's own flag, default `true`. `tone` is the entry's, default `error`.

The shared catalog holds the codes the platform packages define (`bundle`, `llms`, `agent`, `tool`), among them `unknown` and `internal` ("Something went wrong", retryable), `unavailable`, `disconnected`, `generation_lost`, `protocol_error` ("Doric host unavailable"), `invalid_input`, `not_found`, `conflict`, `revision_conflict`, `limit_exceeded`, the `credential_*` codes, the provider codes (`network_error`, `rate_limit_error`, `overloaded_error`, `api_error`, `http_error`, `auth_*`, …), the model and agent codes (`missing_model`, `output_truncated`, `turn_limit_exceeded`, `concurrent_run`, …) and the tool codes (`handler_failed`, `invalid_payload`, `unknown_tool`, `invalid_schema`, …); [`error-copy.ts`](src/error-copy.ts) states each entry's title, explanation and Retry flag. A bundle passes its own codes in its own `catalog`. The behavior of error messages across the app is in the feature doc [Error messages](../../docs/features/error-messages.md).

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

`CollapsibleBlock` props: `label` (shimmers while `openness.active`), `openness`, `chosen`, `onChosenChange(next)` (called with `blockToggled(chosen, openness)` on a header click), `action?` (`{ content, toggleLabel }`, a header action between two toggle triggers), `focused?` (header in the hover style), `guide?` (default `true`, the left guide line of the open content), `trailing?` (a control at the header's right end), `toggleLabel?` and `children`. It holds no state; the chevron points right when closed and down when open, and the children render only while open.

### `CommentPin`

```ts
type CommentPinState = 'open' | 'await' | 'done' | 'draft'; // default 'open'
type CommentPinSize = 'sm' | 'md' | 'lg'; // default 'md'
interface CommentPinProps
  extends
    Omit<ComponentProps<'button'>, 'type'>,
    VariantProps<typeof commentPinVariants> {}
```

A teardrop `<button type="button">` with `data-state` and `data-size`: `open` is primary, `await` `--paper-orange`, `done` `--paper-green`, `draft` a dashed primary outline; sizes are 20, 24 and 28 px. It is presentation only: the caller wires what a press does ([`comment-pin.tsx`](src/comment-pin.tsx)).

### Identity (`desktop/ui/identity`, `desktop/ui/reader-avatar`)

Plain strings, no React ([`identity-mark.ts`](src/identity/identity-mark.ts)):

- `initials(name)`: the first letters of the first two parts of `name`, split at any run of characters that are neither letters nor digits, uppercased (`'jao.scheuermann'` → `'JS'`); `'?'` when there is none.
- `identityTone(name)`: `color-mix(in oklch, oklch(0.55 0.18 <h>) 92%, var(--muted))`, where `<h>` is the FNV-1a hash of the name's code points modulo 360.
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

`FileTree` renders `<li>` items to hang from a `SidebarMenu` (`role="tree"`) or a `SidebarMenuSub`, starting at `depth`. It reads nothing: the whole tree arrives in `entries`, and `expanded` decides what is drawn. Under each open directory it draws the `pending` row first (when `pending.directory` is that path), then one `loadingDirectoryNotice` line when the path is in `loading` (the row is marked `aria-busy`), else its children, else — with no pending row — `emptyDirectoryNotice`. Rows are `role="treeitem"` with `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded` (directories) and `aria-selected`; click, Enter or Space opens a file (`actions.open`) or toggles a directory (`actions.toggle`), ArrowRight expands a closed directory and ArrowLeft collapses an open one. A decoration adds its `description` to the row's label and tooltip (the tooltip is the path) and draws a pinned badge: a directory's `count`, a file's `letter`, in the `tone` classes. `rowMenu(node)` gives the content of the row's context menu; `null` or no `rowMenu` means none. The tree is windowed: only the lines that intersect the visible part of the nearest clipping ancestors are drawn, plus an overscan of half a viewport and at least 12 lines (64 lines before the first measurement), with spacers holding the height of the rest; the focused row and the pending row stay drawn when scrolled away. A row is 1.75 rem, a notice 1.5 rem ([`tree-window.ts`](src/panels/tree-window.ts)).

**Tree helpers** ([`tree-guides.tsx`](src/panels/tree-guides.tsx), [`tree-skeleton.tsx`](src/panels/tree-skeleton.tsx), [`expansion.ts`](src/panels/expansion.ts)):

- `indentation(depth)`: a row's left padding, `0.375 + 1.25 × depth` rem. `treeClassName`: the class of the nested `SidebarMenuSub` that holds a level. `TreeGuides({ depth })`: the vertical lines that mark a row's depth.
- `rowInteraction(selected)`: deprecated; no row in this repository calls it, and its value stays as it is for bundles that do.
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

A horizontally scrolling row of shadcn tabs (`TabsList` with `activateOnFocus`) or, for `toggle`, a `role="group"` of toggles, labelled `label`. Tabs reorder by drag (after 6 px of pointer movement, along the horizontal axis, auto-scrolling the strip) or by keyboard (dnd-kit's Space sort, or Alt+Shift+ArrowLeft/ArrowRight to swap with a neighbour); each reorder calls `onMove(from, to)`. While sorting, tab widths are frozen. The selected tab scrolls into view when the selection, order or strip size changes; a vertical wheel over an overflowing strip scrolls it sideways. Clicking or pressing Enter on the selected tab calls `onReselect`; clicking a toggle calls `onSelect`. With `onClose`, each tab has a close button labelled `Close <label>`; in the `project` variant a middle click also closes. `tabMenu(id)` gives the content of a tab's context menu. `compactTabClassName` is the shared chrome of project and resource tabs. The hooks behind it, `useTabStrip(ids, selected, onMove)` and `useSortableTab(id, frozen?)`, are exported for strips that compose their own tabs.

**State and feedback** ([`panel-state.tsx`](src/panels/panel-state.tsx), [`read-feedback.tsx`](src/panels/read-feedback.tsx), [`use-read-error.ts`](src/panels/use-read-error.ts), [`move-item.ts`](src/panels/move-item.ts), [`toolbar-divider.tsx`](src/panels/toolbar-divider.tsx)):

- `PanelState({ title, description, icon? })`: an `Empty` state with a folder icon by default.
- `useReadError(error, refreshing, onRetry, toastId?)`: while `error` is a string and the surface is not refreshing, shows one `toast.error('Unable to update', { description: error, duration: 8000, action: 'Try again' })` per distinct message, under `toastId` or an id of its own; `error === undefined` or unmount dismisses it. `ReadFeedback({ error?, refreshing, onRetry, toastId? })` is the same as a component that renders nothing. Cached content stays on screen.
- `moveItem(items, from, to)`: a new array with the item at `from` moved to `to`; the same array when either index is out of range or they are equal.
- `ToolbarDivider()`: a short vertical `Separator`; deprecated, no product surface draws it.

### Code view and diff editor (`desktop/ui/code`)

Monaco loads with a dynamic import the first time an editor mounts, once per window, so importing the subpath does not load it ([`monaco.ts`](src/code/monaco.ts)). The loaded module registers the codicon font and the CSS, HTML, JavaScript, Markdown, Python, Rust, shell, SQL, TypeScript, XML and YAML languages, and starts only Monaco's editor worker, from `workers/editor.worker.js` beside the loaded chunk ([`monaco-runtime.ts`](src/code/monaco-runtime.ts), [`editor.worker.ts`](src/code/editor.worker.ts)).

- `fileLanguage(path)`: the Monaco language id by extension, case-insensitive (`ts`, `tsx`, `cts`, `mts` → `typescript`; `js`, `jsx`, `cjs`, `mjs` → `javascript`; `md`, `markdown`; `py`; `rs`; `sh`, `bash`, `zsh` → `shell`; `sql`; `css`; `html`, `htm`; `xml`, `svg` → `xml`; `yaml`, `yml`); anything else, a name without an extension or a dotfile is `plaintext`. JSON is `plaintext`, because its language service needs a worker of its own ([`language.ts`](src/code/language.ts)).
- `CodeView({ language, value })`: one read-only editor per mounted view, created with the first text and disposed on unmount; later text and language are applied to the same model, keeping the view state. It uses the container's `font-mono` family at 12 px, no minimap, no overview ruler, no sticky scroll, no line highlight, 10 px scrollbars that pass the wheel on at an edge, and no word wrap ([`code-view.tsx`](src/code/code-view.tsx)).
- `DiffEditor({ original, modified, language, diffTokens, toolbar, footer })`: a read-only inline diff that keeps its editor and models across refreshes. `toolbar` and `footer` render with `DiffControls`: `counts` (`{ added, removed }` lines, `{0, 0}` when the texts are equal, `undefined` until computed), `layout` (`'unified'` at first; `'split'` shows the sides side by side when the editor is wider than 700 px), `onLayout(value)` and `onNavigate('previous' | 'next')`. `diffTokens` (`{ added, removed }`) names the palette tokens of the added and removed lines ([`diff-editor.tsx`](src/code/diff-editor.tsx), [`diff-counts.ts`](src/code/diff-counts.ts)).
- Theme: both editors define a Monaco theme from the document's palette at creation, for dark when the root element has the class `dark` and light otherwise, converting `oklch(…)` tokens to hex; a colour that does not resolve keeps Monaco's default. A diff gets its own theme per pair of tokens, with the added and removed colours at alpha `0x33` for text and `0x18` for lines. Both redefine the theme when the system colour scheme changes ([`code-view-theme.ts`](src/code/code-view-theme.ts), [`oklch.ts`](src/code/oklch.ts)).

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

- `zoomAt` multiplies the scale by `factor` (clamped) and keeps `origin` (default `0, 0`) under the pointer.
- `fitViewport` centres `content` in `area` minus `margin` (default 24) on each side, at a scale never above 1 and never below 0.25; `undefined` when the content has no area, `IDENTITY` when the area minus margins has none.
- `wheelGesture({ deltaX, deltaY, deltaMode, zoom, captured, pageHeight })`: with `zoom` (Ctrl/⌘ or a pinch), `{ kind: 'zoom', factor: 1.1 }` when `deltaY < 0`, else `1 / 1.1`; otherwise, when `captured`, `{ kind: 'pan', dx: −deltaX × s, dy: −deltaY × s }` with `s` = 1, 16 or `pageHeight || 800` for `deltaMode` 0, 1, 2; otherwise `undefined`, and the caller leaves the wheel to the page.

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

- Each variant sets the shadcn colours (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--warning`, each with its `-foreground`, and `--border`, `--input`, `--ring`, `--chart-1`…`--chart-5`, `--sidebar*`), the `--paper-*` palette (surfaces, controls, ghost hover and pressed, grays 1–5, blues 2–5, orange, red, green, focus, selection, control shadow) and the shadows (`--shadow-color`, `--shadow-2xs` … `--shadow-2xl`).
- `shared` sets `--font-sans` and `--font-serif` (`'Noto Sans', -apple-system, BlinkMacSystemFont, sans-serif`), `--font-mono` and `--font-conversation` (`'IBM Plex Mono', monospace`), `--font-weight-normal` (400), `--font-weight-medium` (500), `--radius` (6px), `--paper-radius-control` (6px), `--paper-radius-panel` (8px), `--paper-text-sm|base|lg` (10, 12, 13 px), the shadow parameters, `--tracking-normal` and `--spacing` (0.25rem).
- `trafficLight.reservedWidth` is `insetX + 3 × size + 2 × 8 + insetX`, the room a chrome bar keeps for the macOS window buttons.

[`css.ts`](src/tokens/css.ts) turns them into CSS:

- `windowVariables(tokens)`: `--doric-titlebar-height` (`<titlebarHeight>px`), `--doric-window-background` (`var(--background)`), and `--doric-safe-top`, `--doric-safe-left`, `--doric-safe-right` (`0px`).
- `tokensCss(tokens)`: the text of `tokens.css` — a generated-file comment, `:root` with the light variant and the shared tokens, the dark variant under `@media (prefers-color-scheme: dark)` and under `.dark`, then `:root` with the window variables.
- `resolvedVariables(tokens, variant = tokens.defaultVariant)`: the shared tokens, that variant and the window variables in one record. The platform contract `doric.tokens/v1` answers this record ([`doric.tokens/v1`](../../docs/architecture/bundles/platform-packages.md#doricstokensv1)).

`desktop:build` runs [`build-tokens.mjs`](scripts/build-tokens.mjs) after compiling, which writes `src/styles/tokens.css` and `dist/tokens.json` from the compiled module. Both are generated: edit `tokens.ts` and rebuild. The main process reads `tokens.json` for the chrome bar's measures and the native window background.

### Stylesheets

- [`theme.css`](src/styles/theme.css) (`desktop/ui/theme.css`) is loaded once per window. It declares the layers `theme, base, components, utilities` and imports `tailwind.css`, Tailwind's preflight (layer `base`), [`fonts.css`](src/styles/fonts.css), `tokens.css` and Tailwind's utilities, generated from `src/components/`, `chrome-bar.tsx`, `element-host.tsx`, `error-notice.tsx`, `model-icon.tsx`, `choice-list.tsx` and `collapsible-block.tsx`. Its base layer gives every element `border-border` and `outline-ring/50`, sets `:root` to weight 300 and headings to `--font-weight-normal`; `.chrome-bar` takes `height: var(--doric-titlebar-height)`. The classes of `panels`, `code`, `comment-pin` and `reader-avatar` come from the bundle stylesheets that scan `packages/desktop/src`.
- [`tailwind.css`](src/styles/tailwind.css) (`desktop/ui/tailwind.css`) is the reference entry: Tailwind's theme, `tw-animate-css`, shadcn's Tailwind CSS, the `dark` variant (`&:is(.dark *)`), the colour, font and shadow tokens as Tailwind theme variables, and the radius scale (`--radius-sm` … `--radius-xl`, from `--radius`) in `@theme static`. A stylesheet that `@reference`s it gets those names and emits none of them.

The rules a bundle stylesheet follows (no `@theme`, `@source` of `packages/desktop/src`, link order) are in [Styles and the Tailwind rule](../../docs/architecture/bundles/platform-packages.md#styles-and-the-tailwind-rule).

### Fonts

The faces are vendored under [`assets/fonts`](assets/fonts) as variable `woff2` files, one per subset, and declared in [`fonts.css`](src/styles/fonts.css): **Noto Sans** (weights 100–900, normal and italic; Latin and Latin Extended; license `NotoSans-OFL.txt`) and **IBM Plex Mono** (weights 100–700, normal and italic; Latin1, Latin2, Latin3 and Pi; license `IBMPlexMono-OFL.txt`). The URLs are relative to `src/styles/`; the platform build copies the files and rewrites the URLs ([Fonts](../../docs/architecture/bundles/platform-packages.md#fonts)).

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

- `createRefreshQueue` coalesces bursts: the first `request()` schedules `read` after `delayMs`; requests while a run is scheduled join it, and requests during a run cause exactly one more run after it. Every waiting `request()` resolves when a run finishes with no request left pending. `dispose()` cancels the timer and resolves every waiter; later requests resolve at once ([`refresh.ts`](src/reads/refresh.ts)).
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

Types and zod schemas only, browser-safe; every schema is `.strict()` ([`protocol.ts`](src/client/protocol.ts)). How main and the window use them — the bridge, scopes, exposure and the host — is in [Services and channels](../../docs/architecture/bundles/services-and-channels.md#calls-from-a-desktop-window).

| Export                                               | Value or shape                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DESKTOP_CHANNEL`                                    | `'doric:desktop'`, the one `ipcMain.handle` channel of every window and the splash                                                                                                                                                                                                                                 |
| `DESKTOP_PUSH_CHANNEL`                               | `'doric:desktop:push'`, main's pushes to a window                                                                                                                                                                                                                                                                  |
| `SHELL_CONTRACT`                                     | `'doric.shell/v1'`                                                                                                                                                                                                                                                                                                 |
| `WindowChrome`, `windowChromeSchema`                 | `{ titleBar: 'native' \| 'integrated' \| 'none'; height: number; safeArea: { top, left, right: number } }`                                                                                                                                                                                                         |
| `WindowMode`                                         | `'connected' \| 'disconnected-copy' \| 'last-good-core'`                                                                                                                                                                                                                                                           |
| `WindowDescription`, `windowDescriptionSchema`       | `{ key: string \| null; kind: 'window' \| 'technical'; primary: boolean; path: string; generation: number \| null; chrome: WindowChrome; mode: WindowMode; tokens: Record<string, string>; app: { version: string } }`; `key` and `generation` are `null` for the splash                                           |
| `WindowFailure`, `windowFailureSchema`               | `{ kind: 'core' \| 'bootstrap'; bundleId?: string; message: string }`                                                                                                                                                                                                                                              |
| `CloseRequest`, `closeRequestSchema`                 | `{ phase: 'close' \| 'flush'; forced: boolean; deadline: number }` (epoch ms, `0` = none)                                                                                                                                                                                                                          |
| `CloseAnswer`, `closeAnswerSchema`                   | `{ allow: true } \| { allow: false; reason: string }`                                                                                                                                                                                                                                                              |
| `RemoteMethodSpec`, `remoteMethodSpecSchema`         | `{ tuple: number \| null; local: boolean; stream: boolean; expose?: MethodExposure }`                                                                                                                                                                                                                              |
| `remoteMethodSpecFromSchema(input, output, expose?)` | The spec of a method from its JSON Schemas: `tuple` is the `prefixItems` length of an array input; `stream` when the input has a stream item; `local` when any process-local value (a `LOCAL_KEY` marker) appears in the input other than the stream listener, or in the output of a non-stream method             |
| `RemoteContract`, `remoteContractSchema`             | `{ id; environment: 'desktopMain' \| 'host'; bundleId; version; contractVersion; cardinality: 'one' \| 'many'; methods: Record<string, RemoteMethodSpec> }`                                                                                                                                                        |
| `WindowPart`                                         | `{ entry: string; styles?: string }`, the `doric://app/bundles/<id>@<version>/client/` URLs of a client part                                                                                                                                                                                                       |
| `WindowCatalog`                                      | `{ generation; resolved: ResolvedEnvironment; parts: Record<string, WindowPart>; remote: readonly RemoteContract[]; hostId: string; storageGeneration: number }`                                                                                                                                                   |
| `BridgeScope`                                        | A call scope (`callScopeSchema`) without the key `windowKey` in any letter case; the schema refuses it                                                                                                                                                                                                             |
| `BridgeCallEnvelope`, `bridgeCallEnvelopeSchema`     | `{ id (non-empty); contract; method; input; bundleId: string \| null; scope?; deadline; traceparent }`; `bundleId: null` is the window platform                                                                                                                                                                    |
| `BridgeError`, `bridgeErrorSchema`                   | `{ code; message; details? }`, a `ContractError` as it crosses the IPC                                                                                                                                                                                                                                             |
| `BridgeResultPayload`, `bridgeResultPayloadSchema`   | `{ ok: true; output } \| { ok: false; error: BridgeError }`                                                                                                                                                                                                                                                        |
| `BridgeStreamEvent`                                  | `{ type: 'event'; event } \| { type: 'end'; error? }`                                                                                                                                                                                                                                                              |
| `DoricDesktopApi`                                    | What the preload exposes as `window.doric.desktop`: `describeWindow()`, `ready()`, `reportFailure(info)`, `onCloseRequested(handler)`, `onChromeChanged(listener)`, `catalog()`, `call(envelope)`, `cancel(id)`, `subscribe(envelope, listener)`; the `on*` and `subscribe` methods return an unsubscribe function |
| `desktopRequestSchema`, `DesktopRequest`             | What the preload sends on `doric:desktop`, discriminated by `op`: `describeWindow`, `ready`, `reportFailure`, `catalog`, `call`, `cancel`, `subscribe`, `unsubscribe`, `closeAnswer`; each takes an optional integer `generation`                                                                                  |
| `desktopPushSchema`, `DesktopPush`                   | What main pushes, discriminated by `type`: `close-requested` (`id`, `request`), `chrome` (`chrome`), `event` (`id`, `event`), `end` (`id`, `error?`)                                                                                                                                                               |
| `ShellKeybinding`, `shellKeybindingSchema`           | `{ key: string; command: string }`                                                                                                                                                                                                                                                                                 |
| `ShellCommandRequest`, `shellCommandRequestSchema`   | `{ id; command; input }`                                                                                                                                                                                                                                                                                           |
| `ShellCommandResult`, `shellCommandResultSchema`     | `{ id; ok: true } \| { id; ok: false; error: BridgeError }`                                                                                                                                                                                                                                                        |
| `ShellDiagnostic`, `shellDiagnosticSchema`           | `{ kind: 'quarantine'; bundleId; reason: { code; message } } \| { kind: 'report'; entry: { bundleId; kind; message; details? } } \| { kind: 'recovery'; reason }`                                                                                                                                                  |
| `shellMethods`, `ShellMethod`                        | The methods of `doric.shell/v1` and whether each is a stream: `keybindings`, `commands`, `connection` (streams); `keybinding`, `commandResult`, `log`, `diagnostic`, `openExternal`, `appearanceGet`, `appearanceSet` (calls)                                                                                      |

`doric.shell/v1` is platform-internal: a window calls it only with `bundleId: null`. A stream takes no input and delivers its items through `subscribe`.

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
4. Mount. With `mount`, call it. Without, replace the body's children with `<<core>-outlet>`, where `<core>` is the composition's core bundle.
5. Report. Any exception up to here → `reportFailure({ kind: 'bootstrap', message })`. In the primary window, a quarantined core → `reportFailure({ kind: 'core', bundleId, message })` with the quarantine reasons joined by `; ` (or `Core bundle "<core>" is quarantined.`). Without `mount`, a core that did not define `<core>-outlet` → the same report, with `Core bundle "<core>" did not define <<core>-outlet>.` when it is not quarantined. Otherwise `ready()`.

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
- `provideConnection(platform, desktop)` provides `doric.connection/v1`: `status()` starts as `'disconnected'`, follows main's `doric.shell/v1.connection` stream, ignoring items that are not a valid status, and `subscribe(listener)` reports only changes; a listener that throws does not stop the others. It returns the stream's subscription.
- `provideBrowser(platform, desktop)` provides `doric.browser/v1.open(url)`, which calls `doric.shell/v1.openExternal({ url })`; main checks the URL before the system browser opens it.
- `provideAppearance(platform, desktop)` provides `doric.appearance/v1`: `get()` calls `appearanceGet` and `set({ theme })` calls `appearanceSet`; the window holds no preference of its own.

The contracts themselves are defined in `bundle/contracts` ([Contracts](../../docs/architecture/bundles/contracts.md)); `doric.catalog/v1` and `doric.diagnostics/v1` are described in [Core and quarantine](../../docs/architecture/bundles/core.md).

### The bridge

[`bridge.ts`](src/client/bridge.ts):

- `remoteContractRecord(desktop, contract)`: a provider record with `origin: 'remote'` whose `invoke` sends a `BridgeCallEnvelope` (a call id unique in the window, `bundleId` of the caller, the scope without `windowKey`, the call's deadline and `traceparent`) through `desktop.call` and returns the output, or throws the answer's error as a `ContractError`. A method with a tuple input splits its trailing call argument by the tuple length; main validates the input. A `local` method throws `ContractError('local_only')`. A stream method takes its listener as the last input item (else `invalid_input`), subscribes, and returns a Disposable; items reach the listener until main sends `end` (with the error, if any) or the Disposable unsubscribes. Aborting a plain call's signal sends `cancel(id)`; the provider decides how the call ends.
- `bridgeError(error)`: the `ContractError` of a `BridgeError`.
- `withoutWindowKey(call)`: the call's scope without `windowKey`, or `undefined` when nothing else is left.
- `shellCall(desktop, method, input)` and `shellStream(desktop, method, listener)`: a `doric.shell/v1` call or stream with `bundleId: null`, deadline `0` and a new trace.

### Close, commands, keybindings and styles

- `answerClose(request, windowHooks)` ([`close.ts`](src/client/close.ts)): in phase `close`, `{ allow: true }` when forced or without hooks, else the answer of `WindowHooksV1.onClose`, with no deadline. In phase `flush`, runs `onFlush` with the request's deadline (when non-zero), ignores its outcome and answers `{ allow: true }`; main enforces the deadline. `wireClose({ desktop, windowHooks })` answers every `onCloseRequested` with it and returns the unsubscribe function.
- `serveShellCommands({ desktop, services })` ([`commands.ts`](src/client/commands.ts)): for each request of main's `doric.shell/v1.commands` stream, runs `CommandsV1.execute(command, input ?? {})` and answers `commandResult` with `{ id, ok: true }` or `{ id, ok: false, error }`.
- `installKeybindings({ desktop, target?, mac? })` ([`keybindings.ts`](src/client/keybindings.ts)): follows the window's table from the `doric.shell/v1.keybindings` stream and installs one capture-phase `keydown` listener; a key that matches a binding is prevented and sent to main with `keybinding({ key })`. An empty table intercepts nothing. `mac` defaults to whether `navigator.platform` starts with `Mac`. Returns a Disposable. How main builds the table and dispatches the command is in [Menus and keybindings](../../docs/architecture/bundles/menus-and-keybindings.md).
- `parseAccelerator(accelerator, mac)`: an Electron-style accelerator (`CmdOrCtrl+Shift+P`) as a chord; modifiers `cmd`/`command`/`meta`/`super`, `ctrl`/`control`, `cmdorctrl`/`commandorcontrol` (Meta on macOS, Control elsewhere), `alt`/`option`, `shift`, case-insensitive; key aliases `esc`, `return`, `space`, `plus`, `up`, `down`, `left`, `right`, `del`. `undefined` for an unknown modifier or an empty key. `matchesChord(event, chord)`: the event's lowercased `key` and all four modifier flags match.
- `insertBundleStyles({ order, parts, document? })` ([`styles.ts`](src/client/styles.ts)): appends one `<link rel="stylesheet" data-bundle="<id>">` to `<head>` for each id in `order` whose part has `styles`, and returns the links.

## Build and test

| Target                     | What it runs                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nx run desktop:build`     | `tsc --build tsconfig.lib.json` into `dist/`, then [`build-tokens.mjs`](scripts/build-tokens.mjs), which writes `src/styles/tokens.css` and `dist/tokens.json`. Depends on the build of `bundle`                                                                                           |
| `nx run desktop:typecheck` | `tsc --build tsconfig.json --emitDeclarationOnly`                                                                                                                                                                                                                                          |
| `nx run desktop:test`      | After `build`: compiles the tests and the component stories with `tsconfig.spec.json` into `dist-tests/`, runs [`verify-provenance.mjs`](scripts/verify-provenance.mjs), then `node --test` over `tests/`, `tests/client/`, `tests/reads/` and `tests/identity/` (DOM through `happy-dom`) |

The targets are defined in [`project.json`](project.json). `stories/` holds the components' stories. The platform build in `app/desktop/doric-platform` bundles `desktop/ui` and its subpaths for the windows ([Platform packages and theme tokens](../../docs/architecture/bundles/platform-packages.md#how-the-platform-files-are-built)).

## Related documents

- [Platform packages and theme tokens](../../docs/architecture/bundles/platform-packages.md): how the windows share this package, the import map, the Tailwind rule and `doric.tokens/v1`.
- [React inside Web Components](../../docs/architecture/bundles/react-web-components.md): custom elements built on `defineReactElement` and `portalHosts`.
- [Services and channels](../../docs/architecture/bundles/services-and-channels.md): calls from a desktop window over the bridge.
- [Menus and keybindings](../../docs/architecture/bundles/menus-and-keybindings.md): the keybinding table and command dispatch.
- [Boundaries](../../docs/architecture/bundles/boundaries.md): which parts may import which entry point.
- [Error messages](../../docs/features/error-messages.md): how the app shows failures.

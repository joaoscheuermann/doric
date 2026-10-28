// Proves the vendored components are shadcn's own files.
//
// Every file listed in tests/fixtures/provenance.json names its origin:
//
// - `renderer`: copied from app/doric-renderer at the record's
//   `renderer.commit`. Undoing the import rewrites (`@/components/ui/<x>` →
//   `./<x>.js`, `@/utility/utils` → `../lib/utils.js`, `@/hooks/use-mobile` →
//   `../hooks/use-mobile.js`) and the local patches below must give back that
//   file byte for byte.
// - `registry`: written by the record's `registry.cli` with `components.json`
//   set to `registry.style` (Base UI's `base-nova`), then formatted with the
//   repository's Prettier. Undoing the import rewrites (`@/components/<x>` →
//   `./<x>.js`, `@/hooks/use-mobile` → `../hooks/use-mobile.js`) and the local
//   patches below must give back that output, apart from a leading
//   `'use client'` directive, which the CLI emits inconsistently with `rsc:
//   false` and which nothing in a window reads.
//
// Any other difference, and any component file the record does not list,
// fails. PROVENANCE.md documents both origins and every patch.
//
//   node scripts/verify-provenance.mjs                     verify (run by desktop:test)
//   node scripts/verify-provenance.mjs --record <commit>   rewrite the renderer entries from git
//   node scripts/verify-provenance.mjs --record-registry <dir>
//                                       rewrite the registry entries from the CLI's output in <dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = join(packageRoot, 'tests/fixtures/provenance.json');

/**
 * The renderer path each `renderer` file came from at the recorded commit. It
 * is read only through `git show <commit>:<path>`, never from the working
 * tree, so the check holds after the renderer sources are deleted.
 */
const rendererPath = (file) =>
  file.startsWith('components/')
    ? `app/doric-renderer/src/components/ui/${file.slice('components/'.length)}`
    : file === 'lib/utils.ts'
      ? 'app/doric-renderer/src/utility/utils.ts'
      : `app/doric-renderer/src/${file}`;

/**
 * The portal container patch: an overlay portals into the container the
 * nearest `PortalContainerProvider` names. `spread` is the original return of
 * a `*Portal` wrapper that spreads its props into the primitive (a caller's
 * own `container` still wins), and `inline` names the primitive whose content
 * component renders its `Portal` inline.
 */
const portalContainer = ({ primitive, spread, inline = false }) => {
  const reads = '  const container = usePortalContainer();\n';
  const entries = [
    ["import { usePortalContainer } from '../portal-container.js';\n", ''],
  ];
  if (spread !== undefined) {
    entries.push([
      `${reads}  return (\n    <${primitive}.Portal\n      data-slot="${spread.slot}"\n      container={container}\n      {...props}\n    />\n  );\n`,
      spread.text,
    ]);
  }
  if (inline) {
    entries.push([
      `${reads}  return (\n    <${primitive}.Portal container={container}>\n`,
      `  return (\n    <${primitive}.Portal>\n`,
    ]);
  }
  return entries;
};

/** A `*Portal` wrapper's original one-line return. */
const oneLine = (primitive, slot) => ({
  slot,
  text: `  return <${primitive}.Portal data-slot="${slot}" {...props} />;\n`,
});

/** A `*Portal` wrapper's original return, wrapped in parentheses. */
const wrapped = (primitive, slot) => ({
  slot,
  text: `  return (\n    <${primitive}.Portal data-slot="${slot}" {...props} />\n  );\n`,
});

// The composer's white control: a fill the theme's blue `--primary` cannot
// give, with an icon that stays dark on it in either theme.
const solidButton = [
  "        solid:\n          'border-[var(--border)] bg-white text-[#101010] shadow-sm hover:bg-[#fafafa]',\n",
  '',
];

// Labels and titles take the regular weight where shadcn writes `font-medium`;
// running text is the theme's light root weight.
const regular = (before) => [
  before.replace('font-medium', 'font-normal'),
  before,
];
const light = (before) => [before.replace('font-normal', 'font-light'), before];

// WP-10N: `SidebarScope`, the context alone for another bundle's element.
const sidebarScope = [
  [
    "/**\n * The sidebar context alone, with no wrapper element and no shortcut: for a\n * bundle element that draws sidebar rows inside another bundle's sidebar\n * (its own React root cannot see that provider). It reports the expanded,\n * non-mobile state the workspace sidebar always has where those rows show.\n */\nconst scopeValue: SidebarContextProps = {\n  state: 'expanded',\n  open: true,\n  setOpen: () => undefined,\n  openMobile: false,\n  setOpenMobile: () => undefined,\n  isMobile: false,\n  toggleSidebar: () => undefined,\n};\n\nfunction SidebarScope({ children }: { readonly children?: React.ReactNode }) {\n  const outer = React.useContext(SidebarContext);\n  return (\n    <SidebarContext.Provider value={outer ?? scopeValue}>\n      {children}\n    </SidebarContext.Provider>\n  );\n}\n\n",
    '',
  ],
  ['  SidebarRail,\n  SidebarScope,', '  SidebarRail,'],
];

/**
 * The local patches of the `renderer` files, each undone exactly. A patch
 * that no longer matches leaves the text changed, so the hash check reports
 * the file.
 */
const rendererPatches = {
  'components/sonner.tsx': [
    [
      '/**\n * Follow the operating system, including changes while a window is open.\n */',
      '/**\n * The shell is dark only — `index.html` sets `dark` once and nothing toggles it —\n * so the toast takes a dark theme by default instead of resolving one through a\n * provider this application does not have. Pass `theme` to override it.\n */',
    ],
    ["theme = 'system'", "theme = 'dark'"],
    [
      "import { Toaster as Sonner, type ToasterProps, toast } from 'sonner';",
      "import { Toaster as Sonner, type ToasterProps } from 'sonner';",
    ],
    [
      '/*\n' +
        ' * `toast` is re-exported so every caller in a window reaches the one store the\n' +
        " * window's `Toaster` reads, whichever chunk it was loaded from.\n" +
        ' */\n' +
        'export { Toaster, toast };',
      'export { Toaster };',
    ],
  ],
  'components/alert.tsx': [
    regular("'font-medium group-has-[>svg]/alert:col-start-2"),
  ],
  'components/empty.tsx': [regular("'text-sm font-medium tracking-tight'")],
  'components/field.tsx': [
    regular("'mb-1.5 font-medium"),
    regular('text-sm font-medium group-data-[disabled=true]/field'),
    light('leading-normal font-normal text-muted-foreground'),
    light("'text-sm font-normal text-destructive'"),
  ],
  'components/table.tsx': [
    regular('bg-muted/50 font-medium'),
    regular('align-middle font-medium'),
  ],
};

/** The local patches of the `registry` files, each undone exactly. */
const registryPatches = {
  'components/alert-dialog.tsx': [
    ...portalContainer({
      primitive: 'AlertDialogPrimitive',
      spread: wrapped('AlertDialogPrimitive', 'alert-dialog-portal'),
    }),
    regular("'text-base font-medium sm:"),
  ],
  'components/badge.tsx': [regular('text-xs font-medium whitespace-nowrap')],
  'components/combobox.tsx': [
    ...portalContainer({
      primitive: 'ComboboxPrimitive',
      inline: true,
    }),
    regular('text-xs font-medium whitespace-nowrap text-foreground'),
  ],
  'components/command.tsx': [regular('**:[[cmdk-group-heading]]:font-medium')],
  'components/context-menu.tsx': [
    ...portalContainer({
      primitive: 'ContextMenuPrimitive',
      spread: wrapped('ContextMenuPrimitive', 'context-menu-portal'),
      inline: true,
    }),
    regular('text-xs font-medium text-muted-foreground data-inset:pl-7'),
  ],
  'components/dialog.tsx': [
    ...portalContainer({
      primitive: 'DialogPrimitive',
      spread: oneLine('DialogPrimitive', 'dialog-portal'),
    }),
    regular("'text-base leading-none font-medium'"),
  ],
  'components/dropdown-menu.tsx': [
    ...portalContainer({
      primitive: 'MenuPrimitive',
      spread: oneLine('MenuPrimitive', 'dropdown-menu-portal'),
      inline: true,
    }),
    regular('text-xs font-medium text-muted-foreground data-inset:pl-7'),
  ],
  'components/input-group.tsx': [
    regular('text-sm font-medium text-muted-foreground'),
  ],
  'components/input.tsx': [regular('file:font-medium')],
  'components/kbd.tsx': [regular('text-xs font-medium text-muted-foreground')],
  'components/label.tsx': [regular('leading-none font-medium')],
  'components/popover.tsx': [
    ...portalContainer({
      primitive: 'PopoverPrimitive',
      inline: true,
    }),
    regular("cn('font-medium', className)"),
  ],
  'components/progress.tsx': [regular("cn('text-sm font-medium', className)")],
  'components/select.tsx': portalContainer({
    primitive: 'SelectPrimitive',
    inline: true,
  }),
  'components/sheet.tsx': [
    ...portalContainer({
      primitive: 'SheetPrimitive',
      spread: oneLine('SheetPrimitive', 'sheet-portal'),
    }),
    regular("'text-base font-medium text-foreground'"),
  ],
  'components/tabs.tsx': [regular('text-sm font-medium whitespace-nowrap')],
  'components/toggle.tsx': [regular('text-sm font-medium whitespace-nowrap')],
  'components/tooltip.tsx': portalContainer({
    primitive: 'TooltipPrimitive',
    inline: true,
  }),
  'components/button.tsx': [
    // Commit `5fac0ee`: the default variant hovers by mixing in the foreground.
    [
      "        default:\n          'bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),var(--foreground)_12%)]',\n",
      "        default: 'bg-primary text-primary-foreground hover:bg-primary/80',\n",
    ],
    solidButton,
    regular('text-sm font-medium whitespace-nowrap'),
  ],
  'components/scroll-area.tsx': [
    // The registry file imports React and never reads it (`noUnusedLocals`).
    ['', "import * as React from 'react';\n"],
  ],
  'components/sidebar.tsx': [
    // The menu action also shows on hover and focus inside a sub-item.
    [
      ' group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100',
      '',
    ],
    ...sidebarScope,
    regular('text-xs font-medium text-sidebar-foreground/70'),
    regular('data-active:font-medium'),
    regular('text-xs font-medium text-sidebar-foreground tabular-nums'),
  ],
};

/** Removes a leading `'use client'` directive (see the header). */
const withoutDirective = (text) => text.replace(/^'use client';\n\n/, '');

/** A vendored file's text as its origin wrote it. */
export const original = (file, text, origin = 'renderer') => {
  if (origin === 'registry') {
    let result = withoutDirective(text)
      .replaceAll(/'\.\/([a-z-]+)\.js'/g, "'@/components/$1'")
      .replaceAll("'../hooks/use-mobile.js'", "'@/hooks/use-mobile'");
    for (const [patched, before] of registryPatches[file] ?? []) {
      result =
        patched === '' ? before + result : result.replace(patched, before);
    }
    return result;
  }
  let result = text
    .replaceAll(/'\.\/([a-z-]+)\.js'/g, "'@/components/ui/$1'")
    .replaceAll("'../lib/utils.js'", "'@/utility/utils'")
    .replaceAll("'../hooks/use-mobile.js'", "'@/hooks/use-mobile'");
  for (const [patched, before] of rendererPatches[file] ?? []) {
    result = result.replace(patched, before);
  }
  return result;
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The vendored files under `root/src`: every component, plus the listed extras. */
const vendored = (root) => [
  ...readdirSync(join(root, 'src/components'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => `components/${name}`),
  'hooks/use-mobile.ts',
  'lib/utils.ts',
];

const readRecord = () => JSON.parse(readFileSync(recordPath, 'utf8'));

const writeRecord = (record) => {
  const files = Object.fromEntries(
    Object.entries(record.files).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  writeFileSync(
    recordPath,
    `${JSON.stringify({ ...record, files }, null, 2)}\n`,
  );
};

/**
 * The differences between the vendored files under `root` and the record: one
 * message per file that is unlisted, missing or changed. Empty when they match.
 */
export const verify = (root = packageRoot) => {
  const record = readRecord();
  const present = new Set(vendored(root));
  const problems = [];
  for (const file of present) {
    if (record.files[file] === undefined) {
      problems.push(`${file}: not in the provenance record`);
    }
  }
  for (const [file, entry] of Object.entries(record.files)) {
    if (!present.has(file)) {
      problems.push(`${file}: listed but missing`);
      continue;
    }
    const text = readFileSync(join(root, 'src', file), 'utf8');
    if (sha256(original(file, text, entry.origin)) !== entry.sha256) {
      problems.push(
        entry.origin === 'registry'
          ? `${file}: differs from ${record.registry.cli} ${record.registry.style} beyond the import rewrites and PROVENANCE.md patches`
          : `${file}: differs from ${rendererPath(file)} at ${record.renderer.commit} beyond the import rewrites and PROVENANCE.md patches`,
      );
    }
  }
  return problems;
};

/** Rewrites the `renderer` entries from git. */
const recordRenderer = (commit) => {
  const repository = join(packageRoot, '../..');
  const record = readRecord();
  for (const [file, entry] of Object.entries(record.files)) {
    if (entry.origin !== 'renderer') continue;
    const text = execFileSync(
      'git',
      ['show', `${commit}:${rendererPath(file)}`],
      { cwd: repository, encoding: 'utf8' },
    );
    record.files[file] = { origin: 'renderer', sha256: sha256(text) };
  }
  writeRecord({ ...record, renderer: { commit } });
};

/**
 * Rewrites the `registry` entries from the CLI's formatted output in `dir`
 * (`<dir>/<name>.tsx`, see PROVENANCE.md).
 */
const recordRegistry = (dir) => {
  const record = readRecord();
  for (const [file, entry] of Object.entries(record.files)) {
    if (entry.origin !== 'registry') continue;
    const text = readFileSync(
      join(dir, file.slice('components/'.length)),
      'utf8',
    );
    record.files[file] = {
      origin: 'registry',
      sha256: sha256(withoutDirective(text)),
    };
  }
  writeRecord(record);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--record') {
    recordRenderer(process.argv[3] ?? readRecord().renderer.commit);
  } else if (process.argv[2] === '--record-registry') {
    recordRegistry(process.argv[3]);
  } else {
    const problems = verify();
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
  }
}

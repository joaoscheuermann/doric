// Proves the vendored components are the renderer's own shadcn files.
//
// Every file listed in tests/fixtures/provenance.json was copied from
// app/doric-renderer at the commit the file names. Undoing the import rewrites
// (`@/components/ui/<x>` → `./<x>.js`, `@/utility/utils` → `../lib/utils.js`,
// `@/hooks/use-mobile` → `../hooks/use-mobile.js`) and the local patches listed
// in PROVENANCE.md must give back that file byte for byte. Any other difference,
// and any component file the record does not list, fails.
//
//   node scripts/verify-provenance.mjs            verify (run by desktop:test)
//   node scripts/verify-provenance.mjs --record   rewrite the record from git
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = join(packageRoot, 'tests/fixtures/provenance.json');

/**
 * The renderer path each vendored file came from at the recorded commit. It is
 * read only through `git show <commit>:<path>`, never from the working tree,
 * so the check holds after the renderer sources are deleted.
 */
const origin = (file) =>
  file.startsWith('components/')
    ? `app/doric-renderer/src/components/ui/${file.slice('components/'.length)}`
    : file === 'lib/utils.ts'
      ? 'app/doric-renderer/src/utility/utils.ts'
      : `app/doric-renderer/src/${file}`;

/**
 * The local patches, each undone exactly. A patch that no longer matches leaves
 * the text changed, so the hash check reports the file.
 */
const patches = {
  'components/sonner.tsx': [
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
  // WP-10N: `SidebarScope`, the context alone for another bundle's element.
  'components/sidebar.tsx': [
    [
      "/**\n * The sidebar context alone, with no wrapper element and no shortcut: for a\n * bundle element that draws sidebar rows inside another bundle's sidebar\n * (its own React root cannot see that provider). It reports the expanded,\n * non-mobile state the workspace sidebar always has where those rows show.\n */\nconst scopeValue: SidebarContextProps = {\n  state: 'expanded',\n  open: true,\n  setOpen: () => undefined,\n  openMobile: false,\n  setOpenMobile: () => undefined,\n  isMobile: false,\n  toggleSidebar: () => undefined,\n};\n\nfunction SidebarScope({ children }: { readonly children?: React.ReactNode }) {\n  const outer = React.useContext(SidebarContext);\n  return (\n    <SidebarContext.Provider value={outer ?? scopeValue}>\n      {children}\n    </SidebarContext.Provider>\n  );\n}\n\n",
      '',
    ],
    ['  SidebarRail,\n  SidebarScope,', '  SidebarRail,'],
  ],
};

/** A vendored file's text as the renderer wrote it. */
export const original = (file, text) => {
  let result = text
    .replaceAll(/'\.\/([a-z-]+)\.js'/g, "'@/components/ui/$1'")
    .replaceAll("'../lib/utils.js'", "'@/utility/utils'")
    .replaceAll("'../hooks/use-mobile.js'", "'@/hooks/use-mobile'");
  for (const [patched, before] of patches[file] ?? []) {
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

/**
 * The differences between the vendored files under `root` and the record: one
 * message per file that is unlisted, missing or changed. Empty when they match.
 */
export const verify = (root = packageRoot) => {
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const present = new Set(vendored(root));
  const problems = [];
  for (const file of present) {
    if (record.files[file] === undefined) {
      problems.push(`${file}: not in the provenance record`);
    }
  }
  for (const [file, hash] of Object.entries(record.files)) {
    if (!present.has(file)) {
      problems.push(`${file}: listed but missing`);
      continue;
    }
    const text = readFileSync(join(root, 'src', file), 'utf8');
    if (sha256(original(file, text)) !== hash) {
      problems.push(
        `${file}: differs from ${origin(file)} at ${record.commit} beyond the import rewrites and PROVENANCE.md patches`,
      );
    }
  }
  return problems;
};

const record = (commit) => {
  const repository = join(packageRoot, '../..');
  const files = {};
  for (const file of vendored(packageRoot).sort()) {
    const text = execFileSync('git', ['show', `${commit}:${origin(file)}`], {
      cwd: repository,
      encoding: 'utf8',
    });
    files[file] = sha256(text);
  }
  writeFileSync(recordPath, `${JSON.stringify({ commit, files }, null, 2)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--record') {
    record(process.argv[3] ?? '20775a6');
  } else {
    const problems = verify();
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
  }
}

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  baseName,
  changeLetter,
  classifyDiff,
  collapsedPath,
  type DiffFile,
  diffStat,
  emptyDirectoryNotice,
  fileLanguage,
  isWithin,
  joinPath,
  parentPath,
  pathSegments,
  ROOT_NAME,
  ROOT_PATH,
  sandboxNotice,
  toggleExpanded,
  truncationNotice,
} from '../src/domain/files';
import type { ProjectDiff } from '../src/domain/workspace';

const diffOf = (diff: string): ProjectDiff => ({
  repository: true,
  diff,
  changes: [],
});

const kinds = (file: DiffFile | undefined): readonly string[] =>
  (file?.lines ?? []).map(({ kind }) => kind);

const texts = (file: DiffFile | undefined): readonly string[] =>
  (file?.lines ?? []).map(({ text }) => text);

/** A diff that patches two files, adds one, and renames another. */
const multiFileDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@',
  " import { a } from 'a';",
  '-const one = 1;',
  '+const one = 2;',
  '+const two = 2;',
  ' export default one;',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1,2 @@',
  '+# New',
  '+Body',
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 88%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  'index 4444444..5555555 100644',
  '--- a/src/old-name.ts',
  '+++ b/src/new-name.ts',
  '@@ -6,3 +6,3 @@',
  ' const final = 3;',
  '-const last = 4;',
  '+const last = 5;',
  '\\ No newline at end of file',
].join('\n');

describe('sandbox paths', () => {
  test('joins and parents a path at the workspace root', () => {
    assert.equal(joinPath(ROOT_PATH, 'src'), 'src');
    assert.equal(joinPath('src', 'app.ts'), 'src/app.ts');
    assert.equal(parentPath('src/app.ts'), 'src');
    assert.equal(parentPath('app.ts'), ROOT_PATH);
    assert.equal(baseName('src/app.ts'), 'app.ts');
    assert.equal(baseName('app.ts'), 'app.ts');
    assert.equal(baseName(ROOT_PATH), ROOT_PATH);
  });

  test('keeps a path within its directory and nothing beside it', () => {
    assert.equal(isWithin('src/app.ts', 'src'), true);
    assert.equal(isWithin('src', 'src'), true);
    assert.equal(isWithin('src/app.ts', ROOT_PATH), true);
    assert.equal(isWithin('srcx/app.ts', 'src'), false);
  });

  test('names every segment from the workspace root down to the path', () => {
    assert.deepEqual(pathSegments('src/domain/files.ts'), [
      { name: ROOT_NAME, path: ROOT_PATH },
      { name: 'src', path: 'src' },
      { name: 'domain', path: 'src/domain' },
      { name: 'files.ts', path: 'src/domain/files.ts' },
    ]);
    assert.deepEqual(pathSegments(ROOT_PATH), [
      { name: ROOT_NAME, path: ROOT_PATH },
    ]);
  });

  test('toggles one directory without touching the others', () => {
    const expanded = toggleExpanded(new Set(['src']), 'src/domain');
    assert.deepEqual([...expanded].sort(), ['src', 'src/domain']);
    assert.deepEqual([...toggleExpanded(expanded, 'src')], ['src/domain']);
  });

  test('keeps a short chain whole and collapses the middle of a deep one', () => {
    assert.deepEqual(collapsedPath(ROOT_PATH), {
      leading: { name: ROOT_NAME, path: ROOT_PATH },
      hidden: [],
      trailing: [],
    });

    // The root, one directory and the file: nothing to hide.
    const short = collapsedPath('src/files.ts');

    assert.deepEqual(short.hidden, []);
    assert.deepEqual(
      short.trailing.map(({ path }) => path),
      ['src', 'src/files.ts'],
    );

    // Two directories deep already puts the outer one behind the trigger.
    const deep = collapsedPath('src/domain/hooks/files.ts');

    assert.deepEqual(deep.leading, { name: ROOT_NAME, path: ROOT_PATH });
    assert.deepEqual(deep.hidden, [
      { name: 'src', path: 'src' },
      { name: 'domain', path: 'src/domain' },
    ]);
    assert.deepEqual(deep.trailing, [
      { name: 'hooks', path: 'src/domain/hooks' },
      {
        name: 'files.ts',
        path: 'src/domain/hooks/files.ts',
      },
    ]);
  });
});

describe('diff classification', () => {
  test('splits a multi-file diff on its headers, in order', () => {
    const files = classifyDiff(diffOf(multiFileDiff));

    assert.deepEqual(
      files.map(({ path }) => path),
      ['src/app.ts', 'docs/new.md', 'src/new-name.ts'],
    );
  });

  test('reads hunk lines as adds, removes and context without their marker', () => {
    const [file] = classifyDiff(diffOf(multiFileDiff));

    assert.deepEqual(kinds(file), [
      'meta',
      'meta',
      'meta',
      'meta',
      'context',
      'remove',
      'add',
      'add',
      'context',
    ]);
    assert.deepEqual(texts(file)?.slice(4), [
      "import { a } from 'a';",
      'const one = 1;',
      'const one = 2;',
      'const two = 2;',
      'export default one;',
    ]);
  });

  test('keeps a hunk header, a mode line and the no-newline marker as meta', () => {
    const files = classifyDiff(diffOf(multiFileDiff));
    const newFile = files[1];
    const renamed = files[2];

    assert.equal(newFile?.lines[0]?.text, 'new file mode 100644');
    assert.ok(newFile?.lines.some(({ text }) => text === '@@ -0,0 +1,2 @@'));
    assert.deepEqual(renamed?.lines.at(-1), {
      kind: 'meta',
      text: '\\ No newline at end of file',
    });
    assert.deepEqual(kinds(renamed), [
      'meta',
      'meta',
      'meta',
      'meta',
      'meta',
      'meta',
      'meta',
      'context',
      'remove',
      'add',
      'meta',
    ]);
  });

  test('names a rename by the path the file view can open', () => {
    const renamed = classifyDiff(diffOf(multiFileDiff))[2];

    assert.equal(renamed?.path, 'src/new-name.ts');
  });

  test('reads a quoted header, as git writes a path it cannot print plainly', () => {
    const files = classifyDiff(
      diffOf(
        [
          'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
          'index 6666666..7777777 100644',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
      ),
    );

    assert.deepEqual(
      files.map(({ path }) => path),
      ['caf\\303\\251.txt'],
    );
    assert.deepEqual(kinds(files[0]), ['meta', 'meta', 'remove', 'add']);
  });

  test('drops the text that belongs to no file', () => {
    const files = classifyDiff(
      diffOf(
        [
          'warning: something',
          'diff --git a/one b/one',
          '@@ -1 +1 @@',
          '-a',
          '+b',
        ].join('\n'),
      ),
    );

    assert.equal(files.length, 1);
    assert.deepEqual(kinds(files[0]), ['meta', 'remove', 'add']);
  });

  test('reads a diff that carries no trailing newline', () => {
    const files = classifyDiff(
      diffOf('diff --git a/one b/one\n@@ -1 +1 @@\n-a\n+b'),
    );

    assert.deepEqual(kinds(files[0]), ['meta', 'remove', 'add']);
  });

  test('reports no file for an empty diff', () => {
    assert.deepEqual(classifyDiff(diffOf('')), []);
  });

  test('counts added and removed lines across every file', () => {
    const files = classifyDiff(diffOf(multiFileDiff));

    assert.deepEqual(diffStat(files), { added: 5, removed: 2 });
    assert.deepEqual(
      diffStat(
        classifyDiff(diffOf('diff --git a/one b/one\n@@ -1 +1 @@\n-a\n+b')),
      ),
      { added: 1, removed: 1 },
    );
    assert.deepEqual(diffStat([]), { added: 0, removed: 0 });
  });
});

describe('the language a file is read as', () => {
  test('names a language by the extension of the file itself', () => {
    const named = [
      'src/app.ts',
      'src/app.tsx',
      'src/app.mts',
      'src/app.cts',
      'src/app.mjs',
      'src/app.jsx',
      'src/app.css',
      'src/app.html',
      'src/app.xml',
      'src/app.yaml',
      'src/app.yml',
      'src/app.sh',
      'src/app.py',
      'src/app.rs',
      'src/app.sql',
      'README.md',
    ];

    assert.deepEqual(named.map(fileLanguage), [
      'typescript',
      'typescript',
      'typescript',
      'typescript',
      'javascript',
      'javascript',
      'css',
      'html',
      'xml',
      'yaml',
      'yaml',
      'shell',
      'python',
      'rust',
      'sql',
      'markdown',
    ]);
  });

  test('reads an extension whatever case it is written in', () => {
    assert.equal(fileLanguage('SRC/App.TSX'), 'typescript');
    assert.equal(fileLanguage('Docker.YML'), 'yaml');
  });

  test('reads a name with no extension as plaintext', () => {
    assert.equal(fileLanguage('Makefile'), 'plaintext');
    assert.equal(fileLanguage('src/Dockerfile'), 'plaintext');
    assert.equal(fileLanguage('.gitignore'), 'plaintext');
    assert.equal(fileLanguage('LICENSE'), 'plaintext');
    assert.equal(fileLanguage('README.'), 'plaintext');
    assert.equal(fileLanguage(ROOT_PATH), 'plaintext');
  });

  test('reads an extension no grammar covers as plaintext', () => {
    // Monaco serves JSON as a worker-backed language service, which this
    // read-only view does not bundle.
    assert.equal(fileLanguage('package.json'), 'plaintext');
    assert.equal(fileLanguage('src/app.rb'), 'plaintext');
    assert.equal(fileLanguage('src/app.toml'), 'plaintext');
  });

  test('takes the extension of the file, not one of a directory in its path', () => {
    assert.equal(fileLanguage('docs.md/notes'), 'plaintext');
    assert.equal(fileLanguage('docs.md/notes.ts'), 'typescript');
  });

  test('names only the languages this surface registers a grammar for', () => {
    const extensions = [
      'bash',
      'cjs',
      'css',
      'cts',
      'htm',
      'html',
      'js',
      'jsx',
      'markdown',
      'md',
      'mjs',
      'mts',
      'py',
      'rs',
      'sh',
      'sql',
      'svg',
      'ts',
      'tsx',
      'xml',
      'yaml',
      'yml',
      'zsh',
    ];

    assert.deepEqual(
      [
        ...new Set(
          extensions.map((extension) => fileLanguage(`a.${extension}`)),
        ),
      ].sort(),
      [
        'css',
        'html',
        'javascript',
        'markdown',
        'python',
        'rust',
        'shell',
        'sql',
        'typescript',
        'xml',
        'yaml',
      ],
    );
  });
});

describe('what the surface says', () => {
  test('states that a truncated payload shows only its first part', () => {
    assert.equal(
      truncationNotice(true),
      'This file is larger than the read limit, so only its first part is shown.',
    );
    assert.equal(truncationNotice(false), undefined);
  });

  test('explains a sandbox the surface cannot read', () => {
    assert.equal(
      sandboxNotice('pending', 5),
      'The sandbox is still being prepared; the host suggests trying again in 5 seconds.',
    );
    assert.equal(
      sandboxNotice('pending'),
      'The sandbox is still being prepared.',
    );
    assert.match(sandboxNotice('expired'), /lease/);
    assert.match(sandboxNotice('unavailable'), /unavailable/);
    assert.match(sandboxNotice('missing'), /no sandbox yet/);
    assert.match(sandboxNotice('invalid_path'), /not inside the workspace/);
    assert.match(sandboxNotice('not_found'), /no longer in the workspace/);
  });

  test('says that an empty directory is empty', () => {
    assert.equal(emptyDirectoryNotice, 'This directory is empty.');
  });

  test('gives every change the letter its badge carries', () => {
    assert.deepEqual(
      (['added', 'modified', 'deleted', 'renamed', 'untracked'] as const).map(
        changeLetter,
      ),
      ['A', 'M', 'D', 'R', 'U'],
    );
  });
});

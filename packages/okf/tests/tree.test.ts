import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outputPath, parseDescription, renderTree } from '../src/lib/tree.js';

test('maps reserved names away at every depth without collisions', () => {
  assert.equal(outputPath('index'), 'index.md.md');

  assert.equal(outputPath('InDeX'), 'InDeX.md.md');

  assert.equal(outputPath('index.md'), 'index.md.md.md');

  assert.equal(outputPath('INDEX.md.md'), 'INDEX.md.md.md.md');

  assert.equal(outputPath('folder/index'), 'folder/index.md.md');

  assert.equal(outputPath('folder/index.md'), 'folder/index.md.md.md');

  assert.equal(outputPath('folder\\INDEX'), 'folder\\INDEX.md.md');

  assert.equal(outputPath('log'), 'log.md.md');

  assert.equal(outputPath('docs/log.md'), 'docs/log.md.md.md');

  assert.equal(outputPath('docs/log.md.md'), 'docs/log.md.md.md.md');

  assert.equal(outputPath('index.ts'), 'index.ts.md');
});

test('renders deterministic links to mirrored outputs without folder indexes', () => {
  const entries = [
    { path: 'src/z.ts', description: 'Zed.' },
    {
      path: 'README.md',
      description: '  Root\n readme\t summary. ',
    },
    { path: 'src/nested/a file.ts', description: 'Nested detail.' },
    { path: 'src/a.ts', description: 'Alpha.' },
    { path: 'index', description: 'Extensionless index.' },
    { path: 'index.md', description: 'Markdown index.' },
    { path: 'index.md.md', description: 'Chained index.' },
    { path: 'src/index', description: 'Nested index source.' },
    { path: 'src/log.md', description: 'Nested log source.' },
    { path: 'src/[guide](draft).md', description: 'Guide draft.' },
    { path: 'src/slash\\name.md', description: 'Slash name.' },
    { path: 'src/a.ts', description: 'Alpha.' },
  ];

  const expected = `# Project

- [README.md](README.md.md) - Root readme summary.
- [index](index.md.md) - Extensionless index.
- [index.md](index.md.md.md) - Markdown index.
- [index.md.md](index.md.md.md.md) - Chained index.
- src/
  - [src/\\[guide\\](draft).md](src/%5Bguide%5D%28draft%29.md.md) - Guide draft.
  - [src/a.ts](src/a.ts.md) - Alpha.
  - [src/index](src/index.md.md) - Nested index source.
  - [src/log.md](src/log.md.md.md) - Nested log source.
  - nested/
    - [src/nested/a file.ts](src/nested/a%20file.ts.md) - Nested detail.
  - [src/slash\\\\name.md](src/slash%5Cname.md.md) - Slash name.
  - [src/z.ts](src/z.ts.md) - Zed.
`;

  assert.equal(renderTree(entries), expected);

  assert.equal(renderTree([...entries].reverse()), expected);

  assert.doesNotMatch(renderTree(entries), /\]\(src\/nested\/index\.md\)/u);
});

test('parses a quoted YAML description from CRLF frontmatter', () => {
  const description = 'Explains "quoted" values at C:\\repo.\nSecond line.';

  const markdown = [
    '---',
    'type: "Reference"',
    'title: "Parser"',
    `description: ${JSON.stringify(description)}`,
    'resource: "source:src/parser.ts"',
    'tags: []',
    '---',
    '',
    '# Responsibility',
  ].join('\r\n');

  assert.equal(parseDescription(markdown), description);
});

test('parses Unicode line separators and normalizes them in rendered descriptions', () => {
  const description = 'First\u2028Second\u2029Third';

  const markdown = [
    '---',
    `description: ${JSON.stringify(description)}`,
    '---',
  ].join('\n');

  assert.equal(parseDescription(markdown), description);

  assert.equal(
    renderTree([{ path: 'unicode.ts', description }]),
    '# Project\n\n- [unicode.ts](unicode.ts.md) - First Second Third\n',
  );
});

test('escapes Markdown-active filename characters without changing path separators', () => {
  assert.equal(
    renderTree([
      {
        path: 'docs/`a*b_c<d>&e~f.md',
        description: 'Symbols.',
      },
    ]),
    [
      '# Project',
      '',
      '- docs/',
      '  - [docs/\\`a\\*b\\_c\\<d\\>\\&e\\~f.md](docs/%60a%2Ab_c%3Cd%3E%26e~f.md.md) - Symbols.',
      '',
    ].join('\n'),
  );
});

test('rejects missing and non-string YAML frontmatter descriptions', () => {
  assert.throws(
    () =>
      parseDescription(
        '---\ntype: "Reference"\n---\n\ndescription: "body only"',
      ),
    /missing description/u,
  );

  assert.throws(
    () => parseDescription('---\ndescription: 42\n---\n'),
    /description must be a string/u,
  );
});

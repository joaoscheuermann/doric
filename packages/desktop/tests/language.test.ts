import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fileLanguage } from 'desktop/ui/code';

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
    assert.equal(fileLanguage(''), 'plaintext');
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

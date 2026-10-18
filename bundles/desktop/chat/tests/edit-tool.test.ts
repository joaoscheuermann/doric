import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseDiffLines,
  parseEditCall,
  splitFilePath,
} from '../src/client/domain/edit-tool.js';

describe('edit tool domain parsing', () => {
  test('splits file paths into fileName and directory', () => {
    assert.deepEqual(splitFilePath('src/client/index.tsx'), {
      fileName: 'index.tsx',
      directory: 'src/client',
    });
    assert.deepEqual(splitFilePath('README.md'), {
      fileName: 'README.md',
    });
  });

  test('parses numbered diff lines produced by the edit tool', () => {
    const diff = [
      ' 9  const a = 1;',
      '10 -const b = 2;',
      '10 +const b = 3;',
      '11 +const c = 4;',
      '12  export { a, b };',
    ].join('\n');

    assert.deepEqual(parseDiffLines(diff), [
      { kind: 'context', lineNumber: 9, text: 'const a = 1;' },
      { kind: 'remove', lineNumber: 10, text: 'const b = 2;' },
      { kind: 'add', lineNumber: 10, text: 'const b = 3;' },
      { kind: 'add', lineNumber: 11, text: 'const c = 4;' },
      { kind: 'context', lineNumber: 12, text: 'export { a, b };' },
    ]);
  });

  test('computes preview lines and counts from input edits while running', () => {
    const parsed = parseEditCall(
      JSON.stringify({
        path: 'bundles/desktop/chat/src/index.ts',
        edits: [
          {
            oldText: 'const old = 1;',
            newText: 'const next = 2;\nconst extra = 3;',
          },
        ],
      }),
    );

    assert.equal(parsed.fileName, 'index.ts');
    assert.equal(parsed.directory, 'bundles/desktop/chat/src');
    assert.equal(parsed.added, 2);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.diffLines.length, 3);
  });

  test('parses a finished EditOutput record with diff and line counts', () => {
    const parsed = parseEditCall(
      JSON.stringify({
        path: 'src/parser.ts',
        edits: [{ oldText: 'foo', newText: 'bar' }],
      }),
      JSON.stringify({
        success: true,
        diff: ' 1  header\n 2 -foo\n 2 +bar\n 3 +baz',
        first_changed_line: 2,
      }),
    );

    assert.equal(parsed.success, true);
    assert.equal(parsed.fileName, 'parser.ts');
    assert.equal(parsed.firstChangedLine, 2);
    assert.equal(parsed.added, 2);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.diffLines.length, 4);
  });

  test('captures errors from failed EditOutput records', () => {
    const parsed = parseEditCall(
      JSON.stringify({
        path: 'src/parser.ts',
        edits: [{ oldText: 'missing', newText: 'bar' }],
      }),
      JSON.stringify({
        success: false,
        diff: '',
        error: 'Could not find the exact text in src/parser.ts.',
      }),
    );

    assert.equal(parsed.success, false);
    assert.equal(
      parsed.error,
      'Could not find the exact text in src/parser.ts.',
    );
  });

  test('parses write tool input content and WriteOutput summary diff', () => {
    const running = parseEditCall(
      JSON.stringify({
        path: 'src/new-file.ts',
        content: 'export const x = 1;\nexport const y = 2;\n',
      }),
    );
    assert.equal(running.fileName, 'new-file.ts');
    assert.equal(running.added, 2);
    assert.equal(running.removed, 0);
    assert.equal(running.diffLines.length, 2);

    const finished = parseEditCall(
      JSON.stringify({
        path: 'src/new-file.ts',
        content: 'export const x = 1;\nexport const y = 2;\n',
      }),
      JSON.stringify({
        success: true,
        bytes_written: 40,
        diff: 'Edited src/new-file.ts (+2 -0)\n1 +export const x = 1;\n2 +export const y = 2;',
      }),
    );
    assert.equal(finished.success, true);
    assert.equal(finished.added, 2);
    assert.equal(finished.removed, 0);
    assert.deepEqual(finished.diffLines, [
      { kind: 'add', lineNumber: 1, text: 'export const x = 1;' },
      { kind: 'add', lineNumber: 2, text: 'export const y = 2;' },
    ]);
  });
});

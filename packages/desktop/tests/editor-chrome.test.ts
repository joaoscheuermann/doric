/**
 * The read-only editors draw no chrome of their own beside the text: no box
 * around the current line, and no overview ruler or the border it draws at the
 * right edge (Figma `27:14162` diff body, `30:12640` file body). The code view
 * sets these options; the diff editor must set the same ones.
 *
 * Monaco needs a browser window and loads with a dynamic import, so the options
 * passed to `createDiffEditor` and `editor.create` are read from the sources.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const codeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
  'src/code',
);

/** The options literal passed to the first call of `call` in `file`. */
const optionsOf = (file: string, call: string): string => {
  const source = readFileSync(join(codeDir, file), 'utf8');
  const start = source.indexOf(`${call}(`);
  assert.notEqual(start, -1, `${file} does not call ${call}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open, index + 1);
  }
  assert.fail(`${file}: unterminated options for ${call}`);
};

const CHROME = [
  "renderLineHighlight: 'none'",
  'overviewRulerLanes: 0',
  'overviewRulerBorder: false',
  'hideCursorInOverviewRuler: true',
];

test('the code view draws no current-line box and no overview ruler', () => {
  const options = optionsOf('code-view.tsx', 'editor.create');
  for (const option of CHROME) {
    assert.ok(options.includes(option), `the code view lacks ${option}`);
  }
});

test('the diff editor draws no current-line box and no overview ruler', () => {
  const options = optionsOf('diff-editor.tsx', 'editor.createDiffEditor');
  for (const option of CHROME) {
    assert.ok(options.includes(option), `the diff editor lacks ${option}`);
  }
});

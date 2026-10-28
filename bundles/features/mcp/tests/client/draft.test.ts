// The stdio command line the server dialog edits: how a line splits into the
// command and its arguments (quoted as a POSIX shell quotes them, with no
// expansion), how stored words are written back as one line, and the refusal
// a line with an open quote gets.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkDraft,
  emptyDraft,
  formatCommandLine,
  parseCommandLine,
} from '../../src/client/draft.js';

const commandQuoteMessage =
  'Close the open quote, or end the line with a character after "\\".';

// ---------------------------------------------------------------------------
// parseCommandLine

test('parseCommandLine splits a plain line at whitespace', () => {
  assert.deepEqual(parseCommandLine('npx -y @mcp/files'), [
    'npx',
    '-y',
    '@mcp/files',
  ]);
  assert.deepEqual(parseCommandLine('  uvx  mcp-server-git '), [
    'uvx',
    'mcp-server-git',
  ]);
});

test('parseCommandLine keeps quoted spaces and quotes inside one word', () => {
  assert.deepEqual(parseCommandLine('node "My Server/index.js" --port 3000'), [
    'node',
    'My Server/index.js',
    '--port',
    '3000',
  ]);
  assert.deepEqual(parseCommandLine(`python -c 'print("hi")'`), [
    'python',
    '-c',
    'print("hi")',
  ]);
});

test('parseCommandLine reads escapes, joined parts and empty words', () => {
  assert.deepEqual(
    parseCommandLine(String.raw`echo it\'s --name="a b" "x\"y" ''`),
    ['echo', "it's", '--name=a b', 'x"y', ''],
  );
});

test('parseCommandLine expands nothing', () => {
  assert.deepEqual(parseCommandLine('echo $HOME'), ['echo', '$HOME']);
});

test('parseCommandLine refuses an open quote or a trailing backslash', () => {
  assert.equal(parseCommandLine('npx "@mcp/files'), undefined);
  assert.equal(parseCommandLine('npx foo\\'), undefined);
  assert.equal(parseCommandLine("npx 'foo"), undefined);
});

test('parseCommandLine answers no words for a blank line', () => {
  assert.deepEqual(parseCommandLine(''), []);
  assert.deepEqual(parseCommandLine('   '), []);
});

// ---------------------------------------------------------------------------
// formatCommandLine

test('formatCommandLine writes plain words bare', () => {
  assert.equal(
    formatCommandLine(['npx', '-y', '@mcp/files']),
    'npx -y @mcp/files',
  );
});

test('formatCommandLine quotes spaces, quotes and empty words', () => {
  assert.equal(
    formatCommandLine(['node', 'index.js', '--root', '/my files', "it's", '']),
    String.raw`node index.js --root '/my files' 'it'\''s' ''`,
  );
});

test('a formatted line parses back to the same words', () => {
  const lists: readonly (readonly string[])[] = [
    ['npx', '-y', '@mcp/files'],
    ['node', 'index.js', '--root', '/my files', "it's", ''],
    ['node', 'My Server/index.js', '--port', '3000'],
    ['python', '-c', 'print("hi")'],
    ['echo', "it's", '--name=a b', 'x"y', ''],
    ['echo', '$HOME'],
  ];

  for (const words of lists) {
    assert.deepEqual(parseCommandLine(formatCommandLine(words)), words);
  }
});

// ---------------------------------------------------------------------------
// checkDraft

test('checkDraft refuses a stdio command line with an open quote', () => {
  const check = checkDraft({
    ...emptyDraft,
    name: 'Files',
    kind: 'stdio',
    command: 'npx "x',
  });

  assert.equal(check.ok, false);
  assert.equal(
    check.ok ? undefined : check.errors.command,
    commandQuoteMessage,
  );
});

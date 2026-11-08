// The stdio command line the server dialog edits: how a line splits into the
// command and its arguments (quoted as a POSIX shell quotes them, with no
// expansion), how stored words are written back as one line, and the refusal
// a line with an open quote gets.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkDraft,
  draftOf,
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

test('checkDraft leaves a blank client name out and trims a typed one', () => {
  const http = {
    ...emptyDraft,
    name: 'Figma',
    url: 'https://mcp.example.com/mcp',
  };
  const blank = checkDraft({ ...http, clientName: '   ' });
  const typed = checkDraft({ ...http, clientName: '  Claude Code ' });

  assert.deepEqual(blank.ok ? blank.input.transport : undefined, {
    kind: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: [],
  });
  assert.equal(
    typed.ok && typed.input.transport.kind === 'http'
      ? typed.input.transport.clientName
      : undefined,
    'Claude Code',
  );
});

test('checkDraft refuses a client name over 128 characters', () => {
  const check = checkDraft({
    ...emptyDraft,
    name: 'Figma',
    url: 'https://mcp.example.com/mcp',
    clientName: 'x'.repeat(129),
  });

  assert.equal(check.ok, false);
  assert.equal(
    check.ok ? undefined : check.errors.clientName,
    'Enter a client name of up to 128 characters.',
  );
});

test('a stored client name, scopes and client info open in the draft and save back unchanged', () => {
  const input = {
    name: 'Figma',
    enabled: true,
    transport: {
      kind: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [],
      clientName: 'Claude Code',
      scopes: ['files:read', 'files:write'],
      clientInfo: { name: 'claude-code', version: '2.1.0' },
    },
  } as const;
  const check = checkDraft(draftOf(input));

  assert.deepEqual(check.ok ? check.input : undefined, input);
});

test('checkDraft splits scopes at whitespace and leaves blank ones out', () => {
  const http = {
    ...emptyDraft,
    name: 'Figma',
    url: 'https://mcp.example.com/mcp',
  };
  const blank = checkDraft({ ...http, scopes: '  ' });
  const typed = checkDraft({ ...http, scopes: ' files:read\n  files:write ' });

  assert.equal(
    blank.ok && blank.input.transport.kind === 'http'
      ? 'scopes' in blank.input.transport
      : undefined,
    false,
  );
  assert.deepEqual(
    typed.ok && typed.input.transport.kind === 'http'
      ? typed.input.transport.scopes
      : undefined,
    ['files:read', 'files:write'],
  );
});

test('checkDraft refuses a scope with a quote on the scopes field alone', () => {
  const check = checkDraft({
    ...emptyDraft,
    name: 'Figma',
    url: 'https://mcp.example.com/mcp',
    headers: [{ key: 'h1', name: 'X-Team', value: 'design' }],
    scopes: 'files:read "admin"',
  });

  assert.equal(check.ok, false);
  assert.equal(
    check.ok ? undefined : check.errors.scopes,
    'Separate scopes with spaces; a scope is printable ASCII other than " and \\.',
  );
  assert.equal(check.ok ? undefined : check.errors.entries, undefined);
});

test('checkDraft keeps the client info fields typed, on either transport', () => {
  const http = checkDraft({
    ...emptyDraft,
    name: 'Figma',
    url: 'https://mcp.example.com/mcp',
    clientInfoName: ' claude-code ',
    clientInfoVersion: '  ',
  });
  const stdio = checkDraft({
    ...emptyDraft,
    name: 'files',
    kind: 'stdio',
    command: 'files-mcp',
    clientInfoVersion: '2.1.0',
  });
  const blank = checkDraft({
    ...emptyDraft,
    name: 'files',
    kind: 'stdio',
    command: 'files-mcp',
    clientInfoName: ' ',
  });

  assert.deepEqual(http.ok ? http.input.transport.clientInfo : undefined, {
    name: 'claude-code',
  });
  assert.deepEqual(stdio.ok ? stdio.input.transport.clientInfo : undefined, {
    version: '2.1.0',
  });
  assert.equal(
    blank.ok ? 'clientInfo' in blank.input.transport : undefined,
    false,
  );
});

test('checkDraft refuses a client version over 64 characters', () => {
  const check = checkDraft({
    ...emptyDraft,
    name: 'files',
    kind: 'stdio',
    command: 'files-mcp',
    clientInfoVersion: '1'.repeat(65),
  });

  assert.equal(check.ok, false);
  assert.equal(
    check.ok ? undefined : check.errors.clientInfoVersion,
    'Enter a client version of up to 64 characters.',
  );
});

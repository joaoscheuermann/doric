/**
 * `desktop-ui/code` is imported by every window that can open a file or diff
 * tab, but Monaco is loaded only when the first editor mounts: importing the
 * subpath must not evaluate the editor, which needs a browser window.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('importing the code subpath does not load Monaco', async () => {
  assert.equal('MonacoEnvironment' in globalThis, false);
  const code = await import('desktop-ui/code');
  assert.equal(typeof code.CodeView, 'function');
  assert.equal(typeof code.DiffEditor, 'function');
  assert.equal('MonacoEnvironment' in globalThis, false);
});

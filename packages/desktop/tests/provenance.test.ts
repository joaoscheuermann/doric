/**
 * The vendored components are shadcn's own files — the renderer's, or the
 * CLI's Base UI output: only the import rewrites and the local patches
 * PROVENANCE.md lists separate them.
 */
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface Verifier {
  readonly verify: (root?: string) => readonly string[];
}

const { verify } = (await import(
  join(packageRoot, 'scripts/verify-provenance.mjs')
)) as Verifier;

/** A scratch copy of the package's sources, removed after `use`. */
const withCopy = (use: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-provenance-'));
  try {
    cpSync(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    use(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe('provenance', () => {
  test('every vendored file is the shadcn file it came from', () => {
    assert.deepEqual(verify(), []);
  });

  test('an edit beyond the recorded patches is reported', () => {
    withCopy((root) => {
      const file = join(root, 'src/components/button.tsx');
      writeFileSync(file, `// local change\n${readFileSync(file, 'utf8')}`);
      assert.equal(verify(root).length, 1);
      assert.match(verify(root)[0] ?? '', /^components\/button\.tsx: differs/);
    });
  });

  test("a CLI file's leading 'use client' directive is not a difference", () => {
    withCopy((root) => {
      const file = join(root, 'src/components/popover.tsx');
      writeFileSync(file, `'use client';\n\n${readFileSync(file, 'utf8')}`);
      assert.deepEqual(verify(root), []);
    });
  });

  test('a component the record does not list is reported', () => {
    withCopy((root) => {
      writeFileSync(join(root, 'src/components/calendar.tsx'), 'export {};\n');
      assert.deepEqual(verify(root), [
        'components/calendar.tsx: not in the provenance record',
      ]);
    });
  });
});

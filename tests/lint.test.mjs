import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const biome = join(root, 'node_modules', '.bin', 'biome');

const run = ({ source, directory, extension, command = 'lint', args = [] }) => {
  // Some fixture directories are generated (e.g. the Prisma client output) and
  // do not exist in a fresh checkout, so the test creates what it needs.
  mkdirSync(join(root, directory), { recursive: true });
  const fixture = mkdtempSync(join(root, directory, 'biome-fixture-'));
  const file = join(fixture, `example.${extension}`);

  try {
    writeFileSync(file, source);
    const result = spawnSync(
      biome,
      [command, file, ...args, '--reporter=json'],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.error) throw result.error;

    return {
      status: result.status,
      diagnostics: JSON.parse(result.stdout).diagnostics.map(
        ({ category }) => category,
      ),
      output: readFileSync(file, 'utf8'),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

test('reports undeclared names in JavaScript tooling', () => {
  const result = run({
    source: 'missingFunction();\n',
    directory: 'tests',
    extension: 'mjs',
  });

  assert.equal(result.status, 1);
  assert.ok(
    result.diagnostics.includes('lint/correctness/noUndeclaredVariables'),
  );
});

test('reports unhandled promises in production and test TypeScript', () => {
  for (const directory of [
    'packages/session/src/lib',
    'packages/agent/tests',
  ]) {
    const result = run({
      source: 'export function start() { Promise.resolve(1); }\n',
      directory,
      extension: 'ts',
    });

    assert.equal(result.status, 1, directory);
    assert.ok(result.diagnostics.includes('lint/nursery/noFloatingPromises'));
  }
});

test('enforces shorthand array types', () => {
  const result = run({
    source: 'export const values: Array<string> = [];\n',
    directory: 'packages/session/src/lib',
    extension: 'ts',
  });

  assert.ok(result.diagnostics.includes('lint/style/useConsistentArrayType'));
});

test('requires await in production async functions while allowing test doubles', () => {
  const source = 'export async function fixture() { return 1; }\n';
  const production = run({
    source,
    directory: 'packages/session/src/lib',
    extension: 'ts',
  });
  const fixture = run({
    source,
    directory: 'packages/agent/tests',
    extension: 'ts',
  });

  assert.ok(production.diagnostics.includes('lint/suspicious/useAwait'));
  assert.equal(fixture.status, 0);
});

test('allows unused underscore parameters but reports forgotten values', () => {
  const result = run({
    source:
      'export function fixture(_unused: string) { const forgotten = 1; return 2; }\n',
    directory: 'packages/session/src/lib',
    extension: 'ts',
  });

  assert.equal(
    result.diagnostics.filter(
      (category) => category === 'lint/correctness/noUnusedVariables',
    ).length,
    1,
  );
});

test('reports unsorted imports', () => {
  const result = run({
    source:
      "import path from 'node:path';\nimport fs from 'node:fs';\nconsole.log(path, fs);\n",
    directory: 'tests',
    extension: 'mjs',
    command: 'check',
    args: ['--formatter-enabled=false'],
  });

  assert.ok(result.diagnostics.includes('assist/source/organizeImports'));
});

test('formats JavaScript with single quotes and semicolons', () => {
  const result = run({
    source: 'const value = "text"\nconsole.log(value)\n',
    directory: 'tests',
    extension: 'mjs',
    command: 'format',
    args: ['--write'],
  });

  assert.equal(result.status, 0);
  assert.equal(result.output, "const value = 'text';\nconsole.log(value);\n");
});

test('ignores generated source', () => {
  const result = run({
    source: 'missingFunction();\n',
    directory: 'agents/doric/src/generated',
    extension: 'ts',
    args: ['--no-errors-on-unmatched'],
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.diagnostics, []);
});

const workspacePackageNames = () => {
  const names = new Set();

  for (const parent of ['packages', 'agents', 'tools', 'bundles']) {
    for (const entry of readdirSync(join(root, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;

      try {
        const manifest = JSON.parse(
          readFileSync(join(root, parent, entry.name, 'package.json'), 'utf8'),
        );

        if (typeof manifest.name === 'string') names.add(manifest.name);
      } catch {
        // A directory without a readable manifest is not a workspace package.
      }
    }
  }

  return [...names];
};

const sourceFiles = (directory) => {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('dist')) {
      continue;
    }

    const path = join(directory, entry.name);

    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
};

const importedModules = (source) => {
  const specifiers = [];

  for (const match of source.matchAll(
    /(?:from|require\()\s*['"]([^'"]+)['"]/gu,
  )) {
    specifiers.push(match[1]);
  }

  for (const match of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gmu)) {
    specifiers.push(match[1]);
  }

  return specifiers;
};

test('keeps cross-package imports on public entrypoints', () => {
  const names = workspacePackageNames();
  const offenders = [];

  for (const parent of ['packages', 'agents', 'app', 'tools', 'bundles']) {
    for (const file of sourceFiles(join(root, parent))) {
      for (const specifier of importedModules(readFileSync(file, 'utf8'))) {
        if (names.some((name) => specifier.startsWith(`${name}/src/`))) {
          offenders.push(
            `${file.slice(root.length + 1)} imports "${specifier}"`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Import a workspace package through its public entrypoint, not its source path:\n${offenders.join('\n')}`,
  );
});

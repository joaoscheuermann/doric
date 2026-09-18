import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

const lint = new ESLint({
  fix: true,
  overrideConfig: { rules: { 'no-unused-vars': 'off' } },
});

async function verify(input, expected) {
  const options = { filePath: 'spacing-example.mjs' };
  const [result] = await lint.lintText(input, options);

  assert.equal(result.output ?? input, expected);

  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));

  const [again] = await lint.lintText(expected, options);

  assert.equal(again.output, undefined);
}

test('groups short declarations and separates declarations with at least three lines', async () => {
  await verify('const a = 1;\n\nlet b = 2;\n', 'const a = 1;\nlet b = 2;\n');

  await verify(
    'const a = 1;\n\nconst b =\n  2;\n',
    'const a = 1;\nconst b =\n  2;\n',
  );

  await verify(
    'const a = 1;\nconst b = {\n  value: 2,\n};\n',
    'const a = 1;\n\nconst b = {\n  value: 2,\n};\n',
  );

  await verify(
    'export const a = 1;\nexport const b = [\n  2,\n];\n',
    'export const a = 1;\n\nexport const b = [\n  2,\n];\n',
  );
});

test('separates consecutive function definitions while grouping callback results', async () => {
  const definitions = [
    (name) => `function ${name}() { return 1; }`,
    (name) => `const ${name} = () => 1;`,
    (name) => `let ${name} = function () { return 1; };`,
    (name) => `var ${name} = async () => 1;`,
    (name) => `export const ${name} = () => 1;`,
  ];

  for (const previous of definitions) {
    for (const next of definitions) {
      await verify(
        `${previous('a')}\n${next('b')}\n`,
        `${previous('a')}\n\n${next('b')}\n`,
      );
    }
  }

  await verify(
    'const a = [1].map(() => 2);\n\nconst b = 3;\n',
    'const a = [1].map(() => 2);\nconst b = 3;\n',
  );
});

test('preserves comments, indentation, and statement boundaries', async () => {
  await verify(
    'const a = 1;\n// About b.\nconst b = {\n  value: 2,\n};\n',
    'const a = 1;\n\n// About b.\nconst b = {\n  value: 2,\n};\n',
  );

  await verify(
    'function run() {\n  const a = 1;\n\n  // About b.\n\n  const b = 2;\n}\n',
    'function run() {\n  const a = 1;\n  // About b.\n  const b = 2;\n}\n',
  );

  await verify(
    'const a = 1;\nconst b = 2;\nconsole.log(a, b);\n',
    'const a = 1;\nconst b = 2;\n\nconsole.log(a, b);\n',
  );

  await verify(
    'for (let i = 0; i < 2; i++) {\n  console.log(i);\n}\n',
    'for (let i = 0; i < 2; i++) {\n  console.log(i);\n}\n',
  );
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import { loadBundles, SkillSchema } from '../src/index.js';

type ToolEntry = { readonly path: string; readonly alwaysAvailable: boolean };

type SkillEntry = { readonly path: string; readonly alwaysAvailable: boolean };

const skill = (name: string, allowedTools: readonly string[] = []) => `---
name: ${name}
description: ${name} description
allowed-tools: [${allowedTools.join(', ')}]
---

# ${name}

Follow this procedure.
`;

const createRoot = () => mkdtemp(join(tmpdir(), 'bundle-test-'));

test('exports a JSON-Schema-compatible skill schema', () => {
  const value = {
    name: 'example',
    description: 'Example skill.',
    body: 'Follow the procedure.',
    allowedTools: ['read'],
  };

  assert.deepEqual(SkillSchema.parse(value), {
    ...value,
    indexText: 'example | Example skill. | read | Follow the procedure.',
  });

  assert.equal(z.toJSONSchema(SkillSchema).type, 'object');

  assert.deepEqual(z.toJSONSchema(SkillSchema, { io: 'input' }).required, [
    'name',
    'description',
    'body',
    'allowedTools',
  ]);
});

test('normalizes canonical skill records and ignores supplied index text', () => {
  assert.deepEqual(
    SkillSchema.parse({
      name: '  example  ',
      description: '  Example skill.  ',
      body: '  Follow the procedure.  ',
      allowedTools: [' read ', 'write', 'read'],
      indexText: 'untrusted',
    }),
    {
      name: 'example',
      description: 'Example skill.',
      body: 'Follow the procedure.',
      allowedTools: ['read', 'write'],
      indexText:
        'example | Example skill. | read,write | Follow the procedure.',
    },
  );

  assert.throws(() =>
    SkillSchema.parse({
      name: 'example',
      description: 'Example skill.',
      body: 'Follow the procedure.',
      allowedTools: [],
      extra: true,
    }),
  );
});

const createBundle = async (
  root: string,
  directory: string,
  options: {
    readonly name?: string;
    readonly tools?: readonly ToolEntry[];
    readonly skills?: readonly SkillEntry[];
  } = {},
) => {
  const path = join(root, directory);

  await Promise.all([
    mkdir(join(path, 'tools'), { recursive: true }),
    mkdir(join(path, 'skills'), { recursive: true }),
  ]);

  await writeFile(
    join(path, 'manifest.json'),
    JSON.stringify({
      name: options.name ?? directory,
      description: `${directory} description`,
      tools: options.tools ?? [],
      skills: options.skills ?? [],
    }),
  );

  return path;
};

const writeTool = async (bundle: string, file: string, name: string) =>
  writeFile(
    join(bundle, 'tools', file),
    `const definition = { name: ${JSON.stringify(name)}, inputSchema: {}, outputSchema: {} };
    const factory = () => ({
      name: ${JSON.stringify(name)}, input: {}, output: {}, definition,
      execute: async (payload) => payload
    });
    Object.defineProperties(factory, {
      name: { value: ${JSON.stringify(name)} },
      input: { value: {} },
      output: { value: {} },
      definition: { value: definition }
    });
    export default factory;`,
  );

test('preserves lexical bundle order and manifest resource order', async () => {
  const root = await createRoot();

  try {
    await createBundle(root, 'z');

    await createBundle(root, 'a');

    assert.deepEqual(
      (await loadBundles(root)).map(({ name }) => name),
      ['a', 'z'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads executable tools, availability flags, and skill frontmatter', async () => {
  const root = await createRoot();

  try {
    const bundle = await createBundle(root, 'core', {
      tools: [{ path: 'tools/example.js', alwaysAvailable: true }],
      skills: [{ path: 'skills/example/SKILL.md', alwaysAvailable: false }],
    });

    await writeTool(bundle, 'example.js', 'example');

    await mkdir(join(bundle, 'skills', 'example'));

    await writeFile(
      join(bundle, 'skills', 'example', 'SKILL.md'),
      skill('example-skill', ['example']),
    );

    const [loaded] = await loadBundles(root);

    assert.equal(loaded?.tools[0]?.alwaysAvailable, true);

    const factory = loaded?.tools[0]?.factory;

    assert.equal(factory?.name, 'example');

    assert.equal(loaded?.skills[0]?.alwaysAvailable, false);

    assert.deepEqual(loaded?.skills[0]?.skill.allowedTools, ['example']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads missing allowed-tools as an empty array', async () => {
  const root = await createRoot();

  try {
    const bundle = await createBundle(root, 'core', {
      skills: [{ path: 'skills/example/SKILL.md', alwaysAvailable: false }],
    });

    await mkdir(join(bundle, 'skills', 'example'));

    await writeFile(
      join(bundle, 'skills', 'example', 'SKILL.md'),
      `---
name: example
description: Example description
---

# Example

Follow this procedure.
`,
    );

    const [loaded] = await loadBundles(root);
    const allowedTools = loaded?.skills[0]?.skill.allowedTools;

    assert.ok(allowedTools);

    assert.equal(Array.isArray(allowedTools), true);

    assert.equal(allowedTools.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads the same canonical skill record exposed by SkillSchema', async () => {
  const root = await createRoot();

  try {
    const bundle = await createBundle(root, 'core', {
      tools: [{ path: 'tools/read.js', alwaysAvailable: false }],
      skills: [{ path: 'skills/example/SKILL.md', alwaysAvailable: false }],
    });

    await writeTool(bundle, 'read.js', 'read');

    await mkdir(join(bundle, 'skills', 'example'));

    await writeFile(
      join(bundle, 'skills', 'example', 'SKILL.md'),
      `---
name: "  example  "
description: "  Example description  "
allowed-tools: [" read ", read]
indexText: untrusted
---

  Follow this procedure.${'  '}
`,
    );

    const [loaded] = await loadBundles(root);

    assert.deepEqual(loaded?.skills[0]?.skill, {
      name: 'example',
      description: 'Example description',
      body: 'Follow this procedure.',
      allowedTools: ['read'],
      indexText:
        'example | Example description | read | Follow this procedure.',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid manifests, undeclared-compatible paths, and missing files contextually', async () => {
  const root = await createRoot();

  try {
    const bundle = await createBundle(root, 'core');

    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        name: 'core',
        description: 'x',
        tools: [{ path: '../escape.js', alwaysAvailable: false }],
        skills: [],
      }),
    );

    await assert.rejects(loadBundles(root), /manifest/i);

    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        name: 'core',
        description: 'x',
        tools: [{ path: 'tools/missing.js', alwaysAvailable: false }],
        skills: [],
      }),
    );

    await assert.rejects(
      loadBundles(root),
      (error: unknown) =>
        error instanceof Error && error.cause instanceof Error,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects incompatible exports and unresolved local tool references', async () => {
  const root = await createRoot();

  try {
    const bundle = await createBundle(root, 'core', {
      tools: [{ path: 'tools/bad.js', alwaysAvailable: false }],
    });

    await writeFile(join(bundle, 'tools', 'bad.js'), 'export default {};');

    await assert.rejects(loadBundles(root), (error: unknown) => {
      assert.ok(error instanceof Error);

      assert.match(error.message, /Unable to load tool/);

      assert.ok(error.cause instanceof Error);

      assert.match(error.cause.message, /compatible Tool/);

      return true;
    });

    await writeTool(bundle, 'available.js', 'available');

    await mkdir(join(bundle, 'skills', 'dependent'));

    await writeFile(
      join(bundle, 'skills', 'dependent', 'SKILL.md'),
      skill('dependent', ['missing']),
    );

    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        name: 'core',
        description: 'x',
        tools: [{ path: 'tools/available.js', alwaysAvailable: false }],
        skills: [{ path: 'skills/dependent/SKILL.md', alwaysAvailable: false }],
      }),
    );

    await assert.rejects(loadBundles(root), /unavailable tool "missing"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects globally duplicated bundle, skill, and tool names', async () => {
  const scenarios = ['bundle', 'skill', 'tool'] as const;

  for (const scenario of scenarios) {
    const root = await createRoot();

    try {
      for (const directory of ['a', 'b']) {
        const bundle = await createBundle(root, directory, {
          name: scenario === 'bundle' ? 'duplicate' : directory,
          tools:
            scenario === 'tool'
              ? [{ path: 'tools/shared.js', alwaysAvailable: false }]
              : [],
          skills:
            scenario === 'skill'
              ? [{ path: 'skills/shared/SKILL.md', alwaysAvailable: false }]
              : [],
        });

        if (scenario === 'tool') {
          await writeTool(bundle, 'shared.js', 'shared');
        }

        if (scenario === 'skill') {
          await mkdir(join(bundle, 'skills', 'shared'));

          await writeFile(
            join(bundle, 'skills', 'shared', 'SKILL.md'),
            skill('shared'),
          );
        }
      }

      await assert.rejects(
        loadBundles(root),
        new RegExp(`Duplicate ${scenario} name`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { parseDocument } from 'yaml';

import {
  defaultOutput,
  generate,
  isOkfError,
  OkfError,
  type Progress,
  type ProgressEvent,
} from '../src/index.js';
import { createProvider } from './fakes.js';

const tempRoot = async (context: TestContext): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'okf-generate-'));

  context.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
};

const conceptPath = (root: string, source: string): string =>
  path.join(defaultOutput(root), `${source}.md`);

const okfFailure = (
  error: unknown,
  code: string,
  stage: string,
  source?: string,
  privateValue?: string,
): boolean => {
  assert.ok(error instanceof OkfError);

  assert.equal(isOkfError(error), true);

  assert.equal(error.code, code);

  assert.equal(error.stage, stage);

  assert.equal(error.source, source);

  assert.equal((error as Error & { cause?: unknown }).cause, undefined);

  if (privateValue !== undefined) {
    assert.doesNotMatch(
      JSON.stringify({
        message: error.message,
        stack: error.stack,
        hint: error.hint,
        cause: (error as Error & { cause?: unknown }).cause,
      }),
      new RegExp(privateValue, 'u'),
    );
  }

  return true;
};

test('generates one deterministic YAML concept through the public API', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'README.md'), '# Example\n', 'utf-8');

  const fake = createProvider();

  const result = await generate(
    { provider: fake.provider, model: 'fake' },
    root,
  );

  assert.equal(result.output, defaultOutput(root));

  assert.deepEqual(result.files, ['README.md']);

  assert.equal(result.generated, 1);

  assert.equal(result.cached, 0);

  assert.equal(fake.requests.length, 3);

  const concept = await fs.readFile(conceptPath(root, 'README.md'), 'utf-8');
  const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(concept)?.[1] ?? '';
  const metadata = parseDocument(frontmatter).toJS() as Record<string, unknown>;

  assert.equal(metadata.id, 'README.md');

  assert.equal(metadata.title, 'README');

  assert.equal(metadata.type, 'md');

  assert.equal(metadata.resource, 'source:README.md');

  assert.deepEqual(metadata.tags, ['documentation']);

  assert.equal(typeof metadata.hash, 'string');

  assert.equal(typeof metadata.timestamp, 'string');

  assert.equal(metadata.imports, undefined);

  assert.equal(metadata.exports, undefined);

  assert.doesNotMatch(concept, /reasoning|RATIONALE_PRIVATE/u);

  assert.match(concept, /# Subject/u);

  assert.match(
    await fs.readFile(result.index, 'utf-8'),
    /\[README\.md\]\(README\.md\.md\) - Documents repository behavior\./u,
  );
});

test('uses a contained custom output and rejects other locations', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.txt'), 'Guide', 'utf-8');

  const custom = path.join(root, '.agents', 'bundles', 'custom');
  const fake = createProvider();

  assert.equal(
    (await generate({ provider: fake.provider, model: 'fake' }, root, custom))
      .output,
    custom,
  );

  await assert.rejects(
    generate(
      { provider: fake.provider, model: 'fake' },
      root,
      path.join(root, 'outside'),
    ),
    /must stay inside/u,
  );
});

test('rejects an output that escapes through an existing junction', async (context) => {
  const root = await tempRoot(context);
  const outside = await tempRoot(context);
  const bundles = path.join(root, '.agents', 'bundles');

  await fs.mkdir(bundles, { recursive: true });

  await fs.symlink(outside, path.join(bundles, 'escape'), 'junction');

  const fake = createProvider();

  await assert.rejects(
    generate(
      { provider: fake.provider, model: 'fake' },
      root,
      path.join(bundles, 'escape', 'project'),
    ),
    /must stay inside/u,
  );

  assert.equal(fake.requests.length, 0);
});

test('uses parsed exact recipe hashes for cache hits', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf-8');

  const fake = createProvider();
  const config = { provider: fake.provider, model: 'fake' };

  await generate(config, root);

  const cached = await generate(config, root);

  assert.equal(cached.generated, 0);

  assert.equal(cached.cached, 1);

  assert.equal(fake.requests.length, 3);

  const file = conceptPath(root, 'guide.md');
  const existing = await fs.readFile(file, 'utf-8');

  await fs.writeFile(
    file,
    existing.replace(/^(hash: .*?)$/mu, '$1-suffix'),
    'utf-8',
  );

  const regenerated = await generate(config, root);

  assert.equal(regenerated.generated, 1);

  assert.equal(fake.requests.length, 6);
});

test('sends exact raw content in one collision-safe Markdown request', async (context) => {
  const root = await tempRoot(context);
  const content =
    '{"pattern":"/secret\\d+/gi","value":7}\r\n```\r\n~~~~~~~~\r\n';

  await fs.writeFile(path.join(root, 'evidence.jsonc'), content, 'utf-8');

  const fake = createProvider();

  await generate({ provider: fake.provider, model: 'fake' }, root);

  assert.equal(fake.requests.length, 3);

  const request = fake.requests[0];

  assert.equal(request?.temperature, 0);

  const input = request?.messages.find(({ role }) => role === 'user')?.content;

  assert.equal(typeof input, 'string');

  assert.match(input as string, /## Path\n\n```text\nevidence\.jsonc\n```/u);

  assert.match(input as string, /## Type\n\n```text\njsonc\n```/u);

  assert.doesNotMatch(input as string, /## Module Interface/u);

  assert.ok((input as string).includes(content));

  assert.ok((input as string).includes('/secret\\d+/gi'));

  assert.match(
    input as string,
    /## Content\n\nUTF-8 bytes: 54\n\nTerminal newline: yes\n\n(?:`{4,}|~{9,})text/u,
  );
});

test('uses a JSON fence for valid JSON evidence', async (context) => {
  const root = await tempRoot(context);
  const content = '{"enabled":true}\n';

  await fs.writeFile(path.join(root, 'config.json'), content, 'utf-8');

  const fake = createProvider();

  await generate({ provider: fake.provider, model: 'fake' }, root);

  const input = fake.requests[0]?.messages.find(
    ({ role }) => role === 'user',
  )?.content;

  assert.equal(typeof input, 'string');

  assert.match(
    input as string,
    /## Content[\s\S]*```json\n\{"enabled":true\}\n```/u,
  );
});

test('replaces provider errors that contain private rationales', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n', 'utf-8');

  const sentinel = 'RATIONALE_PROVIDER_PRIVATE';

  const fake = createProvider(() => {
    throw new Error(`Provider leaked ${sentinel}.`, {
      cause: new Error(sentinel),
    });
  });

  await assert.rejects(
    generate({ provider: fake.provider, model: 'fake' }, root),
    (error: unknown) => {
      assert.ok(error instanceof Error);

      const exposed = JSON.stringify({
        message: error.message,
        stack: error.stack,
        cause: (error as Error & { readonly cause?: unknown }).cause,
        properties: Object.fromEntries(
          Object.getOwnPropertyNames(error).map((name) => [
            name,
            String((error as unknown as Record<string, unknown>)[name]),
          ]),
        ),
      });

      assert.doesNotMatch(exposed, new RegExp(sentinel, 'u'));

      assert.equal(
        (error as Error & { readonly cause?: unknown }).cause,
        undefined,
      );

      return /valid source summary for guide\.md/u.test(error.message);
    },
  );
});

test('rejects supported syntax errors before requesting or writing', async (context) => {
  const cases = [
    ['broken.ts', 'export const = 1;'],
    ['broken.js', 'const = ;'],
    ['broken.json', '{]'],
  ] as const;

  for (const [name, body] of cases) {
    const root = await tempRoot(context);

    await fs.writeFile(path.join(root, name), body, 'utf-8');

    const fake = createProvider();

    await assert.rejects(
      generate({ provider: fake.provider, model: 'fake' }, root),
      new RegExp(
        `Supported source syntax is invalid for ${name.replace('.', '\\.')}`,
        'u',
      ),
    );

    assert.equal(fake.requests.length, 0);

    await assert.rejects(fs.access(conceptPath(root, name)));
  }
});

test('treats JSONC and JSON5 as unsupported ordinary text', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    fs.writeFile(
      path.join(root, 'config.jsonc'),
      '{ // comment\n value: 1 }',
      'utf-8',
    ),
    fs.writeFile(path.join(root, 'config.json5'), "{'value': 1,}", 'utf-8'),
  ]);

  const fake = createProvider();

  const result = await generate(
    { provider: fake.provider, model: 'fake' },
    root,
  );

  assert.equal(result.generated, 2);

  assert.equal(fake.requests.length, 6);
});

test('invalidates cache after relationships model effort or source change', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(
    path.join(root, 'main.ts'),
    "import './dep';\nexport const main = 1;",
    'utf-8',
  );

  const fake = createProvider();

  await generate(
    { provider: fake.provider, model: 'one', effort: 'low' },
    root,
  );

  await generate(
    { provider: fake.provider, model: 'two', effort: 'low' },
    root,
  );

  await generate(
    { provider: fake.provider, model: 'two', effort: 'high' },
    root,
  );

  await fs.writeFile(
    path.join(root, 'dep.ts'),
    'export const dep = 1;',
    'utf-8',
  );

  await generate(
    { provider: fake.provider, model: 'two', effort: 'high' },
    root,
  );

  await fs.writeFile(
    path.join(root, 'main.ts'),
    "import './dep';\nexport const main = 2;",
    'utf-8',
  );

  await generate(
    { provider: fake.provider, model: 'two', effort: 'high' },
    root,
  );

  assert.equal(fake.requests.length, 18);

  const main = await fs.readFile(conceptPath(root, 'main.ts'), 'utf-8');

  assert.match(main, /target: "dep\.ts"/u);
});

test('rejects invalid or missing prompt targets before provider calls', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.md'), '# Guide', 'utf-8');

  const fake = createProvider();

  await assert.rejects(
    generate(
      { provider: fake.provider, model: 'fake', promptTarget: 'missing' },
      root,
    ),
    /Could not load the OKF prompts for the selected target/u,
  );

  await assert.rejects(
    generate(
      { provider: fake.provider, model: 'fake', promptTarget: 'con' },
      root,
    ),
    /Could not load the OKF prompts for the selected target/u,
  );

  assert.equal(fake.requests.length, 0);
});

test('skips NUL and invalid UTF-8 binary content', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    fs.writeFile(path.join(root, 'nul.bin'), Buffer.from([65, 0, 66])),
    fs.writeFile(path.join(root, 'invalid.bin'), Buffer.from([0xff, 0xfe])),
  ]);

  const fake = createProvider();

  const result = await generate(
    { provider: fake.provider, model: 'fake' },
    root,
  );

  assert.deepEqual(result.files, []);

  assert.equal(fake.requests.length, 0);

  assert.equal(await fs.readFile(result.index, 'utf-8'), '# Project\n\n');
});

test('builds a concept with three isolated schema-less calls', async (context) => {
  const root = await tempRoot(context);
  const content = 'export const PRIVATE_SOURCE_SENTINEL = 7;\n';
  const summary =
    '# Module Summary\n\nExports one constant for repository consumers.';

  await fs.writeFile(path.join(root, 'private.ts'), content, 'utf-8');

  const events: ProgressEvent[] = [];

  const fake = createProvider((_system, input, index, request) => {
    assert.equal(request.schema, undefined);

    assert.equal(request.temperature, 0);

    assert.equal(request.flags?.sensitiveOutput, true);

    assert.equal(
      request.flags?.includeStructuredSchemaOnSystemPrompt,
      undefined,
    );

    assert.equal(request.tools, undefined);

    if (index === 0) {
      assert.ok(input.includes(content));

      return summary;
    }

    assert.ok(input.includes(summary));

    assert.doesNotMatch(input, /private\.ts|PRIVATE_SOURCE_SENTINEL/u);

    return index === 1
      ? 'Exports one repository constant.'
      : 'source-code\ntypescript';
  });

  await generate(
    {
      provider: fake.provider,
      model: 'fake',
      progress: (event) => events.push(event),
    },
    root,
  );

  assert.equal(fake.requests.length, 3);

  assert.deepEqual(
    events
      .filter(({ event }) =>
        /okf\.file\.(?:summary|description|tags)\./u.test(event),
      )
      .map(({ event }) => event),
    [
      'okf.file.summary.start',
      'okf.file.summary.complete',
      'okf.file.description.start',
      'okf.file.description.complete',
      'okf.file.tags.start',
      'okf.file.tags.complete',
    ],
  );

  const concept = await fs.readFile(conceptPath(root, 'private.ts'), 'utf-8');

  assert.match(concept, /description: "Exports one repository constant\."/u);

  assert.match(concept, /tags: \[ "source-code", "typescript" \]/u);

  assert.match(concept, /# Module Summary/u);
});

test('retains permissive plain-text tags with only structural trimming', async (context) => {
  const cases = [
    {
      output: ' Tags:  Request Logger, HTTP_server\n2. `TypeScript!` ',
      expected: ['Request Logger, HTTP_server', 'TypeScript!'],
    },
    {
      output: [
        '- "Request Logger"',
        '* request_logger',
        '+ REQUEST---LOGGER',
        '1) HTTP Logging',
        '2. Middleware',
      ].join('\n'),
      expected: [
        'Request Logger',
        'request_logger',
        'REQUEST---LOGGER',
        'HTTP Logging',
        'Middleware',
      ],
    },
    {
      output:
        'alpha-tag\n\n alpha-tag\n beta tag\n GAMMA_tag\n seventh\n eighth',
      expected: [
        'alpha-tag',
        'alpha-tag',
        'beta tag',
        'GAMMA_tag',
        'seventh',
        'eighth',
      ],
    },
    {
      output: 'Free-form prose, with sentence punctuation.',
      expected: ['Free-form prose, with sentence punctuation.'],
    },
    {
      output: 'Tags: first tag, second/tag, Third!',
      expected: ['first tag', 'second/tag', 'Third!'],
    },
    {
      output: 'first tag, second/tag, Third',
      expected: ['first tag', 'second/tag', 'Third'],
    },
    {
      output: '- - nested-prefix\n""nested-quotes""\n``nested-backticks``',
      expected: ['- nested-prefix', '"nested-quotes"', '`nested-backticks`'],
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const root = await tempRoot(context);
    const source = `plain-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n');

    const fake = createProvider((_system, _input, call) =>
      call === 0
        ? '# Guide Summary'
        : call === 1
          ? 'Documents a guide.'
          : testCase.output,
    );

    await generate({ provider: fake.provider, model: 'fake' }, root);

    const concept = await fs.readFile(conceptPath(root, source), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(concept)?.[1] ?? '';

    const metadata = parseDocument(frontmatter).toJS() as {
      readonly tags?: unknown;
    };

    assert.deepEqual(metadata.tags, testCase.expected);
  }
});

test('accepts one whole Markdown fence around tags', async (context) => {
  const cases = [
    [
      '```text\nTags:\n- Request Logger\n- HTTP_server\n```',
      ['Request Logger', 'HTTP_server'],
    ],
    [
      '~~~json\n["Request Logger", "", "HTTP_server!", "Request Logger"]\n~~~',
      ['Request Logger', 'HTTP_server!', 'Request Logger'],
    ],
  ] as const;

  for (const [index, [output, expected]] of cases.entries()) {
    const root = await tempRoot(context);
    const source = `fenced-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n');

    const fake = createProvider((_system, _input, call) =>
      call === 0
        ? '# Guide Summary'
        : call === 1
          ? 'Documents a guide.'
          : output,
    );

    await generate({ provider: fake.provider, model: 'fake' }, root);

    const concept = await fs.readFile(conceptPath(root, source), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(concept)?.[1] ?? '';

    const metadata = parseDocument(frontmatter).toJS() as {
      readonly tags?: unknown;
    };

    assert.deepEqual(metadata.tags, expected);
  }
});

test('retains exact non-empty strings from supported JSON tag payloads', async (context) => {
  const cases = [
    [
      '[" Request Logger ", "", "HTTP_server!", "Request Logger", "seventh", "eighth", "ninth"]',
      [
        'Request Logger',
        'HTTP_server!',
        'Request Logger',
        'seventh',
        'eighth',
        'ninth',
      ],
    ],
    [
      '{"tags":[" Request Logger ","","HTTP_server!","Request Logger"]}',
      ['Request Logger', 'HTTP_server!', 'Request Logger'],
    ],
  ] as const;

  for (const [index, [output, expected]] of cases.entries()) {
    const root = await tempRoot(context);
    const source = `json-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n');

    const fake = createProvider((_system, _input, call) =>
      call === 0
        ? '# Guide Summary'
        : call === 1
          ? 'Documents a guide.'
          : output,
    );

    await generate({ provider: fake.provider, model: 'fake' }, root);

    const concept = await fs.readFile(conceptPath(root, source), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(concept)?.[1] ?? '';

    const metadata = parseDocument(frontmatter).toJS() as {
      readonly tags?: unknown;
    };

    assert.deepEqual(metadata.tags, expected);
  }
});

test('falls back to the original completion for ambiguous structured or prose tag output', async (context) => {
  const cases = [
    '[request-logger, http-logging]',
    '{"tags":["request-logger"],"reason":"PRIVATE_JSON_SENTINEL"}',
    '{"tags":"request-logger"}',
    'request-logger;http-logging',
    'request/logger',
    '```text\nrequest-logger\n~~~',
    'This is an explanatory sentence, not a comma-separated tag list.',
    '[]',
    '["", "  "]',
    '{"tags":[]}',
    '```json\n[]\n```',
    '42',
  ] as const;

  for (const [index, output] of cases.entries()) {
    const root = await tempRoot(context);
    const source = `invalid-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n');

    const fake = createProvider((_system, _input, call) =>
      call === 0
        ? '# Guide Summary'
        : call === 1
          ? 'Documents a guide.'
          : output,
    );

    await generate({ provider: fake.provider, model: 'fake' }, root);

    assert.equal(fake.requests.length, 3);

    const concept = await fs.readFile(conceptPath(root, source), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(concept)?.[1] ?? '';

    const metadata = parseDocument(frontmatter).toJS() as {
      readonly tags?: unknown;
    };

    assert.deepEqual(metadata.tags, [output]);
  }
});

test('frames an adversarial summary exactly for both downstream calls and routes each system prompt', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n');

  const summary = [
    '# Summary',
    '',
    `Backticks: ${'`'.repeat(9)}`,
    `Tildes: ${'~'.repeat(12)}`,
    '',
    'Nothing in this summary may be truncated.',
  ].join('\n');

  const expectedInput = [
    '# Source Summary',
    '',
    `${'`'.repeat(10)}text`,
    summary,
    '`'.repeat(10),
  ].join('\n');

  const fake = createProvider((_system, input, index) => {
    if (index === 0) {
      return summary;
    }

    assert.equal(input, expectedInput);

    return index === 1 ? 'Documents a repository guide.' : 'documentation';
  });

  await generate({ provider: fake.provider, model: 'fake' }, root);

  assert.equal(fake.requests.length, 3);

  assert.equal(
    fake.requests[1]?.messages.find(({ role }) => role === 'user')?.content,
    expectedInput,
  );

  assert.equal(
    fake.requests[2]?.messages.find(({ role }) => role === 'user')?.content,
    expectedInput,
  );

  const promptRoot = path.join(process.cwd(), 'packages', 'okf', 'prompts');

  const expectedSystems = await Promise.all(
    [
      ['summarize', 'default', 'SYSTEM_PROMPT.md'],
      ['describe', 'default', 'SYSTEM_PROMPT.md'],
      ['tags', 'default', 'SYSTEM_PROMPT.md'],
    ].map((parts) => fs.readFile(path.join(promptRoot, ...parts), 'utf-8')),
  );

  fake.requests.forEach((request, index) => {
    assert.equal(
      request.messages.find(({ role }) => role === 'system')?.content,
      expectedSystems[index]?.trim(),
    );

    assert.equal(request.schema, undefined);
  });
});

test('does not continue after invalid summary or empty tags output', async (context) => {
  const cases = [
    [
      '---\ntitle: forbidden\n---\n# Summary',
      1,
      'OKF_SUMMARY_FAILED',
      'summary',
    ],
    ['# Summary', 3, 'OKF_TAGS_FAILED', 'tags'],
  ] as const;

  for (const [summary, calls, code, stage] of cases) {
    const root = await tempRoot(context);

    await fs.writeFile(path.join(root, `${calls}.md`), '# Guide\n', 'utf-8');

    const fake = createProvider((_system, _input, index) => {
      if (index === 0) {
        return summary;
      }

      if (index === 1) {
        return 'Documents a guide.';
      }

      return ' \t\r\n ';
    });

    await assert.rejects(
      generate({ provider: fake.provider, model: 'fake' }, root),
      (error: unknown) => {
        const failure = error as {
          readonly code?: string;
          readonly stage?: string;
        };

        assert.equal(failure.code, code);

        assert.equal(failure.stage, stage);

        return true;
      },
    );

    assert.equal(fake.requests.length, calls);

    await assert.rejects(fs.access(conceptPath(root, `${calls}.md`)));
  }
});

test('preserves any non-empty trimmed description and continues to tags', async (context) => {
  const descriptions = [
    `  ${'Long description '.repeat(20)}  `,
    '\nDescription without punctuation\n',
    'Description with repeated punctuation!!!',
    'First sentence. Second sentence.',
    '\n  First line.\nSecond line without punctuation  \n',
  ];

  for (const [index, description] of descriptions.entries()) {
    const root = await tempRoot(context);
    const source = `description-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n', 'utf-8');

    const fake = createProvider((_system, _input, call) =>
      call === 0
        ? '# Guide Summary'
        : call === 1
          ? description
          : 'documentation',
    );

    await generate({ provider: fake.provider, model: 'fake' }, root);

    assert.equal(fake.requests.length, 3);

    const concept = await fs.readFile(conceptPath(root, source), 'utf-8');
    const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(concept)?.[1] ?? '';

    const metadata = parseDocument(frontmatter).toJS() as Record<
      string,
      unknown
    >;

    assert.equal(metadata.description, description.trim());

    assert.deepEqual(metadata.tags, ['documentation']);
  }
});

test('rejects only an empty description with actionable curated details', async (context) => {
  for (const [index, description] of ['', ' \t\r\n '].entries()) {
    const root = await tempRoot(context);
    const source = `empty-description-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n', 'utf-8');

    const fake = createProvider((_system, _input, call) =>
      call === 0 ? '# Guide Summary' : description,
    );

    await assert.rejects(
      generate({ provider: fake.provider, model: 'fake' }, root),
      (error: unknown) => {
        assert.ok(error instanceof OkfError);

        assert.equal(isOkfError(error), true);

        assert.equal(error.code, 'OKF_DESCRIPTION_FAILED');

        assert.equal(error.stage, 'description');

        assert.equal(error.source, source);

        assert.equal(
          error.message,
          `The model could not produce a non-empty description for ${source}.`,
        );

        assert.equal(
          error.hint,
          'Confirm the model is available and can return non-empty text.',
        );

        return true;
      },
    );

    assert.equal(fake.requests.length, 2);

    await assert.rejects(fs.access(conceptPath(root, source)));
  }
});

test('rejects only empty tags with actionable curated details', async (context) => {
  for (const [index, tags] of ['', ' \t\r\n '].entries()) {
    const root = await tempRoot(context);
    const source = `empty-tags-${index}.md`;

    await fs.writeFile(path.join(root, source), '# Guide\n', 'utf-8');

    const fake = createProvider((_system, _input, call) =>
      call === 0 ? '# Guide Summary' : call === 1 ? 'Documents a guide.' : tags,
    );

    await assert.rejects(
      generate({ provider: fake.provider, model: 'fake' }, root),
      (error: unknown) => {
        assert.ok(error instanceof OkfError);

        assert.equal(isOkfError(error), true);

        assert.equal(error.code, 'OKF_TAGS_FAILED');

        assert.equal(error.stage, 'tags');

        assert.equal(error.source, source);

        assert.equal(
          error.message,
          `The model could not produce non-empty tags for ${source}.`,
        );

        assert.equal(
          error.hint,
          'Confirm the model is available and can return non-empty text.',
        );

        return true;
      },
    );

    assert.equal(fake.requests.length, 3);

    await assert.rejects(fs.access(conceptPath(root, source)));
  }
});

test('reports provider description failures with the non-empty description contract', async (context) => {
  const root = await tempRoot(context);
  const source = 'provider-description.md';

  await fs.writeFile(path.join(root, source), '# Guide\n', 'utf-8');

  const fake = createProvider((_system, _input, call) => {
    if (call === 0) {
      return '# Guide Summary';
    }

    throw new Error('PRIVATE_PROVIDER_FAILURE');
  });

  await assert.rejects(
    generate({ provider: fake.provider, model: 'fake' }, root),
    (error: unknown) => {
      assert.ok(error instanceof OkfError);

      assert.equal(isOkfError(error), true);

      assert.equal(error.code, 'OKF_DESCRIPTION_FAILED');

      assert.equal(error.stage, 'description');

      assert.equal(error.source, source);

      assert.equal(
        error.message,
        `The model could not produce a non-empty description for ${source}.`,
      );

      assert.equal(
        error.hint,
        'Confirm the model is available and can return non-empty text.',
      );

      assert.doesNotMatch(
        `${error.message}\n${error.hint}\n${error.stack}`,
        /PRIVATE_PROVIDER_FAILURE/u,
      );

      return true;
    },
  );

  assert.equal(fake.requests.length, 2);
});

test('reports the complete normalized progress lifecycle', async (context) => {
  const root = await tempRoot(context);

  await fs.mkdir(path.join(root, 'nested'));

  await fs.writeFile(path.join(root, 'nested', 'guide.md'), '# Guide\n');

  const events: ProgressEvent[] = [];

  await generate(
    {
      provider: createProvider().provider,
      model: 'fake',
      batchSize: 1,
      progress: (event) => events.push(event),
    },
    root,
  );

  assert.deepEqual(
    events.map(({ event }) => event),
    [
      'okf.generate.start',
      'okf.file.start',
      'okf.file.cache.miss',
      'okf.file.summary.start',
      'okf.file.summary.complete',
      'okf.file.description.start',
      'okf.file.description.complete',
      'okf.file.tags.start',
      'okf.file.tags.complete',
      'okf.file.generated',
      'okf.index.start',
      'okf.index.complete',
      'okf.generate.complete',
    ],
  );

  for (const event of events) {
    if ('source' in event) {
      assert.equal(event.source, 'nested/guide.md');
    }
  }
});

test('preserves observer exception identity and emits nothing later', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n');

  const failure = new Error('observer failed');
  const observed: string[] = [];

  const progress: Progress = (event) => {
    observed.push(event.event);

    if (event.event === 'okf.file.summary.start') {
      throw failure;
    }
  };
  const fake = createProvider();

  await assert.rejects(
    generate({ provider: fake.provider, model: 'fake', progress }, root),
    (error: unknown) => error === failure,
  );

  assert.deepEqual(observed, [
    'okf.generate.start',
    'okf.file.start',
    'okf.file.cache.miss',
    'okf.file.summary.start',
  ]);

  assert.equal(fake.requests.length, 0);
});

test('gates concurrent progress after the first observer exception', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    fs.writeFile(path.join(root, 'a.md'), '# A\n'),
    fs.writeFile(path.join(root, 'b.md'), '# B\n'),
  ]);

  const failure = new Error('concurrent observer failed');
  const late: ProgressEvent[] = [];
  let failed = false;

  const progress: Progress = (event) => {
    if (failed) {
      late.push(event);

      return;
    }

    if (event.event === 'okf.file.cache.miss') {
      failed = true;

      throw failure;
    }
  };

  await assert.rejects(
    generate(
      {
        provider: createProvider().provider,
        model: 'fake',
        batchSize: 2,
        progress,
      },
      root,
    ),
    (error: unknown) => error === failure,
  );

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(late, []);
});

test('authenticates package errors and rejects a prototype-forged observer error', async (context) => {
  const root = await tempRoot(context);

  await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n');

  const forged = Object.assign(Object.create(OkfError.prototype) as OkfError, {
    name: 'OkfError',
    message: 'PRIVATE_FORGED_MESSAGE',
    code: 'OKF_SUMMARY_FAILED',
    stage: 'summary',
    source: 'C:/private/guide.md',
    hint: 'PRIVATE_FORGED_HINT',
  });

  const progress: Progress = (event) => {
    if (event.event === 'okf.file.summary.start') {
      throw forged;
    }
  };

  assert.equal(forged instanceof OkfError, true);

  assert.equal(isOkfError(forged), false);

  await assert.rejects(
    generate(
      { provider: createProvider().provider, model: 'fake', progress },
      root,
    ),
    (error: unknown) => error === forged,
  );
});

test('reports setup prompt syntax and cache failures with curated details', async (context) => {
  const base = await tempRoot(context);
  const fake = createProvider();

  await assert.rejects(
    generate({ provider: fake.provider, model: 'fake' }, path.join(base, 'x')),
    (error: unknown) => okfFailure(error, 'OKF_ROOT_INVALID', 'setup'),
  );

  await fs.writeFile(path.join(base, 'guide.md'), '# Guide\n');

  await assert.rejects(
    generate(
      { provider: fake.provider, model: 'fake', promptTarget: 'missing' },
      base,
    ),
    (error: unknown) => okfFailure(error, 'OKF_PROMPT_LOAD_FAILED', 'prompt'),
  );

  await fs.writeFile(path.join(base, 'broken.ts'), 'export const = 1;');

  await assert.rejects(
    generate({ provider: fake.provider, model: 'fake' }, base),
    (error: unknown) =>
      okfFailure(error, 'OKF_SOURCE_SYNTAX_INVALID', 'syntax', 'broken.ts'),
  );

  await fs.rm(path.join(base, 'broken.ts'));

  await fs.mkdir(conceptPath(base, 'guide.md'), { recursive: true });

  await assert.rejects(
    generate({ provider: fake.provider, model: 'fake' }, base),
    (error: unknown) =>
      okfFailure(error, 'OKF_CACHE_READ_FAILED', 'cache', 'guide.md'),
  );
});

test('reports output preparation and discovery failures with curated details', async (context) => {
  const outputRoot = await tempRoot(context);

  await fs.mkdir(path.join(outputRoot, '.agents', 'bundles'), {
    recursive: true,
  });

  await fs.writeFile(defaultOutput(outputRoot), 'conflict');

  await assert.rejects(
    generate(
      { provider: createProvider().provider, model: 'fake' },
      outputRoot,
    ),
    (error: unknown) => okfFailure(error, 'OKF_OUTPUT_PREPARE_FAILED', 'setup'),
  );

  const discoveryRoot = await tempRoot(context);
  const source = path.join(discoveryRoot, 'guide.md');

  await fs.writeFile(source, '# Guide\n');

  const readFile = fs.readFile.bind(fs);

  context.mock.method(
    fs,
    'readFile',
    async (target: unknown, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === source) {
        throw new Error('PRIVATE_DISCOVERY_DETAIL');
      }

      return (readFile as (...args: unknown[]) => Promise<unknown>)(
        target,
        ...rest,
      );
    },
  );

  await assert.rejects(
    generate(
      { provider: createProvider().provider, model: 'fake' },
      discoveryRoot,
    ),
    (error: unknown) =>
      okfFailure(
        error,
        'OKF_DISCOVERY_FAILED',
        'discovery',
        undefined,
        'PRIVATE_DISCOVERY_DETAIL',
      ),
  );
});

test('sanitizes private model failures for every generation stage', async (context) => {
  const cases = [
    [0, 'OKF_SUMMARY_FAILED', 'summary'],
    [1, 'OKF_DESCRIPTION_FAILED', 'description'],
    [2, 'OKF_TAGS_FAILED', 'tags'],
  ] as const;

  for (const [failedCall, code, stage] of cases) {
    const root = await tempRoot(context);

    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n');

    const sentinel = `PRIVATE_${stage.toUpperCase()}_DETAIL`;

    const fake = createProvider((_system, _input, index) => {
      if (index === failedCall) {
        throw new Error(sentinel, { cause: new Error(sentinel) });
      }

      return index === 0
        ? '# Guide Summary'
        : index === 1
          ? 'Documents a guide.'
          : 'guide';
    });

    await assert.rejects(
      generate({ provider: fake.provider, model: 'fake' }, root),
      (error: unknown) => okfFailure(error, code, stage, 'guide.md', sentinel),
    );

    assert.equal(fake.requests.length, failedCall + 1);
  }
});

test('reports write and index failures without filesystem leakage', async (context) => {
  const writeRoot = await tempRoot(context);

  await fs.writeFile(path.join(writeRoot, 'guide.md'), '# Guide\n');

  const writeTarget = conceptPath(writeRoot, 'guide.md');

  const writeProgress = ((event: ProgressEvent) => {
    if ((event.event as string) === 'okf.file.tags.complete') {
      fsSync.mkdirSync(writeTarget);
    }
  }) as Progress;

  await assert.rejects(
    generate(
      {
        provider: createProvider().provider,
        model: 'fake',
        progress: writeProgress,
      },
      writeRoot,
    ),
    (error: unknown) =>
      okfFailure(error, 'OKF_CONCEPT_WRITE_FAILED', 'write', 'guide.md'),
  );

  const indexRoot = await tempRoot(context);

  await fs.writeFile(path.join(indexRoot, 'guide.md'), '# Guide\n');

  const index = path.join(defaultOutput(indexRoot), 'index.md');

  const indexProgress: Progress = (event) => {
    if (event.event === 'okf.index.start') {
      fsSync.mkdirSync(index);
    }
  };

  await assert.rejects(
    generate(
      {
        provider: createProvider().provider,
        model: 'fake',
        progress: indexProgress,
      },
      indexRoot,
    ),
    (error: unknown) => okfFailure(error, 'OKF_INDEX_FAILED', 'index'),
  );
});

test('preserves sanitized AbortError semantics at every model stage', async (context) => {
  for (const failedCall of [0, 1, 2]) {
    const root = await tempRoot(context);

    await fs.writeFile(path.join(root, 'guide.md'), '# Guide\n');

    const sentinel = `PRIVATE_ABORT_${failedCall}`;

    const fake = createProvider((_system, _input, index) => {
      if (index === failedCall) {
        throw new DOMException(sentinel, 'AbortError');
      }

      return index === 0
        ? '# Guide Summary'
        : index === 1
          ? 'Documents a guide.'
          : 'guide';
    });

    await assert.rejects(
      generate({ provider: fake.provider, model: 'fake' }, root),
      (error: unknown) => {
        assert.ok(error instanceof Error);

        assert.equal(error.name, 'AbortError');

        assert.equal((error as Error & { cause?: unknown }).cause, undefined);

        assert.doesNotMatch(
          JSON.stringify({ message: error.message, stack: error.stack }),
          new RegExp(sentinel, 'u'),
        );

        return true;
      },
    );
  }
});

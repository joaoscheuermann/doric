import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createTool } from '../src/index.js';
import { createFakeSandbox, WORKSPACE_ROOT } from './fake-sandbox.js';

describe('OKF search tool', () => {
  test('searches bundles and ranks metadata above body matches', async () => {
    const root = await workspace('rank');

    await concept(root, 'project/source.md', {
      type: 'Reference',
      title: 'Authentication architecture',
      description: 'Documents token validation.',
      tags: ['security'],
      body: 'General implementation notes.',
    });

    await concept(root, 'platform/details.md', {
      type: 'Reference',
      title: 'Implementation notes',
      body: 'The authentication architecture is mentioned in this body.',
    });

    const fake = createFakeSandbox(root);

    const output = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(fake.session).execute({ query: 'authentication architecture' });

    assert.deepEqual(
      output.results.map((result) => result.conceptId),
      ['source', 'details'],
    );

    assert.ok(output.results[0].score > output.results[1].score);

    assert.equal(output.total, 2);

    assert.equal(output.skipped, 0);

    await rm(root, { recursive: true, force: true });
  });

  test('parses YAML metadata permissively and derives a missing title', async () => {
    const root = await workspace('metadata');

    await write(
      root,
      '.agents/bundles/project/api/users.md',
      [
        '---',
        'type: API Endpoint',
        'description: Fetches users.',
        'resource: source:src/users.ts',
        'tags:',
        '  - api',
        '  - users',
        'timestamp: 2026-07-12T10:00:00Z',
        'producer_extension: tolerated',
        '---',
        'Returns user records.',
      ].join('\n'),
    );

    const fake = createFakeSandbox(root);

    const output = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(fake.session).execute({ query: 'users', bundle: 'project' });

    assert.deepEqual(output.results[0], {
      bundle: 'project',
      conceptId: 'api/users',
      path: 'project/api/users.md',
      type: 'API Endpoint',
      title: 'users',
      description: 'Fetches users.',
      resource: 'source:src/users.ts',
      tags: ['api', 'users'],
      timestamp: '2026-07-12T10:00:00Z',
      content: 'Returns user records.',
      contentTruncated: false,
      score: output.results[0].score,
    });

    await rm(root, { recursive: true, force: true });
  });

  test('skips reserved and malformed documents without rejecting a bundle', async () => {
    const root = await workspace('permissive');

    await write(root, '.agents/bundles/project/index.md', '# Project\n');

    await write(root, '.agents/bundles/project/log.md', '# Updates\n');

    await write(
      root,
      '.agents/bundles/project/broken.md',
      '---\ntitle: Missing type\n---\nSearchable text.\n',
    );

    await concept(root, 'project/valid.md', {
      type: 'Unregistered Producer Type',
      title: 'Searchable concept',
      body: 'Valid body.',
    });

    const fake = createFakeSandbox(root);

    const output = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(fake.session).execute({ query: 'searchable' });

    assert.deepEqual(
      output.results.map((result) => result.conceptId),
      ['valid'],
    );

    assert.equal(output.skipped, 1);

    await rm(root, { recursive: true, force: true });
  });

  test('rejects bundle traversal without reading outside the bundle root', async () => {
    const root = await workspace('traversal');

    await write(root, '.agents/skills/private.md', 'PRIVATE_SENTINEL');

    const fake = createFakeSandbox(root);

    const output = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(fake.session).execute({ query: 'private', bundle: '../skills' });

    assert.match(output.error ?? '', /Invalid bundle name/u);

    assert.deepEqual(fake.reads, []);

    await rm(root, { recursive: true, force: true });
  });

  test('does not follow symlinks and reports missing bundle roots', async () => {
    const root = await workspace('symlink');

    await write(
      root,
      'outside/secret.md',
      okf('Reference', 'Secret', 'needle'),
    );

    await mkdir(path.join(root, '.agents/bundles/project'), {
      recursive: true,
    });

    await symlink(
      path.join(root, 'outside/secret.md'),
      path.join(root, '.agents/bundles/project/secret.md'),
    );

    const fake = createFakeSandbox(root);

    const output = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(fake.session).execute({ query: 'needle' });

    assert.equal(output.total, 0);

    assert.deepEqual(fake.reads, []);

    const missingRoot = await workspace('missing');
    const missingFake = createFakeSandbox(missingRoot);

    const missing = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(missingFake.session).execute({ query: 'anything' });

    assert.match(missing.error ?? '', /bundle root not found/u);

    await rm(root, { recursive: true, force: true });

    await rm(missingRoot, { recursive: true, force: true });
  });

  test('bounds result count and returned concept content', async () => {
    const root = await workspace('bounds');

    await concept(root, 'project/one.md', {
      type: 'Reference',
      title: 'Needle one',
      body: `needle ${'x'.repeat(5_000)}`,
    });

    await concept(root, 'project/two.md', {
      type: 'Reference',
      title: 'Needle two',
      body: 'needle',
    });

    const fake = createFakeSandbox(root);

    const output = await createTool({
      workspaceRoot: WORKSPACE_ROOT,
    })(fake.session).execute({ query: 'needle', limit: 1 });

    assert.equal(output.results.length, 1);

    assert.equal(output.total, 2);

    assert.equal(output.truncated, true);

    assert.equal(output.results[0].content.length, 4_000);

    assert.equal(output.results[0].contentTruncated, true);

    await rm(root, { recursive: true, force: true });
  });
});

type Concept = {
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly body: string;
};

const workspace = (name: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `doric-okf-${name}-`));

const concept = async (
  root: string,
  relative: string,
  value: Concept,
): Promise<void> => {
  const metadata = [
    `type: ${JSON.stringify(value.type)}`,
    ...(value.title === undefined
      ? []
      : [`title: ${JSON.stringify(value.title)}`]),
    ...(value.description === undefined
      ? []
      : [`description: ${JSON.stringify(value.description)}`]),
    ...(value.tags === undefined
      ? []
      : [`tags: [${value.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`]),
  ].join('\n');

  await write(
    root,
    `.agents/bundles/${relative}`,
    `---\n${metadata}\n---\n${value.body}\n`,
  );
};

const okf = (type: string, title: string, body: string): string =>
  `---\ntype: ${type}\ntitle: ${title}\n---\n${body}\n`;

const write = async (
  root: string,
  file: string,
  content: string,
): Promise<void> => {
  const target = path.join(root, file);

  await mkdir(path.dirname(target), { recursive: true });

  await writeFile(target, content, 'utf8');
};

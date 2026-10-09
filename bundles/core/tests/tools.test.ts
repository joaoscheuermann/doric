import assert from 'node:assert/strict';
import test from 'node:test';

import { DoricBundleV1, ToolsV1 } from 'bundle/contracts';
import { defineTool, isBoundTool } from 'tool';
import { z } from 'zod';

import { boot, core, probe, reasonCodes, states } from './support/host.js';

const usesTools = ['tools/v1@^1.0.0'];

/** A tool that answers which bundle's services it runs with. */
const whoami = (name: string) =>
  defineTool({
    name,
    input: z.object({}).strict(),
    output: z.string(),
    execute: (_payload, call, services) =>
      services.use(DoricBundleV1).describe(call).bundleId,
  });

const registering = (
  id: string,
  tools: readonly { readonly name: string; readonly always: boolean }[],
  options: { readonly fail?: boolean } = {},
) =>
  probe(id, {
    requires: usesTools,
    activate: ({ services }) => {
      for (const { name, always } of tools) {
        services
          .use(ToolsV1)
          .register(whoami(name), { alwaysAvailable: always });
      }

      if (options.fail === true) throw new Error(`${id} failed`);
    },
  });

void test('lists tools in bundle activation order, then registration order', async () => {
  const host = await boot([
    await core(),
    registering('beta', [
      { name: 'b-one', always: false },
      { name: 'b-two', always: true },
    ]),
    registering('alpha', [{ name: 'a-one', always: true }]),
  ]);

  try {
    const listed = host.platform.services
      .use(ToolsV1)
      .list()
      .map(({ bundleId, alwaysAvailable, tool }) => [
        bundleId,
        tool.name,
        alwaysAvailable,
      ]);

    assert.deepEqual(listed, [
      ['alpha', 'a-one', true],
      ['beta', 'b-one', false],
      ['beta', 'b-two', true],
    ]);
  } finally {
    await host.close();
  }
});

void test('a registered tool runs with the services of the bundle that registered it', async () => {
  const host = await boot([
    await core(),
    registering('alpha', [{ name: 'who', always: true }]),
  ]);

  try {
    const [entry] = host.platform.services.use(ToolsV1).list();

    assert.ok(entry !== undefined && isBoundTool(entry.tool));
    assert.equal(
      await entry.tool.toTool(host.platform.call()).execute({}),
      'alpha',
    );
  } finally {
    await host.close();
  }
});

void test('a duplicate tool name quarantines the second bundle; the first keeps it', async () => {
  const host = await boot([
    await core(),
    registering('alpha', [{ name: 'shared', always: true }]),
    registering('beta', [
      { name: 'beta-only', always: true },
      { name: 'shared', always: true },
    ]),
  ]);

  try {
    assert.equal(states(host.platform).alpha, 'active');
    assert.equal(states(host.platform).beta, 'quarantined');
    assert.deepEqual(reasonCodes(host.platform, 'beta'), [
      'registration_failed',
    ]);
    assert.deepEqual(
      host.platform.services
        .use(ToolsV1)
        .list()
        .map(({ bundleId, tool }) => `${bundleId}:${tool.name}`),
      ['alpha:shared'],
    );
  } finally {
    await host.close();
  }
});

void test('a bundle whose activation fails leaves no tool behind', async () => {
  const host = await boot([
    await core(),
    registering('alpha', [{ name: 'kept', always: true }]),
    registering('beta', [{ name: 'dropped', always: true }], { fail: true }),
  ]);

  try {
    assert.equal(states(host.platform).beta, 'quarantined');
    assert.deepEqual(
      host.platform.services
        .use(ToolsV1)
        .list()
        .map(({ tool }) => tool.name),
      ['kept'],
    );
  } finally {
    await host.close();
  }
});

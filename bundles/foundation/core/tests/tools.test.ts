import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DoricBundleV1,
  isContractError,
  type RegisteredTool,
  type Tools,
  ToolsV1,
} from 'bundle/contracts';
import { defineTool, isBoundTool } from 'tool';
import { z } from 'zod';

import {
  type Booted,
  boot,
  core,
  probe,
  reasonCodes,
  states,
} from './support/host.js';

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
  tools: readonly {
    readonly name: string;
    readonly always: boolean;
    readonly order?: number;
  }[],
  options: { readonly fail?: boolean } = {},
) =>
  probe(id, {
    requires: usesTools,
    activate: ({ services }) => {
      for (const { name, always, order } of tools) {
        services.use(ToolsV1).register(whoami(name), {
          alwaysAvailable: always,
          ...(order === undefined ? {} : { order }),
        });
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

void test('order keys place tools globally across bundles; unordered tools follow in registration order', async () => {
  // The Q1 shape: a later bundle's tool lands between an earlier bundle's.
  const host = await boot([
    await core(),
    registering('files', [
      { name: 'cwd', always: true, order: 100 },
      { name: 'tree', always: true, order: 600 },
      { name: 'unordered-f', always: true },
    ]),
    registering('terminal', [
      { name: 'terminal', always: true, order: 500 },
      { name: 'unordered-t', always: true },
    ]),
    registering('web', [{ name: 'web', always: true, order: 700 }]),
  ]);

  try {
    const tools = host.platform.services.use(ToolsV1);

    assert.deepEqual(
      tools.list().map(({ tool, order }) => [tool.name, order]),
      [
        ['cwd', 100],
        ['terminal', 500],
        ['tree', 600],
        ['web', 700],
        ['unordered-f', undefined],
        ['unordered-t', undefined],
      ],
    );
    assert.deepEqual(
      (await tools.catalog()).map(({ name }) => name),
      ['cwd', 'terminal', 'tree', 'web', 'unordered-f', 'unordered-t'],
    );
  } finally {
    await host.close();
  }
});

void test('an order key that is not a positive integer is refused', async () => {
  for (const order of [0, -5, 2.5]) {
    const host = await boot([
      await core(),
      registering('alpha', [{ name: 'a-one', always: true, order }]),
    ]);

    try {
      assert.equal(states(host.platform).alpha, 'quarantined');
      assert.deepEqual(host.platform.services.use(ToolsV1).list(), []);
    } finally {
      await host.close();
    }
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

void test('catalog answers the GET /tools entries as plain data, in list order', async () => {
  const field = {
    key: 'endpoint',
    label: 'Endpoint',
    kind: 'url',
    required: true,
    placeholder: 'https://example.com',
  } as const;
  const configured = probe('gamma', {
    requires: usesTools,
    activate: ({ services }) => {
      services.use(ToolsV1).register(
        defineTool({
          name: 'fetch-page',
          description: 'Reads one web page.',
          input: z.object({}).strict(),
          output: z.string(),
          settings: [field],
          execute: () => 'page',
        }),
        { alwaysAvailable: false },
      );
    },
  });
  const host = await boot([
    await core(),
    registering('alpha', [{ name: 'a-one', always: true }]),
    configured,
  ]);

  try {
    const tools = host.platform.services.use(ToolsV1);
    const catalog = await tools.catalog();

    assert.deepEqual(catalog, [
      { name: 'a-one', settings: [] },
      {
        name: 'fetch-page',
        description: 'Reads one web page.',
        settings: [field],
      },
    ]);
    assert.deepEqual(
      catalog.map(({ name }) => name),
      tools.list().map(({ tool }) => tool.name),
    );
    // The answer crosses any boundary unchanged: it is JSON already.
    assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
  } finally {
    await host.close();
  }
});

// Project-scoped tools (1.3.0) ------------------------------------------------

/**
 * Boots the core with one bundle that keeps its `tools/v1` to register with
 * after activation, the way a bundle adds tools as their sources appear.
 */
const withRegistrant = async (
  run: (tools: Tools, host: Booted) => Promise<void> | void,
): Promise<void> => {
  let tools: Tools | undefined;
  const host = await boot([
    await core(),
    probe('registrant', {
      requires: ['tools/v1@^1.3.0'],
      activate: ({ services }) => {
        tools = services.use(ToolsV1);
      },
    }),
  ]);

  try {
    assert.equal(states(host.platform).registrant, 'active');
    assert.ok(tools !== undefined);
    await run(tools, host);
  } finally {
    await host.close();
  }
};

const inProject = (host: Booted, projectId: string) =>
  host.platform.call({ scope: { projectId } });

const listedIn = (host: Booted, projectId?: string) =>
  host.platform.services
    .use(ToolsV1)
    .list(projectId === undefined ? undefined : inProject(host, projectId));

const namesOf = (entries: readonly RegisteredTool[]) =>
  entries.map(({ tool }) => tool.name);

const isDuplicate = (error: unknown): boolean =>
  isContractError(error) && error.code === 'duplicate_tool';

void test('a Project tool is listed to its Project, marked with it, in global order', async () => {
  await withRegistrant((tools, host) => {
    tools.register(whoami('everyone-300'), {
      alwaysAvailable: true,
      order: 300,
    });
    tools.register(whoami('p1-100'), {
      alwaysAvailable: false,
      order: 100,
      projectId: 'p1',
    });
    tools.register(whoami('p1-500'), {
      alwaysAvailable: false,
      order: 500,
      projectId: 'p1',
    });
    tools.register(whoami('everyone-unordered'), { alwaysAvailable: true });

    assert.deepEqual(
      listedIn(host, 'p1').map(({ tool, projectId, order }) => [
        tool.name,
        projectId,
        order,
      ]),
      [
        ['p1-100', 'p1', 100],
        ['everyone-300', undefined, 300],
        ['p1-500', 'p1', 500],
        ['everyone-unordered', undefined, undefined],
      ],
    );
  });
});

void test('a Project tool is not listed to another Project', async () => {
  await withRegistrant((tools, host) => {
    tools.register(whoami('everyone'), { alwaysAvailable: true });
    tools.register(whoami('p1-only'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });

    assert.deepEqual(namesOf(listedIn(host, 'p2')), ['everyone']);
  });
});

void test('a call without a Project sees only unscoped tools in list and catalog', async () => {
  await withRegistrant(async (tools, host) => {
    tools.register(whoami('everyone'), { alwaysAvailable: true });
    tools.register(whoami('p1-only'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });
    const service = host.platform.services.use(ToolsV1);

    assert.deepEqual(namesOf(service.list()), ['everyone']);
    assert.deepEqual(
      (await service.catalog()).map(({ name }) => name),
      ['everyone'],
    );
    assert.deepEqual(
      (await service.catalog(inProject(host, 'p1'))).map(({ name }) => name),
      ['everyone', 'p1-only'],
    );
  });
});

void test('two Projects may each hold a tool of the same name', async () => {
  await withRegistrant((tools, host) => {
    tools.register(whoami('search'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });
    tools.register(whoami('search'), {
      alwaysAvailable: false,
      projectId: 'p2',
    });

    assert.deepEqual(
      listedIn(host, 'p1').map(({ tool, projectId }) => [tool.name, projectId]),
      [['search', 'p1']],
    );
    assert.deepEqual(
      listedIn(host, 'p2').map(({ tool, projectId }) => [tool.name, projectId]),
      [['search', 'p2']],
    );
  });
});

void test('one Project cannot hold two tools of the same name', async () => {
  await withRegistrant((tools, host) => {
    tools.register(whoami('search'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });

    assert.throws(
      () =>
        tools.register(whoami('search'), {
          alwaysAvailable: false,
          projectId: 'p1',
        }),
      isDuplicate,
    );
    assert.deepEqual(namesOf(listedIn(host, 'p1')), ['search']);
  });
});

void test('a Project tool and an unscoped tool cannot share a name, in either order', async () => {
  await withRegistrant((tools) => {
    tools.register(whoami('shared'), { alwaysAvailable: true });

    assert.throws(
      () =>
        tools.register(whoami('shared'), {
          alwaysAvailable: false,
          projectId: 'p1',
        }),
      isDuplicate,
    );

    tools.register(whoami('held'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });

    assert.throws(
      () => tools.register(whoami('held'), { alwaysAvailable: true }),
      isDuplicate,
    );
  });
});

void test('disposing a Project tool removes it from that Project only', async () => {
  await withRegistrant((tools, host) => {
    const first = tools.register(whoami('search'), {
      alwaysAvailable: false,
      projectId: 'p1',
    });
    tools.register(whoami('search'), {
      alwaysAvailable: false,
      projectId: 'p2',
    });

    first.dispose();

    assert.deepEqual(namesOf(listedIn(host, 'p1')), []);
    assert.deepEqual(
      listedIn(host, 'p2').map(({ tool, projectId }) => [tool.name, projectId]),
      [['search', 'p2']],
    );
  });
});

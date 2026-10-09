import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { SkillsV1, ToolsV1 } from 'bundle/contracts';
import express from 'express';
import type { Host, ThreadControl } from 'host';
import pino from 'pino';
import type { Sandbox } from 'sandbox';
import { createToolStorage, ToolErrorObject } from 'tool';

import { directSystemPrompt } from '../src/lib/agents/direct/executor.js';
import { createHostAdapter } from '../src/lib/bundles/adapter.js';
import {
  BundleRecoveryError,
  bundlePaths,
  startBundles,
} from '../src/lib/bundles/boot.js';
import { createToolsRouter } from '../src/routes/tools.js';
import {
  bundlesPath,
  compositionPath,
  type DefaultBundles,
  defaultBundles,
} from './helpers/bundles.js';

// Build doric first: these tests boot the bundles the host stages in
// dist/bundles with the composition it ships, through the real loader.

/** Captured from the pre-migration build (HEAD 20775a6) before any change. */
const fixtures = 'agents/doric/tests/fixtures/stage1-parity';

const readFixture = async (name: string) =>
  readFile(join(fixtures, name), 'utf8');

interface SkillFixture {
  readonly name: string;
  readonly skills: readonly {
    readonly name: string;
    readonly alwaysAvailable: boolean;
    readonly allowedTools: readonly string[];
    readonly description: string;
    readonly indexText: string;
  }[];
  readonly tools: readonly {
    readonly name: string;
    readonly alwaysAvailable: boolean;
  }[];
}

const scope = {
  projectId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600',
  threadId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601',
  promptId: '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602',
};
const childId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';

const withBundles = async (
  run: (bundles: DefaultBundles) => Promise<void>,
): Promise<void> => {
  const bundles = await defaultBundles();

  try {
    await run(bundles);
  } finally {
    await bundles.platform.stop();
  }
};

/** A prompt's Host facade whose thread controls are given by the test. */
const testHost = (threads: Partial<ThreadControl>, extra: Partial<Host> = {}) =>
  ({
    threads: threads as ThreadControl,
    workspace: {
      cwd: () => '/workspace',
      setCwd: async () => ({ status: 'outside' as const }),
    },
    ...extra,
  }) satisfies Host;

const sandbox = { id: 'vm-1', root: '/workspace' } as Sandbox;

/** The agent-loop tool storage of one prompt, as the Direct executor builds it. */
const promptTools = (bundles: DefaultBundles) =>
  createToolStorage(
    bundles.catalog.tools.map((tool) =>
      tool.toTool(bundles.platform.call({ scope })),
    ),
  );

void test('the default composition exposes the pre-migration tools, in order, byte for byte', async () => {
  await withBundles(async (bundles) => {
    const expected = JSON.parse(await readFixture('tools.json')) as unknown;

    assert.deepEqual(
      bundles.catalog.tools.map(({ definition, settings }) => ({
        definition,
        settings,
      })),
      expected,
    );
    assert.deepEqual(
      bundles.catalog.tools.map(({ name }) => name),
      [
        'cwd',
        'edit',
        'find',
        'grep',
        'terminal',
        'tree',
        'web',
        'write',
        'git',
        'thread-spawn',
        'thread-list',
        'thread-get',
        'thread-events',
        'thread-send',
        'thread-interrupt',
        'thread-terminate',
      ],
    );
  });
});

void test('the Direct system prompt is byte-identical to the pre-migration one', async () => {
  await withBundles(async (bundles) => {
    assert.equal(
      directSystemPrompt(bundles.catalog.skills),
      await readFixture('system-prompt.md'),
    );
  });
});

void test('skills and tools keep their canonical records and availability flags', async () => {
  await withBundles(async (bundles) => {
    const expected = JSON.parse(
      await readFixture('skills.json'),
    ) as readonly SkillFixture[];
    const skills = await bundles.platform.services.use(SkillsV1).list();
    const tools = bundles.platform.services.use(ToolsV1).list();

    assert.deepEqual(
      skills.map(({ alwaysAvailable, skill }) => ({
        name: skill.name,
        alwaysAvailable,
        allowedTools: skill.allowedTools,
        description: skill.description,
        indexText: skill.indexText,
      })),
      expected.flatMap(({ skills: entries }) => entries),
    );
    assert.deepEqual(
      tools.map(({ alwaysAvailable, tool }) => ({
        name: tool.name,
        alwaysAvailable,
      })),
      expected.flatMap(({ tools: entries }) => entries),
    );
  });
});

void test('the catalog and diagnostics list every bundle active, with the core first', async () => {
  await withBundles(async (bundles) => {
    const diagnostics = bundles.platform.diagnostics();

    assert.equal(bundles.platform.mode, 'normal');
    assert.equal(bundles.bundleCount, 4);
    assert.deepEqual(
      Object.fromEntries(
        diagnostics.bundles.map(({ id, state, phase }) => [id, [state, phase]]),
      ),
      {
        core: ['active', 'core'],
        files: ['active', 'others'],
        git: ['active', 'others'],
        threads: ['active', 'others'],
        'host-adapter': ['active', 'others'],
      },
    );
    assert.deepEqual(
      bundles.platform.catalog().order.filter((id) => id !== 'host-adapter'),
      ['core', 'files', 'git', 'threads'],
    );
  });
});

void test('GET /tools answers the pre-migration catalog', async () => {
  await withBundles(async (bundles) => {
    const app = express();

    app.use(
      '/tools',
      createToolsRouter({
        current: () => ({ catalog: bundles.catalog }),
      } as never),
    );

    const server = createServer(app);

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      const address = server.address();

      assert.ok(address !== null && typeof address === 'object');

      const response = await fetch(`http://127.0.0.1:${address.port}/tools`);
      const expected = (
        JSON.parse(await readFixture('tools.json')) as {
          definition: { name: string; description?: string };
          settings: unknown[];
        }[]
      ).map(({ definition, settings }) => ({
        name: definition.name,
        description: definition.description,
        settings,
      }));

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { tools: expected });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

void test('a delegation tool serializes the whole stored record the Host returns', async () => {
  await withBundles(async (bundles) => {
    const record = {
      id: childId,
      projectId: scope.projectId,
      parentThreadId: scope.threadId,
      name: 'Child',
      state: 'ready',
      lastSequence: 3,
      cwd: '/workspace/repo',
      queuePaused: false,
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    };
    const release = bundles.adapter.attach(scope, {
      host: testHost({ get: async () => ({ thread: record }) }),
      sandbox,
    });

    try {
      const result = await promptTools(bundles).execute({
        id: 'call-1',
        name: 'thread-get',
        arguments: JSON.stringify({ threadId: childId }),
      });

      assert.equal(result, JSON.stringify({ thread: record }));
    } finally {
      release();
    }
  });
});

void test('a Host control failure fails the tool call with that same error as its cause', async () => {
  await withBundles(async (bundles) => {
    const refusal = new Error('Thread is not a direct child.');
    const release = bundles.adapter.attach(scope, {
      host: testHost({
        get: async () => {
          throw refusal;
        },
      }),
      sandbox,
    });

    try {
      await assert.rejects(
        promptTools(bundles).execute({
          id: 'call-1',
          name: 'thread-get',
          arguments: JSON.stringify({ threadId: childId }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof ToolErrorObject);
          assert.equal(error.data.code, 'handler_failed');
          assert.equal(error.cause, refusal);
          return true;
        },
      );
    } finally {
      release();
    }
  });
});

void test('the terminal tool reaches the prompt’s live terminals for a background command', async () => {
  await withBundles(async (bundles) => {
    const started: unknown[] = [];
    const release = bundles.adapter.attach(scope, {
      host: testHost(
        {},
        {
          terminals: {
            run: async (input) => {
              started.push(input);
              return { terminalId: 'terminal-1', background: true };
            },
          },
        },
      ),
      sandbox,
    });

    try {
      assert.deepEqual(
        await promptTools(bundles).execute({
          id: 'call-1',
          name: 'terminal',
          arguments: JSON.stringify({
            command: 'npm run dev',
            background: true,
          }),
        }),
        { terminal_id: 'terminal-1', background: true },
      );
      assert.deepEqual(started, [
        {
          command: 'npm run dev',
          cwd: '/workspace',
          timeoutMs: 120_000,
          background: true,
        },
      ]);
    } finally {
      release();
    }
  });
});

void test('after the prompt releases its binding, its tools report an inactive control', async () => {
  await withBundles(async (bundles) => {
    const release = bundles.adapter.attach(scope, {
      host: testHost({ list: async () => ({ items: [] }) }),
      sandbox,
    });

    release();

    await assert.rejects(
      promptTools(bundles).execute({
        id: 'call-1',
        name: 'thread-list',
        arguments: '{}',
      }),
      (error: unknown) => {
        assert.ok(error instanceof ToolErrorObject);
        assert.equal(error.data.code, 'handler_failed');
        assert.equal(
          (error.cause as Error).message,
          'Thread control is no longer active.',
        );
        return true;
      },
    );
  });
});

void test('a late release never drops the binding of the run that resumed the prompt', async () => {
  await withBundles(async (bundles) => {
    const paused = bundles.adapter.attach(scope, {
      host: testHost({ list: async () => ({ items: [] }) }),
      sandbox,
    });
    const resumed = bundles.adapter.attach(scope, {
      host: testHost({
        list: async () => ({ items: [], nextCursor: childId }),
      }),
      sandbox,
    });

    paused();

    try {
      assert.equal(
        await promptTools(bundles).execute({
          id: 'call-1',
          name: 'thread-list',
          arguments: '{}',
        }),
        JSON.stringify({ items: [], nextCursor: childId }),
      );
    } finally {
      resumed();
    }
  });
});

/**
 * An in-memory sandbox: files by absolute path, and commands answered by
 * `respond` (by default an empty success). It stands for the external
 * sandbox the runner leases; everything between it and the tools is real.
 */
const memorySandbox = (
  files: Record<string, string> = {},
  respond: (cmd: readonly string[]) => string = () => '',
) => {
  const contents = new Map(Object.entries(files));
  const commands: (readonly string[])[] = [];
  const bytes = (text: string) => new TextEncoder().encode(text);
  const leased = {
    id: 'vm-1',
    root: '/workspace',
    exec: async ({ cmd }: { readonly cmd: readonly string[] }) => {
      commands.push(cmd);

      const stdout = respond(cmd);

      return {
        exitCode: 0,
        stdout,
        stderr: '',
        stdoutBytes: bytes(stdout),
        stderrBytes: bytes(''),
      };
    },
    readFile: async (path: string) => {
      const content = contents.get(path);

      if (content === undefined) throw new Error(`ENOENT: ${path}`);

      return content;
    },
    writeFile: async (path: string, content: string) => {
      contents.set(path, content);
    },
  };

  return { sandbox: leased as unknown as Sandbox, contents, commands };
};

void test('the write tool reads and writes the attached sandbox’s files', async () => {
  await withBundles(async (bundles) => {
    const leased = memorySandbox({ '/workspace/notes.txt': 'old\n' });
    const release = bundles.adapter.attach(scope, {
      host: testHost({}),
      sandbox: leased.sandbox,
    });

    try {
      const result = (await promptTools(bundles).execute({
        id: 'call-1',
        name: 'write',
        arguments: JSON.stringify({ path: 'notes.txt', content: 'new\n' }),
      })) as { success: boolean; bytes_written: number; diff?: string };

      assert.equal(result.success, true);
      assert.equal(result.bytes_written, 4);
      // The diff shows the previous content, so the read reached the sandbox.
      assert.match(result.diff ?? '', /-old/u);
      assert.match(result.diff ?? '', /\+new/u);
      assert.equal(leased.contents.get('/workspace/notes.txt'), 'new\n');
    } finally {
      release();
    }
  });
});

void test('without live terminals the terminal tool runs a plain sandbox command and refuses background ones', async () => {
  await withBundles(async (bundles) => {
    const leased = memorySandbox({}, (cmd) =>
      cmd.join(' ') === 'sh -lc echo hi' ? 'hi\n' : '',
    );
    const release = bundles.adapter.attach(scope, {
      host: testHost({}),
      sandbox: leased.sandbox,
    });

    try {
      const result = (await promptTools(bundles).execute({
        id: 'call-1',
        name: 'terminal',
        arguments: JSON.stringify({ command: 'echo hi' }),
      })) as { schema: string; stdout: { head: readonly string[] } };

      assert.equal(result.schema, 'terminal.compact.v1');
      assert.deepEqual(result.stdout.head, ['hi']);
      await assert.rejects(
        promptTools(bundles).execute({
          id: 'call-2',
          name: 'terminal',
          arguments: JSON.stringify({
            command: 'npm run dev',
            background: true,
          }),
        }),
        (error: unknown) => {
          const messages: string[] = [];

          for (
            let current: unknown = error;
            current instanceof Error;
            current = current.cause
          )
            messages.push(current.message);

          assert.ok(
            messages.includes('This host does not support live terminals.'),
            messages.join(' / '),
          );
          return true;
        },
      );
    } finally {
      release();
    }
  });
});

void test('the cwd tool moves the Thread’s directory through the Host', async () => {
  await withBundles(async (bundles) => {
    const moves: string[] = [];
    const release = bundles.adapter.attach(scope, {
      host: testHost(
        {},
        {
          workspace: {
            cwd: () => '/workspace',
            setCwd: async (path) => {
              moves.push(path);
              return { status: 'set', cwd: '/workspace/repo' };
            },
          },
        },
      ),
      sandbox,
    });

    try {
      assert.deepEqual(
        await promptTools(bundles).execute({
          id: 'call-1',
          name: 'cwd',
          arguments: JSON.stringify({ path: 'repo' }),
        }),
        { cwd: '/workspace/repo', status: 'set' },
      );
      assert.deepEqual(moves, ['repo']);
    } finally {
      release();
    }
  });
});

/**
 * A bundles root holding copies of the staged bundles, for altered layouts. It
 * lives inside the workspace, as the staged root does, so the copies resolve
 * their package imports the same way.
 */
const stagedCopy = async (): Promise<string> => {
  const root = await mkdtemp(join('agents/doric/dist-tests', 'bundles-'));

  await cp(bundlesPath, root, { recursive: true });

  return root;
};

const startWith = async (
  root: string,
  composition: unknown,
  logger = pino({ enabled: false }),
) => {
  const path = join(root, '..', `${root.split('/').at(-1)}-composition.json`);

  await writeFile(path, JSON.stringify(composition));

  try {
    return await startBundles({
      bundlesPath: root,
      compositionPath: path,
      adapter: createHostAdapter(),
      logger,
    });
  } finally {
    await rm(path, { force: true });
  }
};

void test('a broken non-core bundle is quarantined and the others still serve', async () => {
  const root = await stagedCopy();

  try {
    await writeFile(join(root, 'git', 'manifest.json'), '{ "id": 42 }');

    const bundles = await startWith(
      root,
      JSON.parse(await readFile(compositionPath, 'utf8')),
    );

    try {
      assert.ok(
        bundles.platform
          .diagnostics()
          .bundles.some(
            ({ state, reasons }) =>
              state === 'quarantined' &&
              reasons.some(({ code }) => code === 'invalid_manifest'),
          ),
      );
      assert.ok(!bundles.catalog.tools.some(({ name }) => name === 'git'));
      assert.ok(
        bundles.catalog.tools.some(({ name }) => name === 'thread-spawn'),
      );
      assert.ok(
        !bundles.catalog.skills.some(({ name }) => name.startsWith('git-')),
      );
    } finally {
      await bundles.platform.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a core that cannot activate puts the host in recovery and boot refuses to continue', async () => {
  const root = await stagedCopy();
  const lines: { msg?: string }[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (line: string) => lines.push(JSON.parse(line) as { msg?: string }),
    },
  );

  try {
    await rm(join(root, 'core'), { recursive: true, force: true });

    await assert.rejects(
      startWith(
        root,
        JSON.parse(await readFile(compositionPath, 'utf8')),
        logger,
      ),
      (error: unknown) => error instanceof BundleRecoveryError,
    );
    assert.ok(lines.some(({ msg }) => msg === 'Bundle recovery mode'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('the bundles root and composition come from the environment or the host defaults', () => {
  assert.deepEqual(bundlePaths({}, '/opt/doric/agents/doric/dist/src'), {
    bundlesPath: '/opt/doric/agents/doric/dist/bundles',
    compositionPath: '/opt/doric/agents/doric/composition.json',
  });
  assert.deepEqual(
    bundlePaths(
      { DORIC_BUNDLES_PATH: '/srv/bundles', DORIC_COMPOSITION: '/srv/c.json' },
      '/opt/doric/agents/doric/dist/src',
    ),
    { bundlesPath: '/srv/bundles', compositionPath: '/srv/c.json' },
  );
});

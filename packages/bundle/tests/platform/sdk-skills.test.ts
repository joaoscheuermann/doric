// A host part's own skills (contracts `s62d.md`, "S62d3 addendum 2: bundles
// register their own skills", SK-2, B.1 and B.4 test 4): after `activate`
// resolves and before `ActivateResult`, the SDK registers each
// `src/skills/<folder>/SKILL.md` of the bundle directory through
// `skills/v1.Register`, as the instance, read through `context.assets` and
// tracked, so a new `skills/v1` provider instance gets them replayed. A skill
// that cannot be registered is skipped and logged (`warn`, `skill not
// registered`), never failing the activation.
//
// Bundles run in this process with `startBundle` against a real router
// listener whose routes come from a real host resolution
// (`resolveSkillsHost`); `core` serves `skills/v1` through a test double built
// on `RegistrationTable`, which records each `Register` with its stamped
// caller. The bundle directories are fixtures on disk (`manifest.json` and
// `src/skills/`).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe, type TestContext } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';

import { ContractError } from '../../src/contracts/error.js';
import {
  file_doric_skills_v1_skills,
  type RegisterRequest,
  SkillsService,
} from '../../src/contracts/gen/doric/skills/v1/skills_pb.js';
import type { Status } from '../../src/contracts/gen/google/rpc/status_pb.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type InstanceKey,
  InstanceTable,
  instanceKey,
} from '../../src/platform/router/instances.js';
import {
  type Router,
  startRouter,
} from '../../src/platform/router/listener.js';
import { callRoutesOf } from '../../src/platform/router/route.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';
import {
  type HostContext,
  type LogSink,
  RegistrationTable,
  type ServiceEntry,
  type StampedCaller,
  stampedCallerOf,
  startBundle,
} from '../../src/sdk/host/index.js';
import { resolveSkillsHost } from '../support/call-routes.js';
import { manifest, writeBundle } from '../support/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers

/** Timings short enough for tests. */
const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 5_000,
  activationTimeoutMs: 5_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  stopTimeoutMs: 2_000,
  activeWaitMs: 5_000,
  replayTimeoutMs: 4_000,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 8_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Polls `predicate` until it holds; fails after `timeoutMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await sleep(5);
  }
};

const index = createCatalogIndex([file_doric_skills_v1_skills]);

const keyOf = (caller: StampedCaller): string =>
  `${caller.bundleId}/${caller.generation}/${caller.incarnation}`;

/** One `Register` the `skills/v1` double received, as plain data. */
interface SkillRegister {
  /** The stamped caller, `<bundleId>/<generation>/<incarnation>`. */
  readonly by: string;
  readonly skill: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly allowedTools: readonly string[];
    readonly indexText: string | undefined;
  };
  readonly options: {
    readonly alwaysAvailable: boolean | undefined;
    readonly order: number | undefined;
  };
}

interface SkillsDouble {
  readonly services: readonly ServiceEntry[];
  readonly activate: (context: HostContext) => void;
  /** Every `Register` this instance received, in the order they arrived. */
  readonly registers: SkillRegister[];
}

const plainRegister = (
  caller: StampedCaller,
  request: RegisterRequest,
): SkillRegister => ({
  by: keyOf(caller),
  skill: {
    name: request.skill?.name ?? '',
    description: request.skill?.description ?? '',
    body: request.skill?.body ?? '',
    allowedTools: [...(request.skill?.allowedTools ?? [])],
    indexText: request.skill?.indexText,
  },
  options: {
    alwaysAvailable: request.options?.alwaysAvailable,
    order: request.options?.order,
  },
});

/**
 * `skills/v1` as one instance of `core` serves it: registrations by skill
 * name in a `RegistrationTable` (`duplicate_skill`), dropped on
 * `InstanceGone`; `List` answers the table's entries. `Register` of a name in
 * `refusing` fails with that name's error.
 */
const skillsDouble = (
  refusing: ReadonlyMap<string, Error> = new Map(),
): SkillsDouble => {
  const table = new RegistrationTable<SkillRegister>({
    conflictCode: 'duplicate_skill',
  });
  const registers: SkillRegister[] = [];
  const implementation: ServiceImpl<typeof SkillsService> = {
    register: (request, context) => {
      const caller = stampedCallerOf(context);
      const entry = plainRegister(caller, request);

      registers.push(entry);

      const refusal = refusing.get(entry.skill.name);

      if (refusal !== undefined) {
        throw refusal;
      }

      return table.register(caller, entry.skill.name, entry);
    },
    unregister: (request) => {
      table.remove(request.registrationId);

      return {};
    },
    list: () => ({
      skills: table.entries().map(({ caller, value }) => ({
        bundleId: caller.bundleId,
        alwaysAvailable: value.options.alwaysAvailable ?? false,
        ...(value.options.order === undefined
          ? {}
          : { order: value.options.order }),
        skill: {
          name: value.skill.name,
          description: value.skill.description,
          body: value.skill.body,
          allowedTools: [...value.skill.allowedTools],
          indexText: value.skill.indexText ?? value.skill.name,
        },
      })),
    }),
  };

  return {
    services: [[SkillsService, implementation] as ServiceEntry],
    activate: (context) => {
      context.instances.onGone((instance) => table.dropInstance(instance));
    },
    registers,
  };
};

const registeredNames = (registers: readonly SkillRegister[]): string[] =>
  registers.map(({ by, skill }) => `${by} ${skill.name}`);

/** One `context.log` record the bundle's sink received. */
interface Logged {
  readonly level: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** A `LogSink` that keeps every record; redactions never end. */
const recordingSink = (records: Logged[]): LogSink => ({
  writeBatch: async (batch) => {
    for (const { level, message, fields } of batch) {
      records.push({ level, message, fields: fields ?? {} });
    }
  },
  watchRedactions: (signal) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  }),
});

/** The `warn` records `skill not registered`, as `path code`. */
const skippedOf = (records: readonly Logged[]): string[] =>
  records
    .filter(
      ({ level, message }) =>
        level === 'warn' && message === 'skill not registered',
    )
    .map(({ fields }) =>
      [fields.path, fields.code].filter((part) => part !== undefined).join(' '),
    );

/** One bundle started in this process. */
interface Started {
  readonly key: InstanceKey;
  /** The `ActivateResult`'s status. */
  readonly status: Status;
  /** What `atActivate` answered once the `ActivateResult` arrived. */
  readonly atActivate: readonly string[];
  /** Every record of `context.log`, through the bundle's own sink. */
  readonly logged: Logged[];
  /** Every line the queue wrote to its output instead of the sink. */
  readonly output: string[];
  /** The context `activate` received. */
  context(): HostContext;
}

interface StartOptions {
  readonly services?: readonly ServiceEntry[];
  readonly generation?: number;
  readonly incarnation?: number;
  readonly bundleDir?: string;
  readonly activate?: (context: HostContext) => Promise<void> | void;
  /** Read synchronously as soon as the `ActivateResult` arrived. */
  readonly atActivate?: () => readonly string[];
}

interface Env {
  readonly router: Router;
  readonly table: InstanceTable;
  /** Starts and activates `bundleId` in this process. */
  start(bundleId: string, options?: StartOptions): Promise<Started>;
  /**
   * Restarts `core`: its instance `old` becomes `lost`, and the next
   * incarnation starts with `double` and becomes `active`.
   */
  restartCore(old: Started, double: SkillsDouble): Promise<Started>;
  /** Sends `Stop` to `bundle` and waits for its control stream to end. */
  stop(bundle: Started): Promise<void>;
}

const setup = async (t: TestContext): Promise<Env> => {
  const table = new InstanceTable();
  const router = await startRouter({
    index,
    routes: callRoutesOf(resolveSkillsHost()),
    instances: table,
    timings: testTimings,
    diagnostics: {
      health: () => {},
      hostStalled: () => {},
      registrationReplay: () => {},
    },
    onInvalid: () => {},
    onLost: () => {},
  });
  const baseUrl = `http://127.0.0.1:${router.port}`;

  t.after(() => router.close());

  const start: Env['start'] = async (bundleId, options = {}) => {
    const generation = options.generation ?? 1;
    const incarnation = options.incarnation ?? 1;
    const instance = { bundleId, generation, incarnation };
    const { token } = table.issue({ ...instance, version: '1.0.0' });
    const key = instanceKey(instance);
    const logged: Logged[] = [];
    const output: string[] = [];
    let context: HostContext | undefined;

    await startBundle<readonly DescService[]>(
      {
        services: options.services ?? [],
        logSink: () => recordingSink(logged),
        activate: async (received) => {
          context = received;
          await options.activate?.(received);
        },
      },
      {
        env: {
          DORIC_ROUTER_URL: baseUrl,
          DORIC_INSTANCE_TOKEN: token,
          DORIC_BUNDLE_ID: bundleId,
          DORIC_GENERATION: String(generation),
          DORIC_INCARNATION: String(incarnation),
        },
        exit: () => {},
        logOutput: {
          write: (line) => output.push(line),
          writeSync: (line) => output.push(line),
        },
        ...(options.bundleDir === undefined
          ? {}
          : { bundleDir: options.bundleDir }),
      },
    );

    const status = await within(router.sendActivate(key), `activating ${key}`);
    const atActivate = options.atActivate?.() ?? [];

    return {
      key,
      status,
      atActivate,
      logged,
      output,
      context: () => {
        assert.ok(context !== undefined, `${key} is not activated`);

        return context;
      },
    };
  };

  return {
    router,
    table,
    start,
    restartCore: async (old, double) => {
      const record = table.get(old.key);

      assert.ok(record !== undefined);
      table.setState(old.key, 'lost');

      const next = await start('core', {
        generation: record.generation,
        incarnation: record.incarnation + 1,
        services: double.services,
        activate: double.activate,
      });

      assert.equal(next.status.code, 0, next.status.message);

      return next;
    },
    stop: (bundle) =>
      within(router.sendStop(bundle.key), `stopping ${bundle.key}`),
  };
};

/** Starts `core` with `double` as its first instance. */
const startCore = async (env: Env, double: SkillsDouble): Promise<Started> => {
  const core = await env.start('core', {
    services: double.services,
    activate: double.activate,
  });

  assert.equal(core.status.code, 0, core.status.message);

  return core;
};

/** The SKILL.md of `a`: list `allowed-tools`, `alwaysAvailable`, `order`, `indexText`. */
const skillA = `---
name: a
description: Skill a.
allowed-tools: [grep, web]
alwaysAvailable: true
order: 120
indexText: a index
---

# A

Follow a.
`;

/** The SKILL.md of `b`: `allowed-tools` as a space-separated string, nothing else. */
const skillB = `---
name: b
description: Skill b.
allowed-tools: terminal web
---

# B

Follow b.
`;

/** The register `a` answers, as `app/1/1` sends it. */
const registerA: SkillRegister = {
  by: 'app/1/1',
  skill: {
    name: 'a',
    description: 'Skill a.',
    body: '# A\n\nFollow a.',
    allowedTools: ['grep', 'web'],
    indexText: 'a index',
  },
  options: { alwaysAvailable: true, order: 120 },
};

/** The register `b` answers, as `app/1/1` sends it. */
const registerB: SkillRegister = {
  by: 'app/1/1',
  skill: {
    name: 'b',
    description: 'Skill b.',
    body: '# B\n\nFollow b.',
    allowedTools: ['terminal', 'web'],
    indexText: undefined,
  },
  options: { alwaysAvailable: false, order: undefined },
};

const skillsGlob = 'src/skills/*/SKILL.md';

/**
 * Writes the bundle directory of `app` under a temporary root removed after
 * the test: its manifest with `host` (default `host.assets` listing the skill
 * glob) and `files`.
 */
const appDir = async (
  t: TestContext,
  files: Readonly<Record<string, string>>,
  host: Record<string, unknown> = { assets: [skillsGlob] },
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-skills-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return writeBundle(root, 'app', {
    manifest: {
      ...manifest('app', { requires: ['skills/v1@^1.3.0'] }),
      host,
    },
    files,
  });
};

/** Folders `b/`, `a/` and `c-empty/` (no SKILL.md), written in that order. */
const threeFolders = {
  'src/skills/b/SKILL.md': skillB,
  'src/skills/a/SKILL.md': skillA,
  'src/skills/c-empty/README.md': 'not a skill',
};

// ---------------------------------------------------------------------------
// Registration at activation

describe("a bundle's own src/skills at activation", () => {
  test('(a) registers a then b, as the instance, with the frontmatter fields, before ActivateResult', async (t) => {
    const env = await setup(t);
    const double = skillsDouble();

    await startCore(env, double);
    const app = await env.start('app', {
      bundleDir: await appDir(t, threeFolders),
      atActivate: () => registeredNames(double.registers),
    });

    assert.equal(app.status.code, 0, app.status.message);
    assert.deepEqual(app.atActivate, ['app/1/1 a', 'app/1/1 b']);
    assert.deepEqual(double.registers, [registerA, registerB]);

    await env.stop(app);
    assert.deepEqual(skippedOf(app.logged), []);
  });

  test('(b) a Register refused with duplicate_skill skips that skill, logs it, and b still registers', async (t) => {
    const env = await setup(t);
    const double = skillsDouble(
      new Map([
        [
          'a',
          new ContractError(
            'duplicate_skill',
            'Duplicate skill name "a": bundle "other" and bundle "app".',
          ),
        ],
      ]),
    );

    await startCore(env, double);
    const app = await env.start('app', {
      bundleDir: await appDir(t, threeFolders),
      atActivate: () => registeredNames(double.registers),
    });

    assert.equal(app.status.code, 0, app.status.message);
    assert.deepEqual(app.atActivate, ['app/1/1 a', 'app/1/1 b']);

    await until(
      () => skippedOf(app.logged).length > 0,
      'the skill not registered record',
    );
    assert.deepEqual(skippedOf(app.logged), [
      'src/skills/a/SKILL.md duplicate_skill',
    ]);

    const listed = await within(
      app.context().services.use(SkillsService).list({}),
      'the list',
    );

    assert.deepEqual(
      listed.skills.map(({ bundleId, skill }) => `${bundleId} ${skill?.name}`),
      ['app b'],
    );
  });

  test('(c) a SKILL.md whose frontmatter does not parse is skipped and logged, and b registers', async (t) => {
    const env = await setup(t);
    const double = skillsDouble();

    await startCore(env, double);
    const app = await env.start('app', {
      bundleDir: await appDir(t, {
        ...threeFolders,
        'src/skills/a/SKILL.md':
          '---\nname: a\nunknown: 1\n---\n\nNo description.\n',
      }),
    });

    assert.equal(app.status.code, 0, app.status.message);
    assert.deepEqual(double.registers, [registerB]);

    await until(
      () => skippedOf(app.logged).length > 0,
      'the skill not registered record',
    );
    assert.deepEqual(skippedOf(app.logged), ['src/skills/a/SKILL.md']);
  });

  test('(d) host.assets without the skills glob: nothing registered, one warn per skill, activation still answers 0', async (t) => {
    const env = await setup(t);
    const double = skillsDouble();

    await startCore(env, double);
    const app = await env.start('app', {
      bundleDir: await appDir(t, threeFolders, {
        assets: ['src/host/prompts/*.md'],
      }),
    });

    assert.equal(app.status.code, 0, app.status.message);

    await until(
      () => skippedOf(app.logged).length >= 2,
      'two skill not registered records',
    );
    assert.deepEqual(double.registers, []);
    assert.deepEqual(skippedOf(app.logged).sort(), [
      'src/skills/a/SKILL.md',
      'src/skills/b/SKILL.md',
    ]);
    for (const { fields } of app.logged.filter(
      ({ message }) => message === 'skill not registered',
    )) {
      assert.match(String(fields.error), /not listed in host\.assets/u);
    }
  });

  test('(e) without src/skills, or without a bundle directory: no Register and no warn', async (t) => {
    const env = await setup(t);
    const double = skillsDouble();

    await startCore(env, double);
    const bare = await env.start('app', {
      bundleDir: await appDir(t, { 'src/host/other.md': 'not a skill' }),
    });
    const unknown = await env.start('other');

    assert.equal(bare.status.code, 0, bare.status.message);
    assert.equal(unknown.status.code, 0, unknown.status.message);

    await env.stop(bare);
    await env.stop(unknown);

    assert.deepEqual(double.registers, []);
    assert.deepEqual(skippedOf(bare.logged), []);
    assert.deepEqual(skippedOf(unknown.logged), []);
    assert.deepEqual(
      [...bare.output, ...unknown.output].filter((line) =>
        line.includes('skill not registered'),
      ),
      [],
    );
  });

  test('(f) activate rejecting: the activation fails and no skill is registered', async (t) => {
    const env = await setup(t);
    const double = skillsDouble();

    await startCore(env, double);
    const app = await env.start('app', {
      bundleDir: await appDir(t, threeFolders),
      activate: () => {
        throw new ContractError('internal', 'activate failed');
      },
    });

    assert.notEqual(app.status.code, 0);

    await sleep(200);
    assert.deepEqual(double.registers, []);
  });
});

// ---------------------------------------------------------------------------
// The registrations are tracked

describe("a bundle's own skills when skills/v1 gets a new instance", () => {
  test('(g) both skills are replayed to the new instance, as the instance, and listed from it', async (t) => {
    const env = await setup(t);
    const first = skillsDouble();
    const core = await startCore(env, first);
    const app = await env.start('app', {
      bundleDir: await appDir(t, threeFolders),
    });

    assert.equal(app.status.code, 0, app.status.message);
    assert.deepEqual(registeredNames(first.registers), [
      'app/1/1 a',
      'app/1/1 b',
    ]);

    const second = skillsDouble();

    await env.restartCore(core, second);

    const listed = await within(
      app.context().services.use(SkillsService).list({}),
      'the list from the new instance',
    );

    assert.deepEqual(
      listed.skills.map(({ bundleId, skill }) => `${bundleId} ${skill?.name}`),
      ['app a', 'app b'],
    );
    assert.deepEqual(second.registers, [registerA, registerB]);
  });
});

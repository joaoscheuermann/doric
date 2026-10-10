import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import {
  AppHooksV1,
  DoricBundleV1,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  DoricLogV1,
  defineMethod,
  defineService,
  HooksV1,
  type HostContext,
  SkillsV1,
  ToolsV1,
} from '../src/contracts/index.js';
import type { HostPlatform } from '../src/index.js';
import {
  contractsUrl,
  descriptorFor,
  embedded,
  manifest,
  minimalCoreUrl,
  skilledProviderUrl,
  skillSource,
  withRoot,
  writeBundle,
} from './support/fixtures.js';
import {
  fakeTool,
  observeActivations,
  reasonCodes,
  skillNames,
  start,
  states,
  toolNames,
} from './support/host.js';
import { minimalCore } from './support/minimal-core.js';

const usesTools = ['tools/v1@^1.0.0'];
const usesHooks = ['hooks/v1@^1.0.0'];

const toolBundle = (
  id: string,
  tools: readonly string[],
  options: {
    fail?: boolean;
    requires?: readonly string[];
    provides?: readonly string[];
  } = {},
) =>
  embedded(
    manifest(id, {
      requires: [...usesTools, ...(options.requires ?? [])],
      provides: [...(options.provides ?? [])],
    }),
    ({ services }: HostContext) => {
      for (const name of tools) {
        services
          .use(ToolsV1)
          .register(fakeTool(name), { alwaysAvailable: true });
      }

      if (options.fail === true) {
        throw new Error(`${id} failed`);
      }
    },
  );

const diskCore = {
  manifest: minimalCore().manifest,
  descriptor: minimalCore().descriptor,
  host: `export { activate } from ${JSON.stringify(minimalCoreUrl)};\n`,
};

void test('discovers installed bundles and publishes their states in the catalog', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'tooling', {
      manifest: manifest('tooling', {
        requires: usesTools,
        description: 'Tools.',
      }),
      descriptor: descriptorFor(manifest('tooling')),
      host: `import { ToolsV1, bindRegistrant } from ${JSON.stringify(contractsUrl)};
const definition = { name: 'disk-tool', inputSchema: {}, outputSchema: {} };
export const activate = ({ services }) => {
  services.use(ToolsV1).register({
    name: 'disk-tool',
    definition,
    [bindRegistrant]: () => ({ name: 'disk-tool', definition, settings: [], execute: async () => ({}) }),
  }, { alwaysAvailable: false });
};
`,
    });
    await writeBundle(root, 'extra', {
      manifest: manifest('extra'),
      descriptor: descriptorFor(manifest('extra')),
    });
    await writeBundle(root, 'broken', { manifest: { id: 'Broken' } });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'tooling'] },
    });

    assert.equal(platform.mode, 'normal');
    assert.deepEqual(states(platform), {
      broken: 'quarantined',
      extra: 'disabled',
      mincore: 'active',
      tooling: 'active',
    });
    assert.deepEqual(reasonCodes(platform, 'broken'), ['invalid_manifest']);
    assert.deepEqual(toolNames(platform), ['tooling:disk-tool']);
    assert.deepEqual(
      platform.services.use(DoricCatalogV1).get(),
      platform.catalog(),
    );
    assert.equal(
      platform.catalog().bundles.find(({ id }) => id === 'tooling')
        ?.description,
      'Tools.',
    );
    assert.deepEqual(platform.catalog().order, ['mincore', 'tooling']);
    assert.deepEqual(
      platform.services.use(DoricDiagnosticsV1).get().consumers['tools/v1'],
      ['tooling'],
    );

    await platform.stop();
  });
});

void test('a failing activate quarantines only that bundle and undoes its registrations', async () => {
  await withRoot(async (root) => {
    const { platform, log } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        toolBundle('bad', ['bad-tool'], { fail: true }),
        toolBundle('good', ['good-tool']),
        embedded(manifest('future', { engines: '^2.0.0' })),
      ],
    });

    assert.equal(platform.mode, 'normal');
    assert.equal(states(platform).good, 'active');
    assert.deepEqual(reasonCodes(platform, 'bad'), ['activate_failed']);
    assert.deepEqual(reasonCodes(platform, 'future'), ['engines_unsatisfied']);
    assert.deepEqual(toolNames(platform), ['good:good-tool']);
    assert.ok(
      log.lines.some(
        ({ message, fields }) =>
          message === 'Bundle quarantined' && fields.bundleId === 'bad',
      ),
    );

    await platform.stop();
  });
});

void test('a duplicate tool quarantines the registering bundle; the first keeps the name', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        toolBundle('a', ['shared']),
        toolBundle('b', ['shared', 'other']),
      ],
    });

    assert.deepEqual(toolNames(platform), ['a:shared']);
    assert.deepEqual(reasonCodes(platform, 'b'), ['registration_failed']);

    await platform.stop();
  });
});

void test('a refused provide quarantines with its own reason, not activate_failed', async () => {
  await withRoot(async (root) => {
    const methods = {
      ping: defineMethod({
        input: z.tuple([]),
        output: z.literal('pong'),
        execute: () => 'pong' as const,
      }),
    };
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        // Declares nothing, provides own.api/v1 anyway.
        embedded(manifest('undeclared'), ({ services }: HostContext) => {
          services.provide(defineService('own.api/v1', methods));
        }),
        // Declares own.api/v1 as one, provides it as many.
        embedded(
          manifest('divergent', { provides: ['own.api/v1@1.0.0'] }),
          ({ services }: HostContext) => {
            services.provide(
              defineService('own.api/v1', methods, { cardinality: 'many' }),
            );
          },
        ),
        // Its own code fails.
        embedded(manifest('own-code'), () => {
          throw new Error('boom');
        }),
      ],
    });

    assert.deepEqual(reasonCodes(platform, 'undeclared'), [
      'registration_failed',
    ]);
    assert.deepEqual(reasonCodes(platform, 'divergent'), [
      'cardinality_mismatch',
    ]);
    assert.deepEqual(reasonCodes(platform, 'own-code'), ['activate_failed']);

    await platform.stop();
  });
});

const pingService = (id: `${string}/v${number}`) =>
  defineService(id, {
    ping: defineMethod({
      input: z.tuple([]),
      output: z.literal('pong'),
      execute: () => 'pong' as const,
    }),
  });

const providersOf = (platform: HostPlatform, contract: string) =>
  platform
    .catalog()
    .contracts.find(({ id }) => id === contract)
    ?.providers.map(({ bundleId }) => bundleId);

void test('a provider quarantined during activation leaves the published contract', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        embedded(
          manifest('prov', { provides: ['prov.api/v1@1.0.0'] }),
          ({ services }: HostContext) => {
            services.provide(pingService('prov.api/v1'));
            throw new Error('boom');
          },
        ),
        embedded(
          manifest('user', { requires: ['prov.api/v1@^1.0.0'] }),
          () => undefined,
        ),
      ],
    });

    assert.deepEqual(reasonCodes(platform, 'prov'), ['activate_failed']);
    assert.deepEqual(reasonCodes(platform, 'user'), ['dependency_quarantined']);
    assert.deepEqual(providersOf(platform, 'prov.api/v1'), []);
    assert.deepEqual(
      platform.services.use(DoricCatalogV1).get(),
      platform.catalog(),
    );

    await platform.stop();
  });
});

void test('a chosen non-foundation provider that fails to activate leaves its contract without a provider', async () => {
  await withRoot(async (root) => {
    const provider = (id: string, fail: boolean) =>
      embedded(
        manifest(id, { provides: ['x.api/v1@1.0.0'] }),
        ({ services }: HostContext) => {
          services.provide(pingService('x.api/v1'));

          if (fail) {
            throw new Error(`${id} failed`);
          }
        },
      );
    const { platform } = await start({
      bundlesPath: root,
      composition: { providers: { 'x.api/v1': 'xb' } },
      embedded: [
        minimalCore(),
        provider('xa', false),
        provider('xb', true),
        embedded(
          manifest('user', { requires: ['x.api/v1@^1.0.0'] }),
          () => undefined,
        ),
      ],
    });

    assert.equal(platform.mode, 'normal');
    assert.deepEqual(reasonCodes(platform, 'xb'), ['activate_failed']);
    // No fallback to the provider the composition did not choose.
    assert.deepEqual(reasonCodes(platform, 'xa'), ['unchosen_provider']);
    assert.deepEqual(reasonCodes(platform, 'user'), ['dependency_quarantined']);
    assert.deepEqual(providersOf(platform, 'x.api/v1'), []);

    await platform.stop();
  });
});

void test('a bundle whose dependency failed to activate is quarantined in turn', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        toolBundle('provider', [], {
          fail: true,
          provides: ['provider.api/v1@1.0.0'],
        }),
        embedded(
          manifest('consumer', { requires: ['provider.api/v1@^1.0.0'] }),
          () => undefined,
        ),
      ],
    });

    assert.deepEqual(reasonCodes(platform, 'consumer'), [
      'dependency_quarantined',
    ]);

    await platform.stop();
  });
});

void test('onActivateHook sees later activations in order; handler failures only reach diagnostics', async () => {
  await withRoot(async (root) => {
    const seen: string[] = [];
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore({ hookDeadlineMs: 30 }),
        embedded(
          manifest('observer', { requires: usesHooks }),
          observeActivations(seen),
        ),
        embedded(
          manifest('thrower', { requires: usesHooks }),
          ({ services }: HostContext) => {
            services
              .use(HooksV1)
              .use(AppHooksV1)
              .onActivateHook(() => {
                throw new Error('handler broke');
              });
          },
        ),
        embedded(
          manifest('waiter', { requires: usesHooks }),
          ({ services }: HostContext) => {
            services
              .use(HooksV1)
              .use(AppHooksV1)
              .onActivateHook(() => new Promise(() => undefined));
          },
        ),
        embedded(manifest('zlast'), () => undefined),
      ],
    });
    const errors = platform
      .diagnostics()
      .errors.map(({ bundleId, kind }) => `${bundleId}:${kind}`);

    assert.deepEqual(seen, ['observer', 'thrower', 'waiter', 'zlast']);
    assert.deepEqual(Object.values(states(platform)), [
      'active',
      'active',
      'active',
      'active',
      'active',
    ]);
    assert.ok(errors.includes('thrower:hook_handler_failed'));
    assert.ok(errors.includes('waiter:hook_handler_timeout'));

    await platform.stop();
  });
});

void test('a failing core sends the host to recovery and stops activation', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore({ failActivate: true }),
        toolBundle('later', ['t']),
      ],
    });

    assert.equal(platform.mode, 'recovery');
    assert.deepEqual(reasonCodes(platform, 'mincore'), ['activate_failed']);
    assert.equal(states(platform).later, 'inactive');
    assert.match(platform.diagnostics().recovery?.reason ?? '', /mincore/);

    await platform.ready();
    await platform.stop();
  });

  await withRoot(async (root) => {
    const missing = await start({
      bundlesPath: root,
      composition: { core: 'absent', enabled: ['absent'] },
      embedded: [embedded(manifest('later'), () => undefined)],
    });

    assert.equal(missing.platform.mode, 'recovery');
    assert.equal(states(missing.platform).later, 'inactive');
    assert.ok(
      missing.platform.diagnostics().issues.includes('missing bundle absent'),
    );
  });
});

void test('an invalid composition file sends the host to recovery', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'composition.json');

    await writeFile(path, JSON.stringify({ core: 'mincore', enabled: [] }));

    const { platform } = await start({
      bundlesPath: root,
      composition: { path },
    });

    assert.equal(platform.mode, 'recovery');
    assert.match(
      platform.diagnostics().recovery?.reason ?? '',
      /invalid composition/,
    );
  });
});

void test('skills are discovered in lexical directory order and registered for their bundle', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'skilled', {
      manifest: manifest('skilled'),
      descriptor: descriptorFor(manifest('skilled')),
      files: {
        'skills/02-second/SKILL.md': skillSource('second'),
        'skills/01-first/SKILL.md': skillSource('first', {
          alwaysAvailable: true,
        }),
        'skills/notes/README.md': 'not a skill',
      },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'skilled'] },
    });

    assert.deepEqual(await skillNames(platform), [
      'skilled:first:true',
      'skilled:second:false',
    ]);

    await platform.stop();
  });
});

void test('skill failures quarantine the bundle with the matching reason', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'invalid', {
      manifest: manifest('invalid'),
      descriptor: descriptorFor(manifest('invalid')),
      files: { 'skills/x/SKILL.md': 'no frontmatter' },
    });
    await writeBundle(root, 'foreign', {
      manifest: manifest('foreign'),
      descriptor: descriptorFor(manifest('foreign')),
      files: {
        'skills/x/SKILL.md': skillSource('foreign-skill', {
          allowedTools: ['missing-tool'],
        }),
      },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'invalid', 'foreign'] },
      embedded: [toolBundle('good', ['good-tool'])],
    });

    assert.deepEqual(reasonCodes(platform, 'invalid'), ['skill_invalid']);
    assert.deepEqual(reasonCodes(platform, 'foreign'), ['registration_failed']);
    assert.deepEqual(await skillNames(platform), []);

    await platform.stop();
  });

  await withRoot(async (root) => {
    await writeBundle(root, 'skilled', {
      manifest: manifest('skilled'),
      descriptor: descriptorFor(manifest('skilled')),
      files: { 'skills/a/SKILL.md': skillSource('a') },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'skilled'] },
      embedded: [minimalCore({ provides: ['hooks/v1', 'tools/v1'] })],
    });

    assert.deepEqual(reasonCodes(platform, 'skilled'), ['missing_dependency']);

    await platform.stop();
  });
});

void test('skills register after the whole phase, so allowed-tools may name a tool of a later bundle', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'aaa-skills', {
      manifest: manifest('aaa-skills'),
      descriptor: descriptorFor(manifest('aaa-skills')),
      files: {
        'skills/borrow/SKILL.md': skillSource('borrow', {
          allowedTools: ['late-tool'],
        }),
      },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'aaa-skills', 'zzz-tools'] },
      embedded: [toolBundle('zzz-tools', ['late-tool'])],
    });

    assert.equal(states(platform)['aaa-skills'], 'active');
    assert.deepEqual(await skillNames(platform), ['aaa-skills:borrow:false']);

    await platform.stop();
  });
});

void test('the SKILL.md order key reaches skills/v1 with the registration', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'skilled', {
      manifest: manifest('skilled'),
      descriptor: descriptorFor(manifest('skilled')),
      files: {
        'skills/a/SKILL.md': skillSource('ordered', { order: 1200 }),
        'skills/b/SKILL.md': skillSource('unordered'),
      },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'skilled'] },
    });

    assert.deepEqual(
      (await platform.services.use(SkillsV1).list()).map(({ skill, order }) => [
        skill.name,
        order,
      ]),
      [
        ['ordered', 1200],
        ['unordered', undefined],
      ],
    );

    await platform.stop();
  });
});

void test('a skill refused after the phase quarantines its active bundle, withdraws its tools and quarantines its dependents', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'prov', {
      manifest: manifest('prov', {
        requires: usesTools,
        provides: ['prov.api/v1@1.0.0'],
      }),
      descriptor: descriptorFor(
        manifest('prov', { provides: ['prov.api/v1@1.0.0'] }),
      ),
      host: `export { activate } from ${JSON.stringify(skilledProviderUrl)};\n`,
      files: {
        'skills/x/SKILL.md': skillSource('needs-missing', {
          allowedTools: ['prov-tool', 'missing-tool'],
        }),
      },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'prov', 'user'] },
      embedded: [
        embedded(
          manifest('user', { requires: ['prov.api/v1@^1.0.0'] }),
          () => undefined,
        ),
      ],
    });

    assert.equal(platform.mode, 'normal');
    assert.equal(states(platform).prov, 'quarantined');
    assert.deepEqual(reasonCodes(platform, 'prov'), ['registration_failed']);
    assert.match(
      platform.diagnostics().bundles.find(({ id }) => id === 'prov')?.reasons[0]
        ?.message ?? '',
      /Skill "needs-missing" in bundle "prov" references unavailable tool "missing-tool"\./,
    );
    assert.deepEqual(reasonCodes(platform, 'user'), ['dependency_quarantined']);
    assert.deepEqual(toolNames(platform), []);
    assert.deepEqual(await skillNames(platform), []);

    await platform.stop();
  });
});

void test('v0 bundles load current tool definitions and refuse legacy factories', async () => {
  await withRoot(async (root) => {
    const v0 = (
      name: string,
      tools: readonly string[],
      skills: readonly string[] = [],
    ) => ({
      name,
      description: `${name} description`,
      tools: tools.map((tool) => ({
        path: `tools/${tool}.js`,
        alwaysAvailable: true,
      })),
      skills: skills.map((skill) => ({
        path: `skills/${skill}/SKILL.md`,
        alwaysAvailable: false,
      })),
    });

    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'modern', {
      manifest: v0('modern', ['read'], ['inspect']),
      files: {
        'tools/read.js': `import { bindRegistrant } from ${JSON.stringify(contractsUrl)};
const definition = { name: 'read', inputSchema: {}, outputSchema: {} };
export default {
  name: 'read',
  definition,
  [bindRegistrant]: () => ({ name: 'read', definition, settings: [], execute: async () => ({}) }),
};
`,
        'skills/inspect/SKILL.md': skillSource('inspect', {
          allowedTools: ['read'],
        }),
      },
    });
    await writeBundle(root, 'legacy', {
      manifest: v0('legacy', ['old']),
      files: {
        'tools/old.js': `const factory = () => ({});
Object.defineProperty(factory, 'name', { value: 'old' });
export default factory;
`,
      },
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'modern', 'legacy'] },
    });

    assert.deepEqual(toolNames(platform), ['modern:read']);
    assert.deepEqual(await skillNames(platform), ['modern:inspect:false']);
    assert.deepEqual(reasonCodes(platform, 'legacy'), ['invalid_part']);

    await platform.stop();
  });
});

void test('a host part without an activate export is an invalid part', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    await writeBundle(root, 'noexport', {
      manifest: manifest('noexport'),
      descriptor: descriptorFor(manifest('noexport')),
      host: 'export const start = () => undefined;\n',
    });

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'noexport'] },
    });

    assert.deepEqual(reasonCodes(platform, 'noexport'), ['invalid_part']);

    await platform.stop();
  });
});

void test('platform services describe the caller and route log records to the sink', async () => {
  await withRoot(async (root) => {
    let described: unknown;
    const { platform, sink } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        embedded(
          manifest('alpha', { version: '1.2.0' }),
          ({ services }: HostContext) => {
            const me = services.use(DoricBundleV1).describe();

            described = me;
            services.use(DoricLogV1).write({
              level: 'info',
              message: 'hello',
              bundleId: me.bundleId,
              version: me.version,
              generation: me.generation,
              environment: me.environment,
            });
          },
        ),
      ],
    });

    assert.deepEqual(described, {
      bundleId: 'alpha',
      version: '1.2.0',
      generation: platform.generation,
      environment: 'host',
    });
    assert.deepEqual(
      sink.records.map(({ message }) => message),
      ['hello'],
    );

    await platform.stop();
  });
});

void test('ready fires onHostReadyHook once and stop deactivates in reverse order', async () => {
  await withRoot(async (root) => {
    const events: string[] = [];
    const lifecycle = (id: string) =>
      embedded(
        manifest(id, { requires: usesHooks }),
        ({ services }: HostContext) => {
          const hooks = services.use(HooksV1).use(AppHooksV1);

          hooks.onHostReadyHook(() => {
            events.push(`${id}:ready`);
          });
          hooks.onDeactivateHook(({ bundleId }) => {
            events.push(`${id}:sees-deactivate:${bundleId}`);
          });

          return () => {
            events.push(`${id}:cleanup`);
          };
        },
      );
    const first = await start({
      bundlesPath: root,
      composition: {},
      embedded: [minimalCore(), lifecycle('a'), lifecycle('b')],
    });

    await first.platform.ready();
    await first.platform.ready();

    assert.deepEqual(events, ['a:ready', 'b:ready']);

    events.length = 0;
    await first.platform.stop();
    await first.platform.stop();

    assert.deepEqual(events, [
      'a:sees-deactivate:b',
      'b:sees-deactivate:b',
      'b:cleanup',
      'a:sees-deactivate:a',
      'a:cleanup',
    ]);
    assert.equal(states(first.platform).a, 'inactive');

    const second = await start({
      bundlesPath: root,
      composition: {},
      embedded: [minimalCore()],
    });

    assert.ok(second.platform.generation > first.platform.generation);

    await second.platform.stop();
  });
});

void test('the platform call has caller doric, the given scope and a fresh trace', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [minimalCore()],
    });
    const call = platform.call({
      scope: { projectId: 'p', threadId: 't', promptId: 'j' },
    });
    const other = platform.call();

    assert.equal(call.caller.bundleId, 'doric');
    assert.equal(call.caller.generation, platform.generation);
    assert.deepEqual(call.scope, {
      projectId: 'p',
      threadId: 't',
      promptId: 'j',
    });
    assert.notEqual(
      call.trace.traceparent.split('-')[1],
      other.trace.traceparent.split('-')[1],
    );

    await platform.stop();

    assert.equal(call.signal.aborted, true);
  });
});

void test('an unreadable manifest stays quarantined without displacing the bundle that owns the ID', async () => {
  await withRoot(async (root) => {
    await writeBundle(root, 'mincore', diskCore);
    // `agit` holds bundle `git`; the directory `git` has a broken manifest.
    await writeBundle(root, 'agit', {
      manifest: manifest('git', { requires: usesTools }),
      descriptor: descriptorFor(manifest('git')),
      host: `import { ToolsV1, bindRegistrant } from ${JSON.stringify(contractsUrl)};
const definition = { name: 'git-tool', inputSchema: {}, outputSchema: {} };
export const activate = ({ services }) => {
  services.use(ToolsV1).register({
    name: 'git-tool',
    definition,
    [bindRegistrant]: () => ({ name: 'git-tool', definition, settings: [], execute: async () => ({}) }),
  }, { alwaysAvailable: false });
};
`,
    });
    await writeBundle(root, 'git', { manifest: {} });
    await writeFile(join(root, 'git', 'manifest.json'), '{');

    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'git'] },
    });
    const git = platform
      .diagnostics()
      .bundles.filter(({ id }) => id === 'git')
      .map(({ state, reasons }) => [state, reasons.map(({ code }) => code)]);

    assert.deepEqual(git, [
      ['active', []],
      ['quarantined', ['invalid_manifest']],
    ]);
    assert.deepEqual(toolNames(platform), ['git:git-tool']);

    await platform.stop();
  });
});

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';
import { ContractError, isContractError } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { SessionService } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import { WorkspaceService } from 'runtime/contracts/gen/doric/runtime/workspace/v1/workspace_pb.js';

import {
  isOsProbe,
  osLease,
  seedHistory,
  testConfiguration,
} from './support/harness.js';
import { bundleRoot, routed, scope } from './support/router.js';
import {
  callsOf,
  earlier,
  failureOf,
  inspect,
  kernelOf,
  scriptedModel,
  seedSession,
  skills,
  usingTool,
} from './support/router-helpers.js';
import { plain } from './support/router-wire.js';

// `default`'s host part through the router (phase 3, slice S51d, contract §6,
// D1-D8, D19, D20, D29, D30): `executor/v1` served by `createDefaultHost` as
// `src/host/main.ts` serves it, its activation, and the prompt session it
// reaches through `executor.session/v1` only while it serves a call. The
// steers and cancels are in `router-session.test.ts`, the history methods in
// `router-history.test.ts`.

/**
 * A copy of the bundle's assets under a manifest whose `host.assets` lists
 * them (S62's globs), or, with `listed: false`, under a manifest with no
 * `host` entry.
 */
const assetsDirectory = async ({ listed = true } = {}): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'default-assets-'));
  const { host: _host, ...manifest } = JSON.parse(
    await readFile(join(bundleRoot, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;

  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      listed
        ? {
            ...manifest,
            host: {
              assets: ['src/host/prompts/*.md', 'src/host/agents/*.md'],
            },
          }
        : manifest,
    ),
  );
  for (const folder of ['src/host/prompts', 'src/host/agents']) {
    await cp(join(bundleRoot, folder), join(directory, folder), {
      recursive: true,
    });
  }

  return directory;
};

void test('D1 activate installs the assets of host.assets and defines default.hooks/v1, calling no session, model, tool or catalog service', async (t) => {
  const directory = await assetsDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = routed({
    provider: scriptedModel([]).provider,
    readAsset: 'context',
    bundleDir: directory,
  });
  t.after(() => host.router.control.stop());

  await host.activate();

  assert.deepEqual(
    callsOf(host.calls, HooksService).map(({ method, request }) => ({
      method,
      request,
    })),
    [{ method: 'define', request: { contract: 'default.hooks/v1' } }],
  );
  for (const service of [
    SessionService,
    ModelsService,
    ToolsService,
    CatalogService,
  ]) {
    assert.deepEqual(callsOf(host.calls, service), [], service.typeName);
  }
});

void test('D2 activate without host.assets in the manifest rejects naming a prompt asset not listed in host.assets', async (t) => {
  const directory = await assetsDirectory({ listed: false });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = routed({
    provider: scriptedModel([]).provider,
    readAsset: 'context',
    bundleDir: directory,
  });
  t.after(() => host.router.control.stop());

  const error = await failureOf(host.activate());

  assert.match(error.message, /src\/host\/prompts\//);
  assert.match(error.message, /not listed in host\.assets/);
});

void test('D3 activate rejects with the built-in agent error for an invalid built-in file, before defining the hooks', async (t) => {
  const host = routed({
    provider: scriptedModel([]).provider,
    builtInAgents: [
      {
        path: '/doric/agents/Bad Name.md',
        text: '---\ndescription: Bad.\n---\n\nBody.\n',
      },
    ],
  });
  t.after(() => host.router.control.stop());

  const error = await failureOf(host.activate());

  assert.match(
    error.message,
    /^Built-in agent "\/doric\/agents\/Bad Name\.md" is invalid: /,
  );
  assert.deepEqual(callsOf(host.calls, HooksService), []);
});

void test('D3 activate rejects with the hooks/v1.Define failure when Define is refused', async (t) => {
  const host = routed({
    provider: scriptedModel([]).provider,
    define: () => {
      throw new ContractError('unavailable', 'hooks/v1 is not served.');
    },
  });
  t.after(() => host.router.control.stop());

  const error = await failureOf(host.activate());

  assert.ok(isContractError(error), String(error));
  assert.equal(error.code, 'unavailable');
});

void test('D4 before activate Run, Formats and List fail unavailable and no fake is called', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
  });
  t.after(() => host.router.control.stop());
  await host.serveWithoutActivate();

  const failures = [
    await failureOf(host.run('hello')),
    await failureOf(host.executor.formats({})),
    await failureOf(host.agents.list({})),
  ];

  assert.deepEqual(
    failures.map(({ code }) => code),
    ['unavailable', 'unavailable', 'unavailable'],
  );
  assert.deepEqual(host.calls, []);
});

void test('D5 Formats answers default.history/v1 and direct.history/v1 without a session call', async (t) => {
  const host = routed({ provider: scriptedModel([]).provider });
  t.after(() => host.router.control.stop());
  await host.activate();

  const { formats } = await host.executor.formats({});

  assert.deepEqual(formats, ['default.history/v1', 'direct.history/v1']);
  assert.deepEqual(callsOf(host.calls, SessionService), []);
});

void test('D6 a Run answers the model text and records what the kernel records for the same script and history', async (t) => {
  const kernel = kernelOf({
    provider: scriptedModel([{ text: 'answer' }]).provider,
    skills,
  });
  seedHistory(kernel.state, earlier);
  await kernel.run('hello');
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
    skills,
  });
  t.after(() => host.router.control.stop());
  seedSession(host.session, earlier);
  await host.activate();

  const text = await host.run('hello');

  assert.equal(text, 'answer');
  assert.deepEqual(plain(host.session.records), plain(kernel.state.writes));
});

void test('D7 (S51e) every executor.session/v1 call of a Run names its sessionId, comes from default and is made while the Run is in flight; the first is WatchCancel, opened once and cancelled once the Run settled', async (t) => {
  const host = routed({
    provider: usingTool().provider,
    tools: [inspect],
    skills,
  });
  t.after(() => host.router.control.stop());
  seedSession(host.session, earlier);
  await host.activate();

  await host.run('use the tool', { sessionId: 'session-7' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const calls = callsOf(host.calls, SessionService);
  assert.ok(calls.length > 0, 'the Run calls its session');
  for (const call of calls) {
    assert.equal(
      (call.request as { sessionId?: string }).sessionId,
      'session-7',
    );
    assert.equal(call.caller, 'default');
    assert.equal(call.running, true, `${call.method} after the Run settled`);
  }
  assert.equal(calls[0]?.method, 'watchCancel', 'WatchCancel comes first');
  assert.equal(
    calls.filter(({ method }) => method === 'watchCancel').length,
    1,
    'one WatchCancel per Run',
  );
  assert.equal(
    host.session.watches[0]?.signal.aborted,
    true,
    'default cancelled its WatchCancel once the Run settled',
  );
});

void test('D8 every call the fakes receive during a Run carries the Run scope', async (t) => {
  const host = routed({
    provider: usingTool().provider,
    tools: [inspect],
    skills,
    lease: osLease(),
    workspace: { cwd: () => '/workspace' },
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  await host.run('use the tool');

  const during = host.calls.filter(({ running }) => running);
  for (const service of [
    SessionService,
    ModelsService,
    ToolsService,
    HooksService,
    HostConfigService,
    SkillsService,
    LeaseService,
    WorkspaceService,
  ]) {
    assert.ok(
      callsOf(during, service).length > 0,
      `${service.typeName} is called during the Run`,
    );
  }
  for (const call of during) {
    assert.deepEqual(call.scope, scope, `${call.service}.${call.method}`);
  }
});

/** Two providers: the configured one and `second`. */
const twoProviders = () => {
  const configuration = testConfiguration();
  return {
    ...configuration,
    providers: [
      ...configuration.providers,
      {
        id: 'second',
        kind: 'openrouter',
        configuration: {
          endpoint: 'https://second.example.com/api/v1',
          token: 'credential-2',
        },
        models: [{ name: 'second/model', reasonings: ['low', 'high'] }],
      },
    ],
  };
};

void test('D19 a Run reads host-config/v1.Current once', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  await host.run('hello');

  assert.equal(callsOf(host.calls, HostConfigService, 'current').length, 1);
});

void test('D19 a Run of a Thread whose stored execution is unavailable fails thread_execution_unavailable, warns once and calls no model service', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
    configuration: twoProviders(),
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  let thrown: unknown;
  try {
    await host.run('hello', {
      thread: { providerId: 'gone', model: 'second/model' },
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ConnectError, String(thrown));
  assert.equal(thrown.code, Code.FailedPrecondition);
  const error = await failureOf(Promise.reject(thrown));
  assert.equal(error.code, 'thread_execution_unavailable');
  assert.equal(
    error.message,
    'The model "second/model" on provider "gone" is not available for this thread. Choose another model in the conversation footer.',
  );
  assert.equal(
    host.router.logs.filter(
      ({ level, message }) =>
        level === 'warn' && message === 'Thread execution unavailable',
    ).length,
    1,
  );
  assert.deepEqual(callsOf(host.calls, ModelsService), []);
});

void test('D20 a Run resolves the configured model once, before any Stream', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  await host.run('hello');

  const models = callsOf(host.calls, ModelsService).filter(
    ({ method }) => method === 'resolve' || method === 'stream',
  );
  assert.deepEqual(
    models
      .filter(({ method }) => method === 'resolve')
      .map(({ request }) => request),
    [
      {
        providerId: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        effort: 'low',
      },
    ],
  );
  assert.equal(models[0]?.method, 'resolve');
  assert.ok(models.some(({ method }) => method === 'stream'));
});

void test('D20 a refused Resolve fails the Run with its code and streams nothing', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
    resolve: () => {
      throw new ContractError('model_unavailable', 'Not configured.');
    },
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  const error = await failureOf(host.run('hello'));

  assert.equal(error.code, 'model_unavailable');
  assert.deepEqual(callsOf(host.calls, ModelsService, 'stream'), []);
});

void test('D29 a Record failing unavailable fails the Run unavailable', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
  });
  t.after(() => host.router.control.stop());
  host.session.recordFailure = new ContractError(
    'unavailable',
    'Thread persistence failed.',
  );
  await host.activate();

  const error = await failureOf(host.run('hello'));

  assert.equal(error.code, 'unavailable');
});

void test('D30 the first run of a Project describes its sandbox and probes its OS; a second run on the same sandbox only describes it', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'answer' }]).provider,
    lease: osLease(),
  });
  t.after(() => host.router.control.stop());
  await host.activate();
  const probes = () =>
    callsOf(host.calls, LeaseService)
      .filter(
        ({ method, request }) =>
          method === 'describe' ||
          (method === 'exec' && isOsProbe(request as { cmd: string[] })),
      )
      .map(({ method }) => method);

  await host.run('first');
  const first = probes();
  await host.run('second');

  assert.deepEqual(first, ['describe', 'exec']);
  assert.deepEqual(probes().slice(first.length), ['describe']);
});

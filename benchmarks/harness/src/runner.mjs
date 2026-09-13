import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadBundles } from 'bundle';

import { run as runDirect } from '../../../scripts/direct-skills-e2e/flow.mjs';
import { createRuntime as directRuntime } from '../../../scripts/direct-skills-e2e/runtime.mjs';
import { run as runMosaic } from '../../../scripts/mosaic-e2e/flow.mjs';
import { createRuntime as mosaicRuntime } from '../../../scripts/mosaic-e2e/runtime.mjs';
import { workspace } from './workspace.mjs';

/** Execute the current diagnostic flow against a BenchFlow-owned task workspace. */
export const currentRunner = (
  mode,
  {
    profile,
    publish,
    assetRoot = '/opt/doric',
    config = {},
    outputRoot = '/tmp/doric-traces',
  },
) => ({
  async run(request, emit) {
    const runId = randomUUID();
    const directory = join(outputRoot, runId);
    let sequence = 0;
    const persist = (record) =>
      publish({ ...record, runId, agent: mode, sequence: ++sequence });

    await persist({
      at: new Date().toISOString(),
      stage: 'run.started',
      data: { request: request.prompt, cwd: request.cwd },
    });

    const saved = JSON.parse(
      await readFile(join(assetRoot, 'config.json'), 'utf8'),
    );

    const catalog = JSON.parse(
      await readFile(join(assetRoot, 'catalog.json'), 'utf8'),
    );

    const core = (await loadBundles(join(assetRoot, 'bundles'))).find(
      ({ name }) => name === 'core',
    );

    if (!core) {
      throw new Error('Missing core bundle.');
    }

    const settings = { ...saved, ...config };
    const factory = mode === 'direct' ? directRuntime : mosaicRuntime;
    const flow = mode === 'direct' ? runDirect : runMosaic;
    const sandbox = workspace(request.cwd, request.signal);

    await mkdir(directory, { recursive: true });

    const runtime = factory({
      directory,
      sandbox,
      config: settings,
      core,
      provider: profile.provider,
      signal: request.signal,
      onToolEvent: async (event) => {
        if (event.type === 'tool.started') {
          await emit({
            type: 'tool_started',
            callId: event.call.id,
            name: event.call.name,
            input: event.call.payload,
          });
        } else if (event.type === 'tool.finished') {
          await emit({
            type: 'tool_completed',
            callId: event.call.id,
            output: event.result,
          });
        } else {
          await emit({ type: 'tool_failed', callId: event.call.id });
        }
      },
      environment:
        '# Execution environment\n\nWorkspace: ' +
        request.cwd +
        '\nUse the task-provided environment and installed tools. Inspect available executables; respect the task network and file constraints. Skill resources are under /opt/doric/catalog/.',
      onRecord: async (record) => {
        await persist(record);

        await emit({ type: 'status', status: record.stage });
      },
    });
    let result;

    try {
      result = await flow(runtime, {
        request: request.prompt,
        skills: catalog,
      });

      await emit({
        type: 'message_delta',
        delta:
          result.delivery ?? result.result ?? 'Run status: ' + result.status,
      });
    } finally {
      await persist({
        at: new Date().toISOString(),
        stage: 'run.finished',
        data: {
          status: result?.status ?? 'failed',
          cancelled: request.signal.aborted,
          result,
          usage: runtime.usage,
        },
      });

      await writeFile(
        join(directory, 'results.json'),
        JSON.stringify({ result, usage: runtime.usage }, null, 2),
      );

      await emit({
        type: 'status',
        status: 'provider-usage ' + JSON.stringify(runtime.usage),
      });
    }
  },
});

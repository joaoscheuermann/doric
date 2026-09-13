import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEventPublisher } from '../src/events.mjs';
import { startGateway } from '../src/gateway.mjs';
import { currentRunner } from '../src/runner.mjs';

// Deterministic model boundary: structured replies and one real artifact write.
const provider = () => {
  let written = false;

  return {
    metadata: { id: 'fixture' },
    capabilities: {},
    embedding: async () => ({ embedding: [1, 0] }),
    rerank: async () => ({ results: [{ index: 0, relevanceScore: 1 }] }),
    complete: async (request) => {
      const terminal = request.tools.find(({ name }) =>
        name.startsWith('submit_structured_output'),
      );
      const properties = terminal.inputSchema.properties;
      let data;

      if (properties.goals) {
        data = { goals: ['Write result.txt'] };
      } else if (properties.nodes) {
        data = {
          nodes: [
            {
              id: 'deliver',
              goal: 'Write result.txt',
              dependencies: [],
              deliver: true,
            },
          ],
        };
      } else if (properties.criteria) {
        data = { criteria: ['The answer reports completion.'] };
      } else if (properties.decisions) {
        data = {
          decisions: [
            {
              name: 'file-guide',
              decision: 'keep',
              reason: 'Helps write the requested file.',
            },
          ],
        };
      } else if (properties.evaluations) {
        data = {
          decision: 'accept',
          evaluations: [
            {
              criterionId: 'deliver:c1',
              satisfied: true,
              evidence: 'The candidate reports completion.',
              observationIds: [],
            },
          ],
          feedback: 'Accepted',
        };
      } else if (!written) {
        written = true;

        return {
          text: '',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'write-artifact',
              name: 'write',
              arguments: JSON.stringify({
                path: 'result.txt',
                content: 'done',
              }),
            },
          ],
        };
      } else {
        data = properties.status
          ? { status: 'completed', result: 'Completed' }
          : { result: 'Completed' };
      }

      return {
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'submission',
            name: terminal.name,
            arguments: JSON.stringify(data),
          },
        ],
      };
    },
  };
};

for (const mode of ['direct', 'mosaic']) {
  test(
    mode +
      ' retrieves guidance and produces an artifact through the current flow',
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'benchmark-flow-'));

      t.after(() => rm(root, { recursive: true, force: true }));

      const assetRoot = join(root, 'assets');

      await cp('benchmarks/harness/dist/local', assetRoot, { recursive: true });

      const config = JSON.parse(
        await readFile('benchmarks/harness/src/config.json', 'utf8'),
      );

      await writeFile(
        join(assetRoot, 'config.json'),
        JSON.stringify({ ...config, embeddingDimensions: 2 }),
      );

      await writeFile(
        join(assetRoot, 'catalog.json'),
        JSON.stringify([
          { name: 'file-guide', body: 'Write result.txt with the write tool.' },
        ]),
      );

      const events = [];
      const eventsPath = join(root, 'events.jsonl');

      const gateway = await startGateway({
        archive: join(root, 'unused'),
        eventsPath,
        token: 'temporary',
        apiKey: 'unused',
        models: [],
        host: '127.0.0.1',
      });

      t.after(() => gateway.close());

      const publish = createEventPublisher({
        baseUrl: 'http://127.0.0.1:' + gateway.port + '/api/v1',
        apiKey: 'temporary',
      });

      const runner = currentRunner(mode, {
        profile: { provider: provider() },
        publish,
        assetRoot,
        outputRoot: join(root, 'traces'),
      });

      await runner.run(
        {
          prompt: 'Write done to result.txt.',
          cwd: root,
          signal: new AbortController().signal,
        },
        async (event) => {
          if (event.type !== 'status') {
            events.push(event);
          }
        },
      );

      assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'done');

      assert.ok(
        events.some(
          (event) =>
            event.type === 'message_delta' && event.delta === 'Completed',
        ),
      );

      await rm(join(root, 'traces'), { recursive: true });

      const persisted = (await readFile(eventsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      const ranked = persisted.find(
        ({ stage, data }) => stage.startsWith('retrieval.p0') && data.ranked,
      );

      assert.equal(ranked.data.ranked[0].name, 'file-guide');

      assert.equal(ranked.data.ranked[0].score, 1);

      const gate = persisted.find(
        ({ stage, data }) => stage.startsWith('gate') && data.decisions,
      );

      assert.equal(gate.data.decisions[0].decision, 'keep');

      assert.ok(gate.data.decisions[0].reason.length > 0);

      assert.deepEqual(persisted.at(-1).data.result.selectedSkills, [
        'file-guide',
      ]);

      assert.equal(persisted[0].data.request, 'Write done to result.txt.');

      assert.equal(new Set(persisted.map(({ runId }) => runId)).size, 1);

      assert.deepEqual(
        persisted.map(({ sequence }) => sequence),
        Array.from({ length: persisted.length }, (_, index) => index + 1),
      );

      const failingRunner = currentRunner(mode, {
        profile: {
          provider: {
            ...provider(),
            complete: async () => {
              throw new Error('Provider unavailable');
            },
          },
        },
        publish,
        assetRoot,
        outputRoot: join(root, 'failed-traces'),
      });

      await assert.rejects(
        failingRunner.run(
          {
            prompt: 'Second task',
            cwd: root,
            signal: new AbortController().signal,
          },
          async () => {},
        ),
      );

      const afterFailure = (await readFile(eventsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));

      assert.equal(afterFailure.at(-1).stage, 'run.finished');

      assert.equal(afterFailure.at(-1).data.status, 'failed');

      assert.notEqual(afterFailure.at(-1).runId, persisted[0].runId);

      assert.ok(
        events.some(
          (event) =>
            event.type === 'tool_started' && event.input.path === 'result.txt',
        ),
      );
    },
  );
}

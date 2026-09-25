import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { WorkspaceService } from '../src/lib/workspace/types.js';
import { pool, workspace } from './helpers/workspace.js';

const createThread = async (service: WorkspaceService, projectId: string) => {
  const result = await service.threads.create(projectId, 'Thread');
  if (result.status !== 'created') throw new Error('Thread creation failed');
  return result.thread;
};

void test('persists accepted user prompt Markdown with its source', async () => {
  const harness = workspace();
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(),
    execute: () => Promise.resolve('done'),
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  const thread = await createThread(service, project.id);
  const markdown = '# Exact input\n\n- keep **formatting**\n- keep  spaces  ';

  const accepted = await service.threads.prompt(thread.id, markdown);

  if (accepted.status !== 'accepted') assert.fail('Prompt was not accepted');
  const history = await service.threads.events(thread.id, 0);
  const event = history?.events.find(
    ({ promptId, type }) =>
      promptId === accepted.promptId && type === 'prompt.accepted',
  );
  assert.deepEqual(event?.event, {
    type: 'prompt.accepted',
    text: markdown,
    source: { kind: 'user' },
  });
  await service.dispose();
});

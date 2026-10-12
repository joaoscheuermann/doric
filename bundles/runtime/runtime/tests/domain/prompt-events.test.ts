import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkspaceService } from '../../src/host/domain/types.js';
import { createHarness } from './support/harness.js';

/* Ported from agents/doric tests/prompt-events.test.ts (design 57 §13.1). */

const createThread = async (service: WorkspaceService, projectId: string) => {
  const result = await service.threads.create(projectId, 'Thread');
  if (result.status !== 'created') throw new Error('Thread creation failed');
  return result.thread;
};

void test('persists accepted user prompt Markdown with its source', async () => {
  const harness = createHarness();
  const { service } = harness;
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
    queued: false,
  });
  await harness.dispose();
});

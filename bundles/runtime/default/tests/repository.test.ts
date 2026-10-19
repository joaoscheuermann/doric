import assert from 'node:assert/strict';
import test from 'node:test';

import { HooksV1 } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { ProviderRequest } from 'llms';
import type { CwdRepo } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import { DefaultHooksV1 } from '../src/contracts/index.js';
import { systemPromptWith } from '../src/host/executor.js';
import { repositoryPrompt } from '../src/host/prompts/repository.js';
import {
  bundleServices,
  fakeThreadState,
  runPrompt,
  skill,
} from './support/harness.js';

const skills = [skill('sandbox', 'Inspect before reporting.')];

/**
 * A run whose model first calls `enter`, a tool that moves the Thread into a
 * repository the way the `cwd` tool does, when the prompt asks for it, and
 * answers otherwise. The Thread's repository hint is what `cwdRepo` holds.
 */
const harnessOf = (initial: CwdRepo | undefined) => {
  let cwdRepo = initial;
  const requests: ProviderRequest[] = [];
  const owner = createTestServices({ bundle: { id: 'tools-owner' } });
  const enter = defineTool({
    name: 'enter',
    description: 'Move into the repository.',
    input: z.object({}),
    output: z.object({}),
    execute: async () => {
      cwdRepo = 'git';
      return {};
    },
  }).bind(owner.services);
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      const entering =
        requests.length === 1 &&
        String(request.messages.at(-1)?.content).includes('enter');
      yield {
        type: 'response.finished' as const,
        finish: entering
          ? {
              text: 'Entering.',
              finishReason: 'tool_calls' as const,
              toolCalls: [{ id: 'call-1', name: 'enter', arguments: '{}' }],
            }
          : { text: 'done', finishReason: 'stop' as const, toolCalls: [] },
      };
    },
  };
  const services = bundleServices({
    provider,
    skills,
    tools: [{ bundleId: 'tools-owner', alwaysAvailable: false, tool: enter }],
    cwdRepo: () => cwdRepo,
  });

  return {
    services,
    /** The system prompt each model request carried. */
    systems: () => requests.map((request) => request.messages[0]?.content),
    run: async (prompt: string) => {
      await services.activate();
      return runPrompt(services, fakeThreadState(), prompt);
    },
  };
};

void test('adds the coding workflow to the system prompt of a Thread at a repository root', async () => {
  const harness = harnessOf('github');

  await harness.run('fix the bug');

  const [system] = harness.systems();
  assert.ok(String(system).startsWith(systemPromptWith(skills)));
  assert.ok(String(system).includes(repositoryPrompt));
});

void test('sends the plain system prompt for a Thread outside any repository', async () => {
  const harness = harnessOf(undefined);

  await harness.run('fix the bug');

  assert.deepEqual(harness.systems(), [systemPromptWith(skills)]);
});

void test('adds the coding workflow from the next model request once the Thread enters a repository', async () => {
  const harness = harnessOf(undefined);

  await harness.run('enter the repository');

  const [before, after] = harness.systems();
  assert.equal(before, systemPromptWith(skills));
  assert.ok(String(after).includes(repositoryPrompt));
});

void test('sends the system prompt another onBeforeModelRequestHook handler returns', async () => {
  const harness = harnessOf(undefined);
  await harness.services.activate();
  harness.services.harness.services
    .use(HooksV1)
    .use(DefaultHooksV1)
    .onBeforeModelRequestHook(({ system }) => ({
      system: `${system}\n\n# Project rules\n\nUse tabs.`,
    }));

  await runPrompt(harness.services, fakeThreadState(), 'fix the bug');

  assert.deepEqual(harness.systems(), [
    `${systemPromptWith(skills)}\n\n# Project rules\n\nUse tabs.`,
  ]);
});

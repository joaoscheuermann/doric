// `threads`' host part through the router (phase 3, slice S52b, tests
// T1–T12, T14): `activate` registers the eight delegation tools with
// `tools/v1` as the kernel entry did (always available, positions 1000–1650),
// and `core`'s `ToolHandlerService` calls run them over
// `runtime.threads/v1`'s `ThreadsService` and `default.agents/v1`'s
// `AgentsService` under the relayed prompt scope. A tool's text answer is
// compared with the kernel tool's as parsed JSON (key order may differ).

import assert from 'node:assert/strict';
import test from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { AgentDefinition } from 'default/contracts';
import { ThreadsService } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

import { type HarnessOptions, promptScope } from './support/router.js';
import {
  activated,
  callsOf,
  contractErrorOf,
  control,
  execute,
  rejectionOf,
  review,
  threadId,
} from './support/router-fixtures.js';

// T6.
void test('T6: a spawn with no agent, model or effort sends Spawn without options and resolves no agent', async (t) => {
  const h = await activated(t, { control, agents: () => review });

  await execute(h, 'thread-spawn', { prompt: 'task', title: 'Task' });

  assert.deepEqual(h.calls, [
    {
      method: 'spawn',
      request: { prompt: 'task', title: 'Task' },
      scope: promptScope,
    },
  ]);
});

// T7.
void test('T7: a spawn with an agent resolves it under the prompt scope and spawns with its name, source and instructions; its model and effort apply unless the input names its own', async (t) => {
  const tuned: AgentDefinition = {
    ...review,
    source: 'workspace',
    model: 'gpt-5',
    effort: 'low',
  };
  const h = await activated(t, {
    control,
    agents: (name) => (name === 'review' ? tuned : assert.fail(name)),
  });
  const agent = {
    name: 'review',
    source: 'workspace',
    instructions: 'Review it.',
  };

  await execute(h, 'thread-spawn', { prompt: 'task', agent: 'review' });
  await execute(h, 'thread-spawn', {
    prompt: 'task',
    agent: 'review',
    model: 'gpt-5-mini',
    effort: 'high',
  });

  assert.deepEqual(h.calls, [
    { method: 'resolve', request: { name: 'review' }, scope: promptScope },
    {
      method: 'spawn',
      request: {
        prompt: 'task',
        options: { agent, model: 'gpt-5', effort: 'low' },
      },
      scope: promptScope,
    },
    { method: 'resolve', request: { name: 'review' }, scope: promptScope },
    {
      method: 'spawn',
      request: {
        prompt: 'task',
        options: { agent, model: 'gpt-5-mini', effort: 'high' },
      },
      scope: promptScope,
    },
  ]);
});

// T8.
void test('T8: Resolve failing not_found or invalid_definition fails Execute with that error unchanged and spawns nothing', async (t) => {
  for (const failure of [
    new ContractError(
      'not_found',
      'Agent "nope" is not defined. Defined agents: review, explore.',
      { name: 'nope', agents: ['review', 'explore'] },
    ),
    new ContractError(
      'invalid_definition',
      'Agent "nope" is invalid: the description is missing.',
      {
        name: 'nope',
        path: '/workspace/.agents/agents/nope.md',
        reason: 'the description is missing',
      },
    ),
  ]) {
    const h = await activated(t, {
      control,
      agents: () => {
        throw failure;
      },
    });

    const error = contractErrorOf(
      await rejectionOf(
        execute(h, 'thread-spawn', { prompt: 'task', agent: 'nope' }),
      ),
    );

    assert.equal(error.code, failure.code);
    assert.equal(error.message, failure.message);
    assert.deepEqual(error.details, failure.details);
    assert.deepEqual(callsOf(h, 'spawn'), []);
  }
});

// T9.
void test('T9: no AgentsService provider, or one answering unavailable, fails Execute internal with the kernel’s message', async (t) => {
  for (const options of [
    { control },
    {
      control,
      agents: (): AgentDefinition => {
        throw new ContractError('unavailable', 'The agents are restarting.');
      },
    },
  ] satisfies HarnessOptions[]) {
    const h = await activated(t, options);

    const error = contractErrorOf(
      await rejectionOf(
        execute(h, 'thread-spawn', { prompt: 'task', agent: 'review' }),
      ),
    );

    assert.equal(error.code, 'internal');
    assert.equal(error.message, 'Agent types are unavailable in this runtime.');
    assert.deepEqual(callsOf(h, 'spawn'), []);
  }
});

// T10.
void test('T10: Spawn refusing the model names the agent for an agent’s model, and passes the runtime’s error for the input’s model', async (t) => {
  const refusal = new ContractError(
    'invalid_execution',
    'Model "gpt-x" is not offered by the provider.',
    { issue: 'model' },
  );
  const h = await activated(t, {
    control: {
      spawn: async () => {
        throw refusal;
      },
    },
    agents: () => ({ ...review, model: 'gpt-x' }),
  });

  const agentModel = contractErrorOf(
    await rejectionOf(
      execute(h, 'thread-spawn', { prompt: 'task', agent: 'review' }),
    ),
  );

  assert.equal(agentModel.code, 'internal');
  assert.equal(
    agentModel.message,
    `Agent "review" names model "gpt-x", which its parent thread's provider does not list. ${refusal.message}`,
  );

  const inputModel = contractErrorOf(
    await rejectionOf(
      execute(h, 'thread-spawn', {
        prompt: 'task',
        agent: 'review',
        model: 'gpt-x',
      }),
    ),
  );

  assert.equal(inputModel.code, 'invalid_execution');
  assert.equal(inputModel.message, refusal.message);
  assert.deepEqual(inputModel.details, { issue: 'model' });
});

// T11.
void test('T11: a control failing “Thread control is no longer active.” fails Execute FAILED_PRECONDITION with that message', async (t) => {
  const inactive = new ContractError(
    'thread_control_inactive',
    'Thread control is no longer active.',
  );
  const h = await activated(t, {
    control: {
      get: async () => {
        throw inactive;
      },
    },
  });

  const error = await rejectionOf(execute(h, 'thread-get', { threadId }));

  assert.ok(error instanceof ConnectError, `expected a ConnectError: ${error}`);
  assert.equal(error.code, Code.FailedPrecondition);
  assert.equal(contractErrorOf(error).code, 'thread_control_inactive');
  assert.equal(
    contractErrorOf(error).message,
    'Thread control is no longer active.',
  );
});

// T12.
void test('T12: Execute of another name, or of thread-get under a Project, answers not_found and calls no service', async (t) => {
  const h = await activated(t, { control });

  assert.equal(
    contractErrorOf(await rejectionOf(execute(h, 'thread-other', { threadId })))
      .code,
    'not_found',
  );
  assert.equal(
    contractErrorOf(
      await rejectionOf(execute(h, 'thread-get', { threadId }, 'p')),
    ).code,
    'not_found',
  );
  assert.deepEqual(h.calls, []);
});

// T14.
void test('T14: without default.agents/v1 declared, a spawn with an agent fails undeclared_requirement', async (t) => {
  const h = await activated(t, {
    control,
    agents: () => review,
    requires: [ToolsService.typeName, ThreadsService.typeName],
  });

  const error = contractErrorOf(
    await rejectionOf(
      execute(h, 'thread-spawn', { prompt: 'task', agent: 'review' }),
    ),
  );

  assert.equal(error.code, 'undeclared_requirement');
  assert.deepEqual(h.calls, []);
});

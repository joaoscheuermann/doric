import assert from 'node:assert/strict';
import test from 'node:test';

import { toJson } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { HooksService } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { ProviderMessageSchema } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  type ProviderError,
  ProviderErrorObject,
  type ProviderMessage,
  type ProviderRequest,
} from 'llms';
import { attachmentReference } from 'runtime/contracts';
import { SessionService } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';

import { skill, testConfiguration } from './support/harness.js';
import { routed } from './support/router.js';
import {
  callsOf,
  failureOf,
  kernelOf,
  scriptedModel,
  seedSession,
} from './support/router-helpers.js';
import { plain } from './support/router-wire.js';

// `default`'s host part through the router (phase 3, slice S51d, contract §6,
// D14-D18): the run's model is `models/v1`'s (the S43 wire), its failures keep
// their provider shape, attachment images cross as references and every
// request first passes `default.hooks/v1` through `hooks/v1.Run`.

const skills = [skill('sandbox', 'Inspect before reporting.')];

void test('D14 a retryable network_error ending the first stream is retried and the Run finishes with the second answer', async (t) => {
  const host = routed({
    provider: scriptedModel([
      {
        fail: () =>
          new ProviderErrorObject({
            provider: 'provider',
            code: 'network_error',
            message: 'The connection was reset.',
            retryable: true,
            retryAfterMs: 1,
          }),
      },
      { text: 'second answer' },
    ]).provider,
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  assert.equal(await host.run('hello'), 'second answer');
  assert.equal(callsOf(host.calls, ModelsService, 'stream').length, 2);
});

void test('D15 a non-retryable provider error ending the run fails the Run provider_error with the provider’s data', async (t) => {
  const data: ProviderError = {
    provider: 'provider',
    code: 'invalid_request_error',
    message: 'The request is invalid.',
    status: 400,
    retryable: false,
  };
  const host = routed({
    provider: scriptedModel([{ fail: () => new ProviderErrorObject(data) }])
      .provider,
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  let thrown: unknown;
  try {
    await host.run('hello');
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ConnectError, String(thrown));
  assert.equal(thrown.code, Code.FailedPrecondition);
  const error = await failureOf(Promise.reject(thrown));
  assert.equal(error.code, 'provider_error');
  assert.deepEqual(
    (error.details as { providerError?: unknown } | undefined)?.providerError,
    plain(data),
  );
});

/** The Claude shape of an overflow: a generic message, the overflow in the diagnostic. */
const overflowDiagnostic =
  '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}';

void test('D16 a stream error event reading as a context overflow runs the emergency compaction', async (t) => {
  const configuration = {
    ...testConfiguration(),
    execution: {
      maxTurns: 32,
      contextCompaction: {
        enabled: true,
        pressurePercent: 50,
        tailMinMessages: 2,
        summaryMaxChars: 6000,
        // A budget the projection never reaches: only the overflow condenses.
        charBudget: 100_000_000,
      },
    },
  } as ReturnType<typeof testConfiguration>;
  const host = routed({
    configuration,
    provider: {
      metadata: { id: 'provider', name: 'provider' },
      // The summarizer's request is its system prompt and one transcript.
      stream: async function* (request: ProviderRequest) {
        if (request.messages.length === 2) {
          yield {
            type: 'response.finished' as const,
            finish: {
              text: 'summary',
              finishReason: 'stop' as const,
              toolCalls: [],
              replay: [],
            },
          };
          return;
        }
        yield {
          type: 'error' as const,
          error: {
            provider: 'provider',
            code: 'provider_error',
            message: 'Stream error.',
            diagnostic: overflowDiagnostic,
          },
        };
      },
    },
  });
  t.after(() => host.router.control.stop());
  seedSession(host.session, {
    messages: [
      ...Array.from({ length: 20 }, (_, index) => ({
        role: 'user' as const,
        content: `old message ${index} ${'padding '.repeat(25)}`,
      })),
      { role: 'user' as const, content: 'recent' },
    ],
    checkpoints: { 'old-prompt': 20 },
  });
  await host.activate();

  await failureOf(host.run('continue'));

  const types = host.session.records.map(
    ({ event }) => (event as { type?: string } | undefined)?.type,
  );
  assert.equal(types.filter((type) => type === 'compaction.started').length, 1);
  assert.ok(types.includes('compaction.finished'));
});

const catId = `sha256-${'a'.repeat(64)}`;
const cat = {
  id: catId,
  name: 'cat.png',
  mediaType: 'image/png' as const,
  size: 8,
};

/** The image parts of the wire messages of `host`'s first `Stream`, as JSON. */
const wireImages = (host: ReturnType<typeof routed>) =>
  (host.wireMessages[0] ?? [])
    .map(
      (message) =>
        toJson(ProviderMessageSchema, message) as {
          parts?: { parts?: { image?: unknown }[] };
        },
    )
    .flatMap(({ parts }) => parts?.parts ?? [])
    .flatMap(({ image }) => (image === undefined ? [] : [image]));

void test('D17 an attachment reference reaches a model reading images as one DescribeAttachment and an attachment image part, never bytes', async (t) => {
  const host = routed({
    provider: scriptedModel([{ text: 'seen' }]).provider,
    inputModalities: ['text', 'image'],
  });
  t.after(() => host.router.control.stop());
  host.session.attachments.set(catId, cat);
  await host.activate();

  await host.run(
    `Before.\n\n${attachmentReference('cat.png', catId)}\n\nAfter.`,
  );

  assert.deepEqual(
    callsOf(host.calls, SessionService, 'describeAttachment').map(
      ({ request }) => (request as { id: string }).id,
    ),
    [catId],
  );
  assert.deepEqual(wireImages(host), [
    { attachment: { id: catId, mediaType: 'image/png', name: 'cat.png' } },
  ]);
  assert.doesNotMatch(
    JSON.stringify(
      host.wireMessages[0]?.map((message) =>
        toJson(ProviderMessageSchema, message),
      ),
    ),
    /data:/,
  );
});

void test('D17 a model reading no images gets the note naming the image and no DescribeAttachment', async (t) => {
  const model = scriptedModel([{ text: 'seen' }]);
  const host = routed({ provider: model.provider, inputModalities: ['text'] });
  t.after(() => host.router.control.stop());
  host.session.attachments.set(catId, cat);
  await host.activate();

  await host.run(attachmentReference('cat.png', catId));

  assert.deepEqual(
    callsOf(host.calls, SessionService, 'describeAttachment'),
    [],
  );
  assert.deepEqual(wireImages(host), []);
  assert.match(
    JSON.stringify(model.requests[0]?.messages.at(-1)?.content),
    /cat\.png/,
  );
});

void test('D17 a reference the Project does not hold stays text', async (t) => {
  const model = scriptedModel([{ text: 'seen' }]);
  const host = routed({
    provider: model.provider,
    inputModalities: ['text', 'image'],
  });
  t.after(() => host.router.control.stop());
  await host.activate();
  const line = attachmentReference('cat.png', catId);

  await host.run(line);

  assert.deepEqual(wireImages(host), []);
  const content = model.requests[0]?.messages.at(-1)?.content;
  assert.equal(typeof content, 'string');
  assert.ok(String(content).includes(line));
});

/** The system prompt the kernel sends for the same scenario: the hook's input. */
const baseSystem = async (): Promise<string> => {
  const model = scriptedModel([{ text: 'answer' }]);
  await kernelOf({ provider: model.provider, skills }).run('hello');
  return String(model.requests[0]?.messages[0]?.content);
};

/** The system prompt of `request`. */
const systemOf = (request: ProviderRequest | undefined): string =>
  String((request?.messages[0] as ProviderMessage | undefined)?.content);

void test('D18 each model request first runs onBeforeModelRequestHook with the base system prompt and sends the system it answers', async (t) => {
  const base = await baseSystem();
  const model = scriptedModel([
    { calls: [{ name: 'load_skill', arguments: '{"name":"none"}' }] },
    { text: 'answer' },
  ]);
  const host = routed({
    provider: model.provider,
    skills,
    beforeModelRequest: (system) => `${system}\n\nHooked.`,
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  await host.run('hello');

  const runs = callsOf(host.calls, HooksService, 'run');
  assert.equal(
    runs.length,
    callsOf(host.calls, ModelsService, 'stream').length,
  );
  assert.deepEqual(runs[0]?.request, {
    contract: 'default.hooks/v1',
    hook: 'onBeforeModelRequestHook',
    system: base,
  });
  assert.equal(systemOf(model.requests[0]), `${base}\n\nHooked.`);
});

void test('D18 a hook Run without output leaves the base system prompt', async (t) => {
  const base = await baseSystem();
  const model = scriptedModel([{ text: 'answer' }]);
  const host = routed({ provider: model.provider, skills });
  t.after(() => host.router.control.stop());
  await host.activate();

  await host.run('hello');

  assert.equal(systemOf(model.requests[0]), base);
});

void test('D18 a hook Run failing unavailable fails the Run before any model request', async (t) => {
  const model = scriptedModel([{ text: 'answer' }]);
  const host = routed({
    provider: model.provider,
    beforeModelRequest: () => {
      throw new ContractError('unavailable', 'No hooks.');
    },
  });
  t.after(() => host.router.control.stop());
  await host.activate();

  await failureOf(host.run('hello'));

  assert.equal(model.requests.length, 0);
});

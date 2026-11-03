import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';
import type { ProviderContentPart, ProviderRequest } from 'llms';
import { attachmentReference } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import {
  bundleServices,
  fakeThreadState,
  runPrompt,
} from './support/harness.js';

const catId = `sha256-${'a'.repeat(64)}`;
const cat = {
  id: catId,
  name: 'cat.png',
  mediaType: 'image/png' as const,
  size: 8,
  bytes: 'iVBORw0KGgo=',
};
const catUrl = 'data:image/png;base64,iVBORw0KGgo=';

/**
 * A default-agent run whose model answers once, or first calls `show` when the
 * prompt asks for it; every request it was sent is kept. `inputModalities` is
 * what the model's catalog says it reads; absent, the catalog does not say.
 */
const imageHarness = (inputModalities?: readonly string[]) => {
  const requests: ProviderRequest[] = [];
  const state = fakeThreadState();
  const provider = {
    metadata: { id: 'provider', name: 'provider' },
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      yield {
        type: 'response.started' as const,
        provider: { id: 'provider', name: 'provider' },
        model: request.model,
      };
      const first = requests.length === 1;
      const asksForTool = JSON.stringify(request.messages).includes('show it');
      yield {
        type: 'response.finished' as const,
        finish:
          first && asksForTool
            ? {
                text: '',
                finishReason: 'tool_calls' as const,
                toolCalls: [{ id: 'call-1', name: 'show', arguments: '{}' }],
              }
            : { text: 'seen', finishReason: 'stop' as const, toolCalls: [] },
      };
    },
  };
  const owner = createTestServices({ bundle: { id: 'tools-owner' } });
  const show = defineTool({
    name: 'show',
    input: z.object({}),
    output: z.string(),
    resultModalities: ['image'],
    execute: () => attachmentReference('cat.png', catId),
  }).bind(owner.services);
  const count = defineTool({
    name: 'count',
    input: z.object({}),
    output: z.number(),
    execute: () => 1,
  }).bind(owner.services);
  const services = bundleServices({
    provider,
    tools: [
      { bundleId: 'tools-owner', alwaysAvailable: false, tool: show },
      { bundleId: 'tools-owner', alwaysAvailable: false, tool: count },
    ],
    ...(inputModalities === undefined ? {} : { inputModalities }),
  });
  services.activate();

  return { requests, state, services };
};

const lastUserParts = (
  request: ProviderRequest | undefined,
): readonly ProviderContentPart[] | string | undefined =>
  [...(request?.messages ?? [])].reverse().find(({ role }) => role === 'user')
    ?.content;

void test('a reader image reaches the model in its place among the words', async () => {
  const { requests, state, services } = imageHarness();
  state.attach(cat);

  await runPrompt(
    services,
    state,
    `Before.\n\n${attachmentReference('cat.png', catId)}\n\nAfter.`,
  );

  const parts = lastUserParts(requests[0]);
  assert.ok(Array.isArray(parts));
  assert.deepEqual(
    parts.map((part) => part.type),
    ['text', 'image', 'text'],
  );
  const [before, image, after] = parts;
  assert.match(
    before?.type === 'text' ? before.text : '',
    /Before\.[\s\S]*cat\.png/u,
  );
  assert.equal(image?.type === 'image' ? image.imageUrl : undefined, catUrl);
  assert.match(after?.type === 'text' ? after.text : '', /After\./u);
});

void test('the stored history keeps the reference, never the bytes', async () => {
  const { state, services } = imageHarness();
  state.attach(cat);

  await runPrompt(services, state, attachmentReference('cat.png', catId));

  const stored = JSON.stringify(state.parts().messages);
  assert.ok(stored.includes(`doric-attachment:${catId}`));
  assert.equal(stored.includes(cat.bytes), false);
});

void test('a reference the Project does not hold stays text', async () => {
  const { requests, state, services } = imageHarness();
  const line = attachmentReference('cat.png', catId);

  await runPrompt(services, state, line);

  const content = lastUserParts(requests[0]);
  assert.equal(typeof content, 'string');
  assert.ok(String(content).includes(line));
});

void test('an image a tool returns reaches the model with that call result', async () => {
  const { requests, state, services } = imageHarness();
  state.attach(cat);

  await runPrompt(services, state, 'show it');

  const result = requests[1]?.messages.find(
    (message) => message.role === 'tool',
  )?.content;
  assert.ok(Array.isArray(result));
  assert.ok(
    result.some((part) => part.type === 'image' && part.imageUrl === catUrl),
  );
});

const offered = (request: ProviderRequest | undefined) =>
  request?.tools?.map(({ name }) => name) ?? [];

void test('a model whose catalog says it reads no images is not offered a tool whose results are images', async () => {
  const { requests, state, services } = imageHarness(['text']);

  await runPrompt(services, state, 'Hello.');

  assert.equal(offered(requests[0]).includes('show'), false);
  assert.ok(offered(requests[0]).includes('count'));
});

void test('a tool whose results are images is offered to a model that reads images, or whose catalog does not say', async () => {
  for (const modalities of [['text', 'image'], undefined]) {
    const { requests, state, services } = imageHarness(modalities);

    await runPrompt(services, state, 'Hello.');

    assert.ok(offered(requests[0]).includes('show'), String(modalities));
  }
});

void test('a reader image reaches a model that reads no images as a note that names it', async () => {
  const { requests, state, services } = imageHarness(['text']);
  state.attach(cat);

  await runPrompt(
    services,
    state,
    `Before.\n\n${attachmentReference('cat.png', catId)}\n\nAfter.`,
  );

  const content = lastUserParts(requests[0]);
  assert.equal(typeof content, 'string');
  assert.match(String(content), /Before\.[\s\S]*cat\.png[\s\S]*After\./u);
  assert.match(String(content), /not shown/u);
  assert.equal(String(content).includes('doric-attachment:'), false);
  assert.equal(JSON.stringify(requests).includes(cat.bytes), false);
});

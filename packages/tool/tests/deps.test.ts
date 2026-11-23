// A tool's own dependencies (phase 3, slice S50a, tests T1–T4): `defineTool`
// takes a third type parameter `Deps`, the kernel `Services` by default.
// `execute` receives the `deps` the definition was bound to (`bind(deps)`),
// and a definition is `Registrable` with the kernel's `tools/v1` only when
// its `Deps` accepts `Services`.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContractTool, Registrable } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { z } from 'zod';

import {
  defineTool,
  type ToolDefinitionObject,
  ToolErrorObject,
} from '../src/index.js';

const harness = createTestServices({ bundle: { id: 'deps-test' } });
const call = harness.call({ projectId: 'p', threadId: 't', promptId: 'q' });

/** A port a host-part tool reads instead of the kernel `Services`. */
interface GreeterPort {
  readonly prefix: string;
}

const input = z.object({ name: z.string() });
const output = z.object({ greeting: z.string() });

/** One `execute` the greeter definition ran, with what it received. */
interface Seen {
  readonly payload: unknown;
  readonly call: unknown;
  readonly deps: GreeterPort;
}

/** A definition over {@link GreeterPort} that records each execution. */
const greeter = (seen: Seen[] = []) =>
  defineTool({
    name: 'greet',
    input,
    output,
    execute: (payload, received, deps: GreeterPort) => {
      seen.push({ payload, call: received, deps });

      return { greeting: `${deps.prefix} ${payload.name}` };
    },
  });

void test('T1: bind(port).execute(payload, call) runs execute(payload, call, port) and answers its parsed output', async () => {
  const seen: Seen[] = [];
  const port: GreeterPort = { prefix: 'Hello' };

  const result = await greeter(seen).bind(port).execute({ name: 'Ada' }, call);

  assert.deepEqual(result, { greeting: 'Hello Ada' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.payload, { name: 'Ada' });
  assert.equal(seen[0]?.call, call);
  assert.equal(seen[0]?.deps, port);
});

void test('T2: two binds of one definition keep their own deps, also through toTool(call)', async () => {
  const seen: Seen[] = [];
  const definition = greeter(seen);
  const english: GreeterPort = { prefix: 'Hello' };
  const french: GreeterPort = { prefix: 'Bonjour' };
  const first = definition.bind(english);
  const second = definition.bind(french);

  assert.deepEqual(await second.execute({ name: 'Ada' }, call), {
    greeting: 'Bonjour Ada',
  });
  assert.deepEqual(await first.execute({ name: 'Ada' }, call), {
    greeting: 'Hello Ada',
  });
  assert.deepEqual(await first.toTool(call).execute({ name: 'Bo' }), {
    greeting: 'Hello Bo',
  });
  assert.deepEqual(await second.toTool(call).execute({ name: 'Bo' }), {
    greeting: 'Bonjour Bo',
  });
  assert.deepEqual(
    seen.map(({ deps, call: received }) => [deps, received]),
    [
      [french, call],
      [english, call],
      [english, call],
      [french, call],
    ],
  );
});

void test('T3: a port tool with an invalid output throws invalid_output, and check is unchanged', async () => {
  const definition = defineTool({
    name: 'broken',
    input,
    output,
    execute: (_payload, _call, deps: GreeterPort) =>
      ({ greeting: deps.prefix.length }) as unknown as { greeting: string },
  });
  const tool = definition.bind({ prefix: 'Hello' });

  await assert.rejects(tool.execute({ name: 'Ada' }, call), (error: unknown) => {
    assert.ok(error instanceof ToolErrorObject);
    assert.equal(error.data.code, 'invalid_output');
    assert.equal(error.data.toolName, 'broken');
    assert.deepEqual(
      error.data.issues?.map((issue) => issue.path),
      ['greeting'],
    );

    return true;
  });

  assert.deepEqual(tool.check({ name: 'Ada' }), {
    success: true,
    data: { name: 'Ada' },
  });

  const invalid = tool.check({ name: 1 });

  assert.equal(invalid.success, false);
  assert.deepEqual(
    invalid.success ? [] : invalid.issues.map((issue) => issue.path),
    ['name'],
  );
});

void test('T4: only a definition whose Deps accepts Services is registrable with the kernel (compile-time)', () => {
  // Never called: the assertions are the compiler's.
  const assertTypes = (
    port: ToolDefinitionObject<typeof input, typeof output, { x: 1 }>,
    open: ToolDefinitionObject<typeof input, typeof output, unknown>,
    kernel: ToolDefinitionObject<typeof input, typeof output>,
  ) => {
    // @ts-expect-error a tool over a port is not registrable with the kernel.
    const portRegistrable: Registrable<ContractTool> = port;
    const openRegistrable: Registrable<ContractTool> = open;
    const kernelRegistrable: Registrable<ContractTool> = kernel;
    const takesDefault = (
      definition: ToolDefinitionObject<typeof input, typeof output>,
    ) => definition;

    takesDefault(open);
    // `bind(undefined)` binds a tool that reads nothing.
    open.bind(undefined);
    // @ts-expect-error `bind` takes the deps; there is no default.
    open.bind();

    return [portRegistrable, openRegistrable, kernelRegistrable];
  };

  assert.equal(typeof assertTypes, 'function');
});

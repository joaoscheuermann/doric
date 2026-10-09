import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError, isContractError } from '../src/contracts/index.js';
import {
  createErrorClassRegistry,
  decodeError,
  type ErrorClassRegistry,
  encodeError,
} from '../src/runtime/envelope/index.js';

/** What crosses a process: encode, structured clone (IPC), decode. */
const cross = (
  value: unknown,
  classes: ErrorClassRegistry = createErrorClassRegistry(),
): unknown => decodeError(structuredClone(encodeError(value)), classes);

/**
 * What the host's event serialization reads from an error: its own property
 * names in order with their values, plus name, message, stack and cause.
 */
const observed = (value: unknown): unknown => {
  if (!(value instanceof Error)) {
    return value;
  }

  const names = new Set(Object.getOwnPropertyNames(value));

  names.add('name');
  names.add('message');
  names.add('stack');
  names.add('cause');

  return [...names].flatMap((name) => {
    const entry = Reflect.get(value, name);

    return entry === undefined ? [] : [[name, observed(entry)]];
  });
};

void test('a ContractError arrives as a ContractError with its code, message and details', () => {
  const original = new ContractError('duplicate_tool', 'Duplicate tool.', {
    tool: 'read',
  });
  const decoded = cross(original);

  assert.ok(decoded instanceof ContractError);
  assert.ok(isContractError(decoded));
  assert.equal(decoded.code, 'duplicate_tool');
  assert.equal(decoded.message, 'Duplicate tool.');
  assert.deepEqual(decoded.details, { tool: 'read' });
  assert.deepEqual(observed(decoded), observed(original));
});

void test('generic errors keep what the event serialization reads, cause chains included', () => {
  class NamedByPrototype extends Error {}
  Object.defineProperty(NamedByPrototype.prototype, 'name', {
    value: 'NamedByPrototype',
  });

  const cause = new TypeError('inner');
  const named = new NamedByPrototype('outer', { cause });

  (named as unknown as { data: unknown }).data = { status: 503, at: [1, 2] };

  const assigned = new Error('timed out');

  assigned.name = 'TimeoutError';

  const withFunction = new Error('handler');

  (withFunction as unknown as { retry: unknown }).retry = function retry() {
    return undefined;
  };

  for (const original of [new Error('plain'), named, assigned, cause]) {
    assert.deepEqual(observed(cross(original)), observed(original));
  }

  const decodedNamed = cross(named) as Error;

  assert.equal(decodedNamed.name, 'NamedByPrototype');
  assert.ok(!Object.hasOwn(decodedNamed, 'name'));
  assert.ok(decodedNamed instanceof Error);
  assert.ok((decodedNamed as { cause?: unknown }).cause instanceof TypeError);
  assert.equal(
    (cross(withFunction) as unknown as { retry: unknown }).retry,
    '[Function: retry]',
  );
});

void test('a generic error never gains a code property', () => {
  const decoded = cross(new RangeError('out of range'));

  assert.ok(decoded instanceof RangeError);
  assert.ok(!Object.hasOwn(decoded as object, 'code'));
  assert.equal(encodeError(new RangeError('x')).code, 'internal');
});

void test('a registered class keeps instanceof; an unregistered one keeps its name', () => {
  class ToolFailure extends Error {
    override readonly name = 'ToolFailure';
    readonly toolName: string;

    constructor(toolName: string) {
      super(`Tool failed: ${toolName}`);
      this.toolName = toolName;
    }
  }

  const registry = createErrorClassRegistry();

  registry.register(ToolFailure);

  const original = new ToolFailure('read');
  const registered = cross(original, registry);
  const unregistered = cross(original) as Error;

  assert.ok(registered instanceof ToolFailure);
  assert.equal((registered as ToolFailure).toolName, 'read');
  assert.ok(!(unregistered instanceof ToolFailure));
  assert.equal(unregistered.name, 'ToolFailure');
  assert.deepEqual(observed(unregistered), observed(original));
});

void test('thrown non-errors stay what they were', () => {
  assert.equal(cross('boom'), 'boom');
  assert.equal(cross(42), 42);
  assert.equal(cross(undefined), undefined);
  assert.deepEqual(cross({ reason: 'busy' }), { reason: 'busy' });
});

// `RegistrationTable` and `stampedCallerOf` (spec
// `docs/designs/grpc-processes.md`, section 4, "Keys across instances" (D4)
// and "`RegistrationTable`" (A66); T2.19, AC2.8): the provider's table that
// applies D4's key rule, driven through its public methods only, and the
// stamped caller a provider keys registrations by, read from a call that
// `bundle/testing`'s router serves.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';

import { ContractError } from '../../src/contracts/error.js';
import { ToolsService } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  type RegistrationConflictCode,
  RegistrationTable,
  type ServiceEntry,
  type StampedCaller,
  stampedCallerOf,
} from '../../src/sdk/host/index.js';
import { createTestRouter } from '../../src/testing/index.js';

// ---------------------------------------------------------------------------
// Helpers

const caller = (
  bundleId: string,
  generation = 1,
  incarnation = 1,
): StampedCaller => ({ bundleId, version: '1.0.0', generation, incarnation });

const table = (
  conflictCode: RegistrationConflictCode = 'duplicate_tool',
): RegistrationTable<string> => new RegistrationTable<string>({ conflictCode });

/** The entries as `key=value@bundle/generation/incarnation`, in order. */
const listed = (registrations: RegistrationTable<string>): string[] =>
  registrations
    .entries()
    .map(
      ({ key, value, caller: by }) =>
        `${key}=${value}@${by.bundleId}/${by.generation}/${by.incarnation}`,
    );

/** Asserts `action` throws a `ContractError` with `code`. */
const assertConflict = (action: () => unknown, code: string): void => {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ContractError, `not a ContractError: ${error}`);
    assert.equal(error.code, code);

    return true;
  });
};

// ---------------------------------------------------------------------------
// register

describe('RegistrationTable.register', () => {
  test('the conflict code is the one the table was built with', () => {
    assert.equal(table('duplicate_skill').conflictCode, 'duplicate_skill');
    assert.equal(
      table('registration_conflict').conflictCode,
      'registration_conflict',
    );
  });

  test('the same instance and key again replaces the value and keeps the registrationId', () => {
    const registrations = table();

    const first = registrations.register(caller('git'), 'status', 'v1');
    const second = registrations.register(caller('git'), 'status', 'v2');

    assert.equal(second.registrationId, first.registrationId);
    assert.equal(registrations.get('status'), 'v2');
    assert.deepEqual(listed(registrations), ['status=v2@git/1/1']);
  });

  test('another key of the same instance gets another registrationId', () => {
    const registrations = table();

    const status = registrations.register(caller('git'), 'status', 's');
    const diff = registrations.register(caller('git'), 'diff', 'd');

    assert.notEqual(diff.registrationId, status.registrationId);
    assert.deepEqual(listed(registrations), [
      'status=s@git/1/1',
      'diff=d@git/1/1',
    ]);
  });

  test('a newer generation of the same bundle is accepted with a new id and serves', () => {
    const registrations = table();

    const older = registrations.register(caller('git', 2), 'status', 'g2');
    const newer = registrations.register(caller('git', 3), 'status', 'g3');

    assert.notEqual(newer.registrationId, older.registrationId);
    assert.equal(registrations.get('status'), 'g3');
    assert.deepEqual(listed(registrations), ['status=g3@git/3/1']);
  });

  test('the newest generation serves whichever registered first', () => {
    const registrations = table();

    registrations.register(caller('git', 3), 'status', 'g3');
    registrations.register(caller('git', 2), 'status', 'g2');

    assert.equal(registrations.get('status'), 'g3');
    assert.deepEqual(listed(registrations), ['status=g3@git/3/1']);
  });

  test('within a generation the highest incarnation serves, whichever registered first', () => {
    const registrations = table();

    registrations.register(caller('git', 2, 2), 'status', 'i2');
    registrations.register(caller('git', 2, 1), 'status', 'i1');

    assert.equal(registrations.get('status'), 'i2');

    registrations.register(caller('git', 2, 3), 'status', 'i3');

    assert.equal(registrations.get('status'), 'i3');
  });

  test('the generation counts before the incarnation', () => {
    const registrations = table();

    registrations.register(caller('git', 3, 1), 'status', 'g3i1');
    registrations.register(caller('git', 2, 5), 'status', 'g2i5');

    assert.equal(registrations.get('status'), 'g3i1');
    assert.deepEqual(listed(registrations), ['status=g3i1@git/3/1']);
  });

  test('both instances keep their registration: removing the newest lets the older serve', () => {
    const registrations = table();

    registrations.register(caller('git', 2), 'status', 'g2');
    const newer = registrations.register(caller('git', 3), 'status', 'g3');

    assert.equal(registrations.remove(newer.registrationId), true);
    assert.equal(registrations.get('status'), 'g2');
  });

  test('the same key from another bundle throws the table conflict code and changes nothing', () => {
    for (const code of [
      'duplicate_tool',
      'duplicate_skill',
      'registration_conflict',
    ] as const) {
      const registrations = table(code);

      registrations.register(caller('git'), 'status', 'git');
      const before = listed(registrations);

      assertConflict(
        () => registrations.register(caller('mcp'), 'status', 'mcp'),
        code,
      );
      assert.equal(registrations.get('status'), 'git');
      assert.deepEqual(listed(registrations), before);
    }
  });

  test('another bundle conflicts with the serving registration of any generation', () => {
    const registrations = table();

    registrations.register(caller('git', 2), 'status', 'g2');
    registrations.register(caller('git', 3), 'status', 'g3');

    assertConflict(
      () => registrations.register(caller('mcp', 9, 9), 'status', 'mcp'),
      'duplicate_tool',
    );
    assert.deepEqual(listed(registrations), ['status=g3@git/3/1']);
  });

  test('a key freed by its bundle can be registered by another bundle', () => {
    const registrations = table();
    const { registrationId } = registrations.register(
      caller('git'),
      'status',
      'git',
    );

    registrations.remove(registrationId);
    registrations.register(caller('mcp'), 'status', 'mcp');

    assert.equal(registrations.get('status'), 'mcp');
    assert.deepEqual(listed(registrations), ['status=mcp@mcp/1/1']);
  });

  test('the entry carries the caller as register received it', () => {
    const registrations = table();
    const by: StampedCaller = {
      bundleId: 'git',
      version: '3.4.5',
      generation: 7,
      incarnation: 2,
    };

    const { registrationId } = registrations.register(by, 'status', 'v');
    const [entry] = registrations.entries();

    assert.deepEqual(
      { ...entry, caller: { ...entry?.caller } },
      { key: 'status', registrationId, caller: by, value: 'v' },
    );
  });
});

// ---------------------------------------------------------------------------
// remove, dropInstance, get

describe('RegistrationTable.remove', () => {
  test('answers true for a held registration and false for an unknown or removed id', () => {
    const registrations = table();
    const { registrationId } = registrations.register(
      caller('git'),
      'status',
      'v',
    );

    assert.equal(registrations.remove('no-such-id'), false);
    assert.equal(registrations.remove(registrationId), true);
    assert.equal(registrations.remove(registrationId), false);
    assert.equal(registrations.get('status'), undefined);
    assert.deepEqual(registrations.entries(), []);
  });

  test('removing an older instance registration leaves the newest serving', () => {
    const registrations = table();
    const older = registrations.register(caller('git', 2), 'status', 'g2');

    registrations.register(caller('git', 3), 'status', 'g3');

    assert.equal(registrations.remove(older.registrationId), true);
    assert.equal(registrations.get('status'), 'g3');
    assert.deepEqual(listed(registrations), ['status=g3@git/3/1']);
  });
});

describe('RegistrationTable.dropInstance', () => {
  test('removes every registration of the instance; the next newest serves again', () => {
    const registrations = table();

    registrations.register(caller('git', 2), 'status', 'g2');
    registrations.register(caller('git', 3), 'status', 'g3');
    registrations.register(caller('git', 3), 'diff', 'd3');
    registrations.register(caller('mcp'), 'search', 'm');

    registrations.dropInstance({
      bundleId: 'git',
      generation: 3,
      incarnation: 1,
    });

    assert.equal(registrations.get('status'), 'g2');
    assert.equal(registrations.get('diff'), undefined);
    assert.deepEqual(listed(registrations), [
      'status=g2@git/2/1',
      'search=m@mcp/1/1',
    ]);
  });

  test('drops only the instance with the same incarnation', () => {
    const registrations = table();

    registrations.register(caller('git', 3, 1), 'status', 'i1');
    registrations.register(caller('git', 3, 2), 'status', 'i2');

    registrations.dropInstance({
      bundleId: 'git',
      generation: 3,
      incarnation: 1,
    });

    assert.equal(registrations.get('status'), 'i2');

    registrations.dropInstance({
      bundleId: 'git',
      generation: 3,
      incarnation: 2,
    });

    assert.equal(registrations.get('status'), undefined);
  });

  test('an instance without registrations changes nothing', () => {
    const registrations = table();

    registrations.register(caller('git'), 'status', 'v');
    registrations.dropInstance({
      bundleId: 'mcp',
      generation: 1,
      incarnation: 1,
    });
    registrations.dropInstance({
      bundleId: 'git',
      generation: 2,
      incarnation: 1,
    });

    assert.deepEqual(listed(registrations), ['status=v@git/1/1']);
  });

  test('a dropped registration id answers false to remove', () => {
    const registrations = table();
    const { registrationId } = registrations.register(
      caller('git'),
      'status',
      'v',
    );

    registrations.dropInstance({
      bundleId: 'git',
      generation: 1,
      incarnation: 1,
    });

    assert.equal(registrations.remove(registrationId), false);
  });
});

describe('RegistrationTable.get', () => {
  test('answers undefined for a key never registered', () => {
    assert.equal(table().get('status'), undefined);
  });
});

// ---------------------------------------------------------------------------
// entries and ids

describe('RegistrationTable.entries', () => {
  test('one entry per key, in the order the keys were first registered', () => {
    const registrations = table();

    registrations.register(caller('git', 2), 'b', 'b2');
    registrations.register(caller('mcp'), 'a', 'a');
    registrations.register(caller('git', 3), 'b', 'b3');
    registrations.register(caller('git', 2), 'c', 'c2');
    registrations.register(caller('git', 2), 'b', 'b2-again');

    assert.deepEqual(listed(registrations), [
      'b=b3@git/3/1',
      'a=a@mcp/1/1',
      'c=c2@git/2/1',
    ]);
  });

  test('a key no longer held leaves the order; registered again it comes last', () => {
    const registrations = table();
    const a = registrations.register(caller('git'), 'a', 'a');

    registrations.register(caller('git'), 'b', 'b');
    registrations.remove(a.registrationId);

    assert.deepEqual(listed(registrations), ['b=b@git/1/1']);

    registrations.register(caller('git'), 'a', 'a-again');

    assert.deepEqual(listed(registrations), [
      'b=b@git/1/1',
      'a=a-again@git/1/1',
    ]);
  });

  test('the serving entry carries its own registrationId', () => {
    const registrations = table();

    registrations.register(caller('git', 2), 'status', 'g2');
    const newer = registrations.register(caller('git', 3), 'status', 'g3');

    assert.equal(
      registrations.entries()[0]?.registrationId,
      newer.registrationId,
    );
  });

  test('answers a new array on each call', () => {
    const registrations = table();

    registrations.register(caller('git'), 'status', 'v');
    const first = registrations.entries();
    const second = registrations.entries();

    assert.notEqual(first, second);
    assert.deepEqual(first, second);

    registrations.register(caller('git'), 'diff', 'd');

    assert.equal(first.length, 1);
  });
});

describe('registrationId', () => {
  test('is never answered again for another registration', () => {
    const registrations = table();
    const ids = new Set<string>();

    for (let round = 0; round < 3; round += 1) {
      for (const key of ['a', 'b', 'c']) {
        const { registrationId } = registrations.register(
          caller('git', round + 1),
          key,
          `${key}${round}`,
        );

        assert.equal(
          ids.has(registrationId),
          false,
          `${registrationId} reused`,
        );
        ids.add(registrationId);
      }

      registrations.dropInstance({
        bundleId: 'git',
        generation: round + 1,
        incarnation: 1,
      });
    }

    const removed = registrations.register(caller('git', 9), 'z', 'z');

    registrations.remove(removed.registrationId);
    const again = registrations.register(caller('git', 9), 'z', 'z');

    assert.notEqual(again.registrationId, removed.registrationId);
    assert.equal(ids.has(again.registrationId), false);
  });
});

// ---------------------------------------------------------------------------
// stampedCallerOf

describe('stampedCallerOf', () => {
  test('answers the call caller with incarnation 1 in a call bundle/testing serves', async () => {
    const seen: StampedCaller[] = [];
    const tools: Partial<ServiceImpl<typeof ToolsService>> = {
      register: (_request, context: HandlerContext) => {
        seen.push({ ...stampedCallerOf(context) });

        return { registrationId: 'r1' };
      },
    };
    const router = createTestRouter({
      caller: { bundleId: 'git', version: '2.0.0', generation: 4 },
    });

    await router.activate<readonly DescService[]>({
      services: [
        [
          ToolsService,
          tools as ServiceImpl<typeof ToolsService>,
        ] as ServiceEntry,
      ],
      activate: () => {},
    });
    await router.client(ToolsService).register({
      tool: {
        name: 'status',
        definition: { name: 'status', inputSchema: '{}', outputSchema: '{}' },
      },
      options: {},
    });

    assert.deepEqual(seen, [
      { bundleId: 'git', version: '2.0.0', generation: 4, incarnation: 1 },
    ]);
  });

  test('throws a TypeError for a context that is not a served call', () => {
    const context = {
      values: { get: () => undefined },
    } as unknown as HandlerContext;

    assert.throws(() => stampedCallerOf(context), TypeError);
  });
});

/**
 * Generations over `TestEngine.storage` (T4.24, A81): each case runs on
 * `V2Harness.fresh()`, an engine that remembers no generation, since
 * `reset()` keeps the shared engine's highest one. Generation 2 registers
 * `Thread` with the one index `byCreated`; generation 1 the conformance
 * files as they are. `registration.ts` runs them after REG1–REG5.
 */
import assert from 'node:assert/strict';

import type { Storage } from '../../client/types.js';
import { idsOf, state, thread, threadPut, threadsWith } from './fixtures.js';
import {
  caseGroup,
  conformanceBundle,
  conformanceFiles,
  type V2Case,
  type V2Harness,
} from './harness.js';
import { indexKeys, isCode } from './support.js';

const registration = caseGroup('registration');

/** Generation 2's declaration of `Thread`: only `byCreated`. */
const second = () =>
  threadsWith([{ name: 'byCreated', fields: ['createdAt'] }]);

/** Generation 1, with `t1` and `t2` stored, then generation 2 registered. */
const drained = async (
  harness: V2Harness,
): Promise<{ old: Storage; next: Storage; fresh: V2Harness }> => {
  const fresh = await harness.fresh();
  const old = await fresh.open(conformanceBundle, conformanceFiles, 1);

  await old.commit({
    put: [
      threadPut('t1', { projectId: 'p1', createdAt: 'b' }),
      threadPut('t2', { projectId: 'p1', createdAt: 'a' }),
    ],
  });

  const next = await fresh.open(conformanceBundle, second(), 2);

  return { old, next, fresh };
};

const created = (storage: Storage) =>
  idsOf(storage, { type: thread, index: 'byCreated', equals: [] });

const byProject = (storage: Storage) =>
  idsOf(storage, { type: thread, index: 'byProject', equals: ['p1'] });

/** GEN1–GEN3, group `registration`, each on its own fresh engine. */
export const generationCases: readonly V2Case[] = [
  registration(
    'GEN1',
    "generation 2's registration replaces generation 1's declarations",
    async (harness) => {
      const { next } = await drained(harness);

      assert.deepEqual(await created(next), ['t2', 't1']);
      await assert.rejects(byProject(next), isCode('invalid_input'));
    },
  ),
  registration(
    'GEN2',
    "a put by generation 1 after generation 2 registered is indexed with generation 2's indexes",
    async (harness) => {
      const { old, next, fresh } = await drained(harness);

      await old.commit({
        put: [threadPut('t3', { projectId: 'p1', createdAt: 'c' })],
      });
      assert.deepEqual(await created(next), ['t2', 't1', 't3']);
      await assert.rejects(byProject(old), isCode('invalid_input'));
      assert.deepEqual(
        [
          ...new Set(
            (
              await indexKeys(
                fresh.engine.kv('doric'),
                conformanceBundle,
                thread,
              )
            ).map((entry) => entry.index),
          ),
        ],
        ['byCreated'],
      );
    },
  ),
  registration(
    'GEN3',
    'a later registration by generation 1 changes nothing',
    async (harness) => {
      const { next, fresh } = await drained(harness);
      const before = await state(fresh);

      await fresh.open(conformanceBundle, conformanceFiles, 1);
      assert.deepEqual(await state(fresh), before);
      assert.deepEqual(await created(next), ['t2', 't1']);
      await assert.rejects(byProject(next), isCode('invalid_input'));
    },
  ),
];

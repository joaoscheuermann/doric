// S57 D1, D2, D10, D28: `createLibraryOperations(ports, programs)`, the
// per-Thread entries over fake ports — a Thread log the cwd appends write
// to — and a fake programs host whose last answer for every `cwd` is a
// failure ("boom").
//
// Contract matrix:
// - `promptStarted`: reads the rows after the cursor with the call, appends
//   `papercraft.cwd/v1` under the prompt's scope with the call when `cwd`
//   differs from the last binding, and nothing when it does not; before the
//   skill is loaded, no instruct and no library job; once a `load_skill` of
//   `papercraft` is in the log, the library instruct (retained, reason
//   `library`, under the prompt) with the call, then `libraryFor`; a failed
//   log read ends it, a failed append is swallowed — it never rejects;
// - `cwdChanged`: nothing without a `promptId`; with one, the append and no
//   library job;
// - `cwdAt`: reads past the cursor with the call and answers the binding
//   below `turnSequence`, as `bindingAt` does.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Call, ContractError } from 'bundle/contracts';

import type { LibraryAnswer } from '../src/contracts/index.js';
import { createLibraryOperations } from '../src/host/library.js';
import type {
  LibraryInstruct,
  PapercraftPorts,
  PapercraftRow,
} from '../src/host/ports.js';
import type { ProgramOperations } from '../src/host/programs.js';

const call = {
  scope: { projectId: 'p1', threadId: 't1', promptId: 'q1' },
} as unknown as Call;

const SKILL_LOADED: Omit<PapercraftRow, 'sequence'> = {
  type: 'tool.started',
  event: { call: { name: 'load_skill', payload: { name: 'papercraft' } } },
};

/** Ports over one in-memory Thread log; each kind of call is recorded. */
const portsOver = (
  rows: Omit<PapercraftRow, 'sequence'>[] = [],
  options: { readonly failRead?: boolean; readonly failAppend?: boolean } = {},
) => {
  const log: PapercraftRow[] = rows.map((row, index) => ({
    ...row,
    sequence: index + 1,
  }));
  const reads: { threadId: string; after: number; call?: Call }[] = [];
  const appends: { scope: unknown; cwd: string; call?: Call }[] = [];
  const instructs: { input: LibraryInstruct; call?: Call }[] = [];

  const ports: Pick<PapercraftPorts, 'threads' | 'appendCwd'> = {
    threads: {
      eventsAfter: (threadId, after, given) => {
        reads.push({
          threadId,
          after,
          ...(given === undefined ? {} : { call: given }),
        });
        if (options.failRead === true) {
          return Promise.reject(new ContractError('unavailable', 'no log'));
        }

        return Promise.resolve({
          events: log.filter((row) => row.sequence > after),
          lastSequence: log.at(-1)?.sequence ?? 0,
        });
      },
      instruct: (input, given) => {
        instructs.push({
          input,
          ...(given === undefined ? {} : { call: given }),
        });
        return Promise.resolve({ status: 'steered', promptId: input.promptId });
      },
    },
    appendCwd: (scope, cwd, given) => {
      appends.push({
        scope,
        cwd,
        ...(given === undefined ? {} : { call: given }),
      });
      if (options.failAppend === true) {
        return Promise.reject(new ContractError('invalid_scope', 'no sink'));
      }
      log.push({
        sequence: (log.at(-1)?.sequence ?? 0) + 1,
        type: 'papercraft.cwd/v1',
        event: { cwd },
      });

      return Promise.resolve();
    },
  };

  return { ports, log, reads, appends, instructs };
};

/** A programs host whose last answer for every `cwd` is the failure "boom". */
const programsFake = () => {
  const jobs: { projectId: string; cwd: string }[] = [];
  const programs: Pick<
    ProgramOperations,
    'libraryFor' | 'lastAnswerOf' | 'memoOf'
  > = {
    libraryFor: (projectId, cwd) => {
      jobs.push({ projectId, cwd });
      return Promise.resolve<LibraryAnswer>({ status: 'none' });
    },
    lastAnswerOf: () => ({ failed: 'boom' }),
    memoOf: () => undefined,
  };

  return { programs, jobs };
};

const started = (cwd: string, promptId = 'q1') => ({
  projectId: 'p1',
  threadId: 't1',
  promptId,
  cwd,
});

describe('createLibraryOperations', () => {
  describe('promptStarted', () => {
    test("reads the log with the call and appends the cwd under the prompt's scope", async () => {
      const world = portsOver();
      const operations = createLibraryOperations(
        world.ports,
        programsFake().programs,
      );

      await operations.promptStarted(started('/w/app'), call);

      assert.deepEqual(world.reads, [{ threadId: 't1', after: 0, call }]);
      assert.deepEqual(world.appends, [
        {
          scope: { projectId: 'p1', threadId: 't1', promptId: 'q1' },
          cwd: '/w/app',
          call,
        },
      ]);
    });

    test('appends nothing when the cwd is the last bound one', async () => {
      const world = portsOver();
      const operations = createLibraryOperations(
        world.ports,
        programsFake().programs,
      );

      await operations.promptStarted(started('/w/app'), call);
      await operations.promptStarted(started('/w/app', 'q2'), call);

      assert.equal(world.appends.length, 1);
    });

    test('gives no instruct and starts no library job before the skill is loaded', async () => {
      const world = portsOver();
      const { programs, jobs } = programsFake();
      const operations = createLibraryOperations(world.ports, programs);

      await operations.promptStarted(started('/w/app'), call);

      assert.deepEqual(world.instructs, []);
      assert.deepEqual(jobs, []);
    });

    test('once the skill is loaded, gives the library instruct with the call, then starts the library job', async () => {
      const world = portsOver([SKILL_LOADED]);
      const { programs, jobs } = programsFake();
      const operations = createLibraryOperations(world.ports, programs);

      await operations.promptStarted(started('/w/app', 'q2'), call);

      assert.deepEqual(world.instructs, [
        {
          input: {
            id: 't1',
            prompt: 'The repository library could not be checked: boom',
            reason: 'library',
            promptId: 'q2',
            retain: true,
          },
          call,
        },
      ]);
      assert.deepEqual(jobs, [{ projectId: 'p1', cwd: '/w/app' }]);
    });

    test('resolves without appending when the log read fails', async () => {
      const world = portsOver([], { failRead: true });
      const operations = createLibraryOperations(
        world.ports,
        programsFake().programs,
      );

      await operations.promptStarted(started('/w/app'), call);

      assert.deepEqual(world.appends, []);
    });

    test('resolves when the append is refused', async () => {
      const world = portsOver([], { failAppend: true });
      const operations = createLibraryOperations(
        world.ports,
        programsFake().programs,
      );

      await operations.promptStarted(started('/w/app'), call);

      assert.equal(world.appends.length, 1);
    });
  });

  describe('cwdChanged', () => {
    test('does nothing without a promptId', async () => {
      const world = portsOver([SKILL_LOADED]);
      const { programs, jobs } = programsFake();
      const operations = createLibraryOperations(world.ports, programs);

      await operations.cwdChanged(
        { projectId: 'p1', threadId: 't1', cwd: '/w/other' },
        call,
      );

      assert.deepEqual(world.reads, []);
      assert.deepEqual(world.appends, []);
      assert.deepEqual(jobs, []);
    });

    test('appends the new cwd with a promptId and starts no library job', async () => {
      const world = portsOver([SKILL_LOADED]);
      const { programs, jobs } = programsFake();
      const operations = createLibraryOperations(world.ports, programs);

      await operations.cwdChanged(
        { projectId: 'p1', threadId: 't1', promptId: 'q3', cwd: '/w/other' },
        call,
      );

      assert.deepEqual(
        world.appends.map(({ scope, cwd }) => ({ scope, cwd })),
        [
          {
            scope: { projectId: 'p1', threadId: 't1', promptId: 'q3' },
            cwd: '/w/other',
          },
        ],
      );
      assert.deepEqual(jobs, []);
    });
  });

  describe('cwdAt', () => {
    test('reads past the cursor with the call and answers the binding below turnSequence', async () => {
      const world = portsOver([
        { type: 'papercraft.cwd/v1', event: { cwd: '/w/a' } },
        { type: 'message.user', event: {} },
        { type: 'papercraft.cwd/v1', event: { cwd: '/w/b' } },
      ]);
      const operations = createLibraryOperations(
        world.ports,
        programsFake().programs,
      );

      const cwd = await operations.cwdAt(
        { projectId: 'p1', threadId: 't1' },
        3,
        call,
      );

      assert.equal(cwd, '/w/a');
      assert.deepEqual(world.reads, [{ threadId: 't1', after: 0, call }]);
      assert.equal(operations.bindingAt('t1', 4), '/w/b');
    });
  });
});

// T3.13's chat case (slice S65a; spec `docs/designs/grpc-processes.md`,
// section 13, "The window from phase 3 to phase 5", and T3.13): the chat's
// client part shows a Thread over the generated `runtime.threads/v1` client
// and the window's Connect path (`doric:connect` through main's relay to the
// harness's Connect fake), and when the `WatchThread` stream ends with
// `generation_lost` (a restart of `runtime`) the client opens it again and
// the view shows the new opening's snapshot. The other host contracts stay
// on the Socket.IO fake until their slices.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ContractError, toConnectError } from 'bundle/contracts';
import type { WebContents } from 'electron';

import { workspaceDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
  until,
} from './support/harness';
import { go, waitFor } from './support/shell-page';
import {
  serveWorkspaceConnect,
  type WorkspaceConnect,
} from './support/workspace-connect';
import { ANSWER } from './support/workspace-content';
import {
  logOf,
  PLAN,
  serveWorkspace,
  THREAD_PATH,
} from './support/workspace-host';

/** The answer the Thread's log reads after the restart. */
const RESTARTED = 'The snapshot after the restart of runtime.';

/** `row`'s event with every string equal to `ANSWER` replaced. */
const restarted = (row: ReturnType<typeof logOf>[number]) => ({
  ...row,
  event: Object.fromEntries(
    Object.entries(row.event).map(([key, value]) => [
      key,
      value === ANSWER ? RESTARTED : value,
    ]),
  ),
});

describe('the chat over Connect (T3.13)', () => {
  let host: FakeHost;
  let booted: Booted;
  let connect: WorkspaceConnect;
  let contents: WebContents;

  const text = () =>
    page<string>(contents, 'document.body ? document.body.innerText : ""');

  /** What the window got, printed when a wait times out. */
  const diagnose = async (): Promise<string> =>
    JSON.stringify(
      {
        connect: [...new Set(connect.calls)],
        envelope: [
          ...new Set(
            host.calls.map((call) => `${call.contract} ${call.method}`),
          ),
        ],
        logs: booted.logs.filter((entry) => entry.level !== 'info'),
        text: (await text()).slice(0, 1500),
      },
      null,
      2,
    );

  const planWatches = () =>
    connect.watches.filter(({ request }) => request.threadId === PLAN.id);

  before(async () => {
    host = await startFakeHost(await workspaceDistribution());
    serveWorkspace(host);
    connect = serveWorkspaceConnect();
    booted = await bootPlatform({
      host,
      shell: 'renderer',
      hostForward: connect.forward,
    });
    contents = (await booted.window('workspace')).webContents;
    await waitFor(contents, 'Account');
  });

  after(async () => {
    await booted?.dispose().catch(() => undefined);
    await host?.close();
  });

  test('a stream ended with generation_lost is opened again, and the view shows the snapshot again', async () => {
    await go(contents, THREAD_PATH);

    await until(
      () => planWatches().some((opening) => !opening.closed) || undefined,
      'the chat to open ThreadsService.WatchThread',
    ).catch(async (error: unknown) => {
      console.log(await diagnose());
      throw error;
    });
    await until(
      async () => (await text()).includes(ANSWER) || undefined,
      "the Thread's answer from the first snapshot",
    ).catch(async (error: unknown) => {
      console.log(await diagnose());
      throw error;
    });

    // `runtime` restarts: the next opening reads the log as it is now.
    connect.replaceLog(PLAN.id, logOf(PLAN.id).map(restarted));
    const [first] = planWatches().filter((opening) => !opening.closed);
    assert.ok(first !== undefined);
    first.end(
      toConnectError(
        new ContractError('generation_lost', 'Generation 1 exited.'),
      ),
    );

    await until(
      () => planWatches().length >= 2 || undefined,
      'the client to open WatchThread again',
    );
    await until(
      async () => (await text()).includes(RESTARTED) || undefined,
      'the view to show the new snapshot',
    ).catch(async (error: unknown) => {
      console.log(await diagnose());
      throw error;
    });

    assert.equal(planWatches()[1]?.request.threadId, PLAN.id);
    assert.deepEqual(
      host.calls.filter(
        ({ contract }) =>
          contract === 'runtime.threads/v1' || contract === 'runtime/v2',
      ),
      [],
      'no runtime host call on the envelope',
    );
  });
});

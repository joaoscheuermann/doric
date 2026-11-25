// T3.13's settings case (slice S65c; spec `docs/designs/grpc-processes.md`,
// section 13, "The window from phase 3 to phase 5", and T3.13): `settings`
// lists the credentials over `secrets/v1` — the settings client part calls
// the generated `SecretsService.List` through the window's Connect path
// (`doric:connect`, main's relay, the harness's Connect fake), and no
// `secrets/v1` call reaches the Socket.IO envelope.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

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
import { serveSettingsConnect } from './support/settings-host';
import { waitFor } from './support/shell-page';
import {
  serveWorkspaceConnect,
  type WorkspaceConnect,
} from './support/workspace-connect';
import { serveWorkspace } from './support/workspace-host';

describe('the settings over Connect (T3.13)', () => {
  let host: FakeHost;
  let booted: Booted;
  let connect: WorkspaceConnect;
  /** The settings services' calls, `<Service>/<Method>`, in order. */
  const settingsCalls: string[] = [];

  before(async () => {
    host = await startFakeHost(await workspaceDistribution());
    serveWorkspace(host);
    connect = serveWorkspaceConnect({
      routes: (router) =>
        serveSettingsConnect(router, (method) => settingsCalls.push(method)),
    });
    booted = await bootPlatform({
      host,
      shell: 'renderer',
      hostForward: connect.forward,
    });
    const workspace = (await booted.window('workspace')).webContents;
    await waitFor(workspace, 'Account');
  });

  after(async () => {
    await booted?.dispose().catch(() => undefined);
    await host?.close();
  });

  test('settings lists the credentials over SecretsService.List, and none over the envelope', async () => {
    await booted.platform.runCommand('core.open-settings/v1', {
      defaultPath: '/settings/credentials',
    });
    const settings: WebContents = (await booted.window('settings')).webContents;
    const text = () =>
      page<string>(settings, 'document.body ? document.body.innerText : ""');

    await until(
      async () =>
        ((await text()).includes('OpenRouter key') &&
          (await text()).includes('OpenAI key')) ||
        undefined,
      'the credentials section to list the stored credentials',
    ).catch(async (error: unknown) => {
      console.log(
        JSON.stringify(
          {
            connect: settingsCalls,
            envelope: [
              ...new Set(
                host.calls.map((call) => `${call.contract} ${call.method}`),
              ),
            ],
            text: (await text()).slice(0, 1500),
          },
          null,
          2,
        ),
      );
      throw error;
    });

    assert.ok(
      settingsCalls.includes('SecretsService/List'),
      'the settings part never called SecretsService.List',
    );
    assert.deepEqual(
      host.calls.filter(({ contract }) => contract === 'secrets/v1'),
      [],
      'a secrets/v1 call on the envelope',
    );
  });
});

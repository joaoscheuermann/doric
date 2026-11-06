// The canvas window's route: it must stand alone, so the workspace layout
// never mounts around the canvas and never rewrites the window's path to the
// Thread its restored selection names.
//
// PC16, PC29 (papercraft-openui.md D26): one route for both kinds of canvas,
// `/papercraft/:projectId/:threadId/:identity`. A segment that is a UUID
// naming an artifact of the Thread opens that artifact's canvas, as every
// path saved before stage 2 does; any other segment is a papercraft identity
// whose revisions the window reads through `chat.views/v1.watchFences`. The
// window key is the canvas id, so one identity in two Threads is two windows,
// and `papercraft.open-canvas/v1` 1.1.0 still takes a 1.0.0 input.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

import type { Call, Services } from 'bundle/contracts';

import { canvasRouteOf } from '../../src/client/index.js';
import { canvasIdOf } from '../../src/client/surface/canvas-source.js';
import { CANVAS_ROUTE, canvasPathOf } from '../../src/contracts/index.js';
import { openCanvas, openCanvasInput } from '../../src/desktop/commands.js';
import { closeWindow } from './support/dom.js';
import {
  flush,
  type Host,
  type HostOptions,
  PROJECT,
  programFence,
  startHost,
  THREAD,
  until,
} from './support/fence-host.js';

after(closeWindow);

let hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts) await host.dispose();
  hosts = [];
});

const start = async (options: HostOptions = {}): Promise<Host> => {
  const host = await startHost(options);
  hosts.push(host);

  return host;
};

/** `canvasPathOf` as D26 states it: the last segment is an artifact id or an identity. */
const pathOf = canvasPathOf as unknown as (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly segment: string;
}) => string;

const ARTIFACT_ID = '0f8b4c3e-5d6a-4b7c-9e8f-1a2b3c4d5e6f';
const MARKUP =
  '<!DOCTYPE html><html><body><button id="pay">Pagar agora</button></body></html>';

test('the canvas route is its own root and hands the canvas its path params', () => {
  const made: Readonly<Record<string, string>>[] = [];
  const route = canvasRouteOf((params) => {
    made.push(params);
    return {};
  });

  assert.equal(route.path, CANVAS_ROUTE);
  assert.equal(route.parent, undefined);

  const params = { projectId: 'p1', threadId: 't1', identity: 'settings' };
  route.create({
    path: pathOf({ projectId: 'p1', threadId: 't1', segment: 'settings' }),
    pattern: CANVAS_ROUTE,
    params,
  });

  assert.deepEqual(made, [params]);
});

test('PC16: the route is /papercraft/:projectId/:threadId/:identity, and its path takes an artifact id or an identity', () => {
  assert.equal(CANVAS_ROUTE, '/papercraft/:projectId/:threadId/:identity');
  assert.equal(
    pathOf({ projectId: 'p1', threadId: 't1', segment: 'settings' }),
    '/papercraft/p1/t1/settings',
  );
  assert.equal(
    pathOf({ projectId: 'p 1', threadId: 't/1', segment: ARTIFACT_ID }),
    `/papercraft/p%201/t%2F1/${ARTIFACT_ID}`,
  );
});

test('PC16: the canvas id is the artifact id, or program:<threadId>/<identity>', () => {
  assert.equal(
    canvasIdOf({ kind: 'artifact', artifactId: ARTIFACT_ID }),
    ARTIFACT_ID,
  );
  assert.equal(
    canvasIdOf({ kind: 'program', threadId: 't1', identity: 'settings' }),
    'program:t1/settings',
  );
  assert.notEqual(
    canvasIdOf({ kind: 'program', threadId: 't1', identity: 'settings' }),
    canvasIdOf({ kind: 'program', threadId: 't2', identity: 'settings' }),
  );
});

/** Runs `papercraft.open-canvas/v1` and answers the `windows/v1.open` inputs. */
const openWindows = async (
  inputs: readonly unknown[],
): Promise<readonly { key: string; path: string }[]> => {
  const opened: { key: string; path: string }[] = [];
  const services = {
    use: (contract: { readonly id?: string }) => {
      if (contract.id !== 'windows/v1')
        throw new Error(`unexpected contract ${String(contract.id)}`);

      return {
        open: async (input: { key: string; path: string }) => {
          opened.push({ key: input.key, path: input.path });
        },
      };
    },
  } as unknown as Services;

  for (const input of inputs) {
    await openCanvas.execute(
      openCanvasInput.parse(input) as never,
      {} as Call,
      services,
    );
  }

  return opened;
};

test('PC16: open-canvas for the same identity in two Threads opens two windows', async () => {
  const opened = await openWindows([
    { projectId: 'p1', threadId: 't1', identity: 'settings' },
    { projectId: 'p1', threadId: 't2', identity: 'settings' },
  ]);

  assert.deepEqual(opened, [
    { key: 'program:t1/settings', path: '/papercraft/p1/t1/settings' },
    { key: 'program:t2/settings', path: '/papercraft/p1/t2/settings' },
  ]);
});

test('PC16, PC29: open-canvas 1.1.0 still takes a 1.0.0 input, keyed and routed by the artifact id', async () => {
  const opened = await openWindows([
    { projectId: 'p1', threadId: 't1', artifactId: ARTIFACT_ID },
  ]);

  assert.deepEqual(opened, [
    { key: ARTIFACT_ID, path: `/papercraft/p1/t1/${ARTIFACT_ID}` },
  ]);
  // Exactly one of the two.
  assert.equal(
    openCanvasInput.safeParse({
      projectId: 'p1',
      threadId: 't1',
      artifactId: ARTIFACT_ID,
      identity: 'settings',
    }).success,
    false,
  );
  assert.equal(
    openCanvasInput.safeParse({ projectId: 'p1', threadId: 't1' }).success,
    false,
  );
});

const routeParams = (segment: string) => ({
  projectId: PROJECT,
  threadId: THREAD,
  identity: segment,
});

test('PC16: an identity route opens the latest revision, and the reading lists every revision from watchFences', async () => {
  const host = await start();
  await host.setFences([
    programFence(
      ['root = Stack([title])', 'title = TextContent("First")'].join('\n'),
      { identity: 'settings', promptId: 'p-1' },
    ),
    programFence('other = TextContent("Other")', {
      identity: 'other',
      promptId: 'p-1',
      index: 1,
    }),
    programFence('title = TextContent("Second")', {
      identity: 'settings',
      promptId: 'p-2',
    }),
  ]);

  const canvas = await host.mountRoute(routeParams('settings'));
  const shown = await until(
    () =>
      canvas
        .frame()
        ?.programReceived.filter((m) => m.kind === 'program')
        .at(-1),
    (message) => message !== undefined,
    'the canvas never drew the identity',
  );

  assert.ok(
    shown !== undefined && 'text' in shown && shown.text.includes('Second'),
    'the canvas did not open the latest revision',
  );
  // The toolbar's revision reading: the latest of the identity's two.
  assert.match(canvas.text(), /rev 2\/2/);
});

test('PC16: a segment that names no fence shows the line, then the latest revision once watchFences lists one', async () => {
  const host = await start();
  await host.setFences([]);

  const canvas = await host.mountRoute(routeParams('later'));
  await until(
    canvas.text,
    (text) => text.includes('No UI named later in this thread.'),
    'the canvas never said it has no UI of that name',
  );
  assert.equal(
    canvas.element.querySelector('iframe'),
    null,
    'a frame was drawn',
  );

  await host.setFences([
    programFence('root = TextContent("Now here")', {
      identity: 'later',
      promptId: 'p-3',
    }),
  ]);
  await until(
    () => canvas.frame()?.programReceived.some((m) => m.kind === 'program'),
    (drawn) => drawn === true,
    'the canvas never drew the identity once it appeared',
  );
  assert.equal(canvas.text().includes('No UI named later'), false);
});

for (const setting of [false, true]) {
  test(`PC16, PC29: a UUID segment naming an artifact of the Thread opens its canvas on protocol 1, setting ${setting ? 'on' : 'off'}`, async () => {
    const host = await start({
      setting,
      artifacts: [
        { artifactId: ARTIFACT_ID, title: 'Checkout', markup: MARKUP },
      ],
    });

    const canvas = await host.mountRoute(routeParams(ARTIFACT_ID));
    const frame = await until(
      canvas.frame,
      (found) => found?.rendered === true,
      "the artifact's canvas never rendered",
    );
    await flush();

    assert.equal(frame?.protocol, 1);
    assert.equal(frame?.init?.content.kind, 'markup');
    const read = new Set(
      host.calls.previewReads.map(
        (call) => (call.input as { artifactId: string }).artifactId,
      ),
    );
    assert.deepEqual([...read], [ARTIFACT_ID]);
  });
}

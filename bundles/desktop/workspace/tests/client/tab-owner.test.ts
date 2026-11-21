// The tab owner `workspace` names (bundle isolation 4(c), T4.9): on every
// change of the route or of the selection the workspace calls the shell's
// `layout.tabs/v2.setOwner` with the key `tabOwnerOf` gives (the route's
// Thread, else `project:<selected Project>` on a Project route), with no
// owner on a route that has none, and only when the key changes. A change of
// the selection is written to the route (the route selection moved unchanged
// from the layout), so the owner it gives is the new route's.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

import type { Project, Thread } from '../../src/client/domain/workspace.js';
import {
  type RenderedWorkspace,
  renderWorkspace,
  settle,
} from './support/render-workspace.js';

const project = (id: string, name: string): Project => ({
  id,
  name,
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
});

const p1 = project('6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b', 'Checkout redesign');
const p2 = project('0b7d9c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e', 'Docs site');

const t1: Thread = {
  id: '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a',
  projectId: p1.id,
  name: 'Plan',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
};

let rendered: RenderedWorkspace | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

/** The owners `setOwner` received, in order; `undefined` is "no owner". */
const owners = (workspace: RenderedWorkspace): (string | undefined)[] =>
  workspace
    .tabCalls()
    .filter((call) => call.method === 'setOwner')
    .map((call) => (call.input as { readonly owner?: string }).owner);

const navigate = async (workspace: RenderedWorkspace, path: string) => {
  workspace.services.use(NavigationV1).navigate(path);
  await settle();
};

test('T4.9: the owner follows the route and the selection, and is set only when its key changes', async () => {
  rendered = await renderWorkspace({
    projects: [p1, p2],
    threads: [t1],
    projectTabs: [p1, p2],
    path: `/projects/${p1.id}/threads/${t1.id}`,
  });
  assert.equal(
    owners(rendered).at(-1),
    t1.id,
    'A Thread route names its Thread.',
  );

  await navigate(rendered, `/projects/${p2.id}`);
  assert.equal(
    owners(rendered).at(-1),
    `project:${p2.id}`,
    'A Project route names the selected Project.',
  );

  await navigate(rendered, '/projects');
  assert.equal(
    owners(rendered).at(-1),
    undefined,
    'A route with no owner names none.',
  );

  // A change of the selection is written to the route (the route selection,
  // moved unchanged from the layout), so the owner follows the new route.
  const { workspaceStore } = await import(
    '../../src/client/stores/workspace.js'
  );
  const { tabOwnerOf } = await import(
    '../../src/client/domain/route-selection.js'
  );
  const navigation = rendered.services.use(NavigationV1);
  workspaceStore.getState().select({ projectId: p1.id });
  await settle();
  const route = navigation.current();
  assert.ok(
    route?.path.startsWith(`/projects/${p1.id}`) === true,
    `The selection of Checkout redesign was not written to the route: ${route?.path}`,
  );
  const key = tabOwnerOf(route, p1.id);
  assert.notEqual(key, undefined, 'The selected Project gives no owner.');
  assert.equal(
    owners(rendered).at(-1),
    key,
    'The owner did not follow the selection.',
  );
  const settled = owners(rendered).length;

  // Changes of the workspace that leave the key as it is set nothing: the
  // records mirror notifying, the same selection chosen again, and a New
  // project draft begun and cancelled.
  let changes = 0;
  const stop = workspaceStore.subscribe(() => {
    changes += 1;
  });
  rendered.notifyRecords();
  await settle();
  const { selection } = workspaceStore.getState().tree;
  workspaceStore.getState().select(selection);
  await settle();
  workspaceStore.getState().beginProject();
  await settle();
  workspaceStore.getState().cancelDraft();
  await settle();
  stop();

  assert.ok(
    changes > 0,
    'Nothing changed in the workspace, so nothing was tried.',
  );
  assert.equal(navigation.current()?.path, route?.path, 'The route moved.');
  assert.equal(
    owners(rendered).length,
    settled,
    'An unchanged key was set again.',
  );
  const sequence = owners(rendered);
  assert.ok(
    sequence.every(
      (owner, index) => index === 0 || owner !== sequence[index - 1],
    ),
    `The same key was set twice in a row: ${JSON.stringify(sequence)}`,
  );
});

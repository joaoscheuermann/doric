// The harness itself: the whole workspace view renders in happy-dom, bound to
// the stories' fake host, without an uncaught error.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { Project } from '../../src/client/domain/workspace.js';
import {
  type RenderedWorkspace,
  renderWorkspace,
} from './support/render-workspace.js';

const project: Project = {
  id: '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b',
  name: 'Checkout redesign',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
};

let rendered: RenderedWorkspace | undefined;

after(() => rendered?.cleanup());

test('the workspace renders a Project view without an uncaught error', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
  });

  assert.ok(rendered.root.isConnected, 'The root is not in the document.');
  assert.ok(
    rendered.root.textContent?.includes(project.name),
    `The view does not name the Project: ${rendered.root.textContent}`,
  );
});

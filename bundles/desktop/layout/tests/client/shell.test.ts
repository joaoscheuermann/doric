// The workspace shell after phase 2 removed the global footer (T-2.1, S10):
// neither the Project view nor the Dashboard renders it, so nothing draws the
// `layout.global-footer` region.

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

for (const path of [`/projects/${project.id}`, '/projects']) {
  test(`the workspace at ${path} renders no global footer`, async () => {
    rendered = await renderWorkspace({ projects: [project], path });

    // A count, not the element: inspecting a happy-dom node on failure
    // walks its whole window.
    assert.equal(
      rendered.root.querySelectorAll('[data-slot="workspace-global-footer"]')
        .length,
      0,
      'The global footer is still rendered.',
    );
  });
}

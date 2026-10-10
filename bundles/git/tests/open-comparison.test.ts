// git.open-comparison/v1 (stage 10, §2.7, D10-1): a Changes row opens its
// comparison as a workspace tab with today's tab id, title, accessible name
// and tooltip, through `layout.tabs/v1`; the current tab names the row the
// Changes view selects.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { defineMethod, defineService } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  LayoutTabsV1,
  layoutTabsMethods,
  type TabRequest,
} from 'layout/contracts';

import {
  comparedPathOf,
  openComparisonCommand,
} from '../src/client/commands.js';

describe('git.open-comparison/v1', () => {
  test('opens the comparison tab of one changed file', async (t) => {
    const opened: TabRequest[] = [];
    const harness = createTestServices({
      bundle: { id: 'git-client' },
      provide: [
        defineService(LayoutTabsV1.id, {
          open: defineMethod({
            ...layoutTabsMethods.open,
            execute: async (request: TabRequest) => {
              opened.push(request);
            },
          }),
        }),
      ],
    });
    t.after(harness.dispose);
    // The command as the commands registry runs it: its input checked first.
    await openComparisonCommand.execute(
      openComparisonCommand.input.parse({
        projectId: 'project-1',
        repository: 'packages/app',
        path: 'src/main.ts',
      }),
      harness.call({}),
      harness.services,
    );

    assert.deepEqual(opened, [
      {
        id: '["diff","project-1","packages/app","src/main.ts"]',
        title: 'main.ts',
        tag: 'git-file-diff',
        props: {
          projectId: 'project-1',
          repository: 'packages/app',
          path: 'src/main.ts',
        },
        icon: 'file-diff',
        ariaLabel: 'main.ts changes',
        tooltip: 'src/main.ts',
      },
    ]);
  });

  test('names the compared workspace path of a comparison tab only', () => {
    assert.equal(
      comparedPathOf({
        id: '["diff","project-1","packages/app","src/main.ts"]',
      }),
      'packages/app/src/main.ts',
    );
    assert.equal(
      comparedPathOf({ id: '["diff","project-1","","README.md"]' }),
      'README.md',
    );
    for (const id of ['file:src/main.ts', 'terminal:1', '["file","a"]', '{'])
      assert.equal(comparedPathOf({ id }), undefined, id);
    assert.equal(comparedPathOf(undefined), undefined);
  });
});

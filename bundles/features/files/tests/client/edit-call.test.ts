// The `files-edit-call` element (bundle isolation 5(b), change 1): the diff
// block of an `edit` or `write` call, moved from the chat's
// `components/molecules/edit-tool-item.tsx` and registered through
// `chat.views/v1` 1.2.0.
// - AC5.3: the drawing's cases, moved from the chat's
//   `tests/client/edit-tool-item.test.ts`, mount the element alone with the
//   `view` the chat sets for the case's call (no chat window, no chat built
//   part) and keep their assertions on what the block draws.
// - D10: the block reports the reader's choice with `chat-block-chosen` and
//   draws the `chosen` the next `view` carries, in the same element.
// - `:1033`: the client part registers `edit`, `write` and `view-image`, each
//   in a `whenAvailable` callback of its own, so a refused registration leaves
//   the others; its cleanup disposes them.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { ChatToolView, ToolRendererSpec } from 'chat/contracts';
import { errorInfo } from 'desktop/reads';

import { assertToolNotice } from './support/notices.js';
import {
  installWindow,
  type MountedElement,
  mountElement,
  settle,
} from './support/render.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';

/** The `view` the chat sets on the element for one call of `edit` or `write`. */
const callView = (input: {
  readonly callId: string;
  readonly name?: 'edit' | 'write';
  readonly payload: unknown;
  readonly status: ChatToolView['status'];
  readonly result?: string;
  readonly error?: ChatToolView['error'];
  readonly chosen?: boolean | null;
}): ChatToolView => ({
  projectId,
  threadId,
  promptId,
  key: `${promptId}/${input.callId}`,
  name: input.name ?? 'edit',
  args: JSON.stringify(input.payload),
  ...(input.result === undefined ? {} : { result: input.result }),
  ...(input.error === undefined ? {} : { error: input.error }),
  status: input.status,
  chosen: input.chosen ?? null,
  focused: false,
});

let mounted: MountedElement<ChatToolView> | undefined;

afterEach(() => {
  mounted?.cleanup();
  mounted = undefined;
});

/** Mounts `files-edit-call` alone with `view`, as the chat creates it. */
const mountEditCall = async (
  view: ChatToolView,
): Promise<MountedElement<ChatToolView>> => {
  installWindow();
  const { EDIT_CALL_TAG, defineEditCallElement } = await import(
    '../../src/client/chat/edit-call.js'
  );
  const { storyServices } = await import('../../stories/support/services.js');
  mounted = await mountElement(EDIT_CALL_TAG, defineEditCallElement(), {
    services: storyServices({}),
    view,
  });
  return mounted;
};

/** The block the element draws, by its slot. */
const editBlock = (element: HTMLElement): HTMLElement | null =>
  element.querySelector<HTMLElement>('[data-slot="edit-tool"]');

const diffLines = (element: HTMLElement): number =>
  element.querySelectorAll('[data-slot="edit-diff-line"]').length;

describe('the edit block, mounted alone (AC5.3)', () => {
  test('edit tool truncates diffs over 16 lines with a Show more toggle and prevents 5-digit line number wrapping', async () => {
    const payload = {
      path: 'src/large.ts',
      edits: [{ oldText: '', newText: 'lines' }],
    };
    const diff = Array.from(
      { length: 20 },
      (_, index) => `${10000 + index} +const line${index + 1} = ${index + 1};`,
    ).join('\n');
    const { element } = await mountEditCall(
      callView({
        callId: 'call-edit-large',
        payload,
        status: 'finished',
        result: JSON.stringify({
          success: true,
          diff,
          first_changed_line: 10000,
        }),
      }),
    );

    const editTool = editBlock(element);
    assert.notEqual(editTool, null);

    // Header verb uses font-normal while the outer label wrapper keeps font-light.
    const trigger = editTool?.querySelector(
      '[data-slot="collapsible-trigger"]',
    );
    assert.notEqual(trigger, null);
    assert.equal(
      trigger?.querySelector('span.font-normal')?.textContent,
      'Edited',
    );

    // Initially renders 16 diff lines plus the "Show 4 more lines" button.
    const initialRows = editTool?.querySelectorAll(
      '[data-slot="edit-diff-line"]',
    );
    assert.equal(initialRows?.length, 16);

    // 5-digit line number span has whitespace-nowrap so numbers never wrap.
    const firstLineNumber = initialRows?.[0]?.querySelector('span');
    assert.equal(firstLineNumber?.textContent, '10000');
    assert.equal(
      firstLineNumber?.className.includes('whitespace-nowrap'),
      true,
    );

    const moreButton = editTool?.querySelector<HTMLButtonElement>(
      '[data-slot="edit-diff-more"]',
    );
    assert.notEqual(moreButton, null);
    assert.match(moreButton?.textContent ?? '', /Show 4 more lines/);

    // Clicking "Show 4 more lines" expands all 20 lines.
    moreButton?.click();
    await settle();

    assert.equal(
      editTool?.querySelectorAll('[data-slot="edit-diff-line"]').length,
      20,
    );
    assert.match(
      editTool?.querySelector('[data-slot="edit-diff-more"]')?.textContent ??
        '',
      /Show less/,
    );
  });

  const editPayload = {
    path: 'src/a.ts',
    edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;' }],
  };
  const failedAt = '2026-01-01T00:00:03.000Z';

  test('T-19 an edit the tool failed shows the compact tool notice naming the call', async () => {
    const { element } = await mountEditCall(
      callView({
        callId: 'call-edit-failed',
        payload: editPayload,
        status: 'failed',
        error: errorInfo(
          {
            message: 'Tool handler failed: edit',
            data: { code: 'handler_failed' },
            cause: { message: 'The old text was not found in src/a.ts.' },
          },
          { at: failedAt },
        ),
      }),
    );

    await assertToolNotice(editBlock(element), {
      title: 'Tool failed',
      explanation: 'The old text was not found in src/a.ts.',
      tool: 'edit',
    });
  });

  test('T-19 an edit whose cause names a known code is headed by that code', async () => {
    const { element } = await mountEditCall(
      callView({
        callId: 'call-edit-failed',
        payload: editPayload,
        status: 'failed',
        error: errorInfo(
          {
            message: 'Tool handler failed: edit',
            data: { code: 'handler_failed' },
            cause: {
              message: 'The edit could not be applied.',
              cause: { code: 'not_found', message: 'src/a.ts does not exist.' },
            },
          },
          { at: failedAt },
        ),
      }),
    );

    // The first level with an entry is the cause (§2.3): `not_found`.
    await assertToolNotice(editBlock(element), {
      title: 'Not found',
      explanation: 'src/a.ts does not exist.',
      tool: 'edit',
    });
  });

  test('T-19 an edit whose output reports the failure shows the same notice', async () => {
    const { element } = await mountEditCall(
      callView({
        callId: 'call-edit-failed',
        payload: editPayload,
        status: 'finished',
        result: JSON.stringify({
          success: false,
          error: 'The old text matches 2 places in src/a.ts.',
        }),
      }),
    );

    await assertToolNotice(editBlock(element), {
      title: 'Tool failed',
      explanation: 'The old text matches 2 places in src/a.ts.',
      tool: 'edit',
    });
  });
});

describe('the reader’s choice on the edit block (D10)', () => {
  const finished = (chosen: boolean | null) =>
    callView({
      callId: 'call-edit-chosen',
      payload: {
        path: 'src/parser.ts',
        edits: [{ oldText: 'const old = 1;', newText: 'const next = 2;' }],
      },
      status: 'finished',
      result: JSON.stringify({
        success: true,
        diff: ' 1 -const old = 1;\n 1 +const next = 2;',
        first_changed_line: 1,
      }),
      chosen,
    });

  test('a settled edit the reader has not chosen draws its diff open', async () => {
    const { element } = await mountEditCall(finished(null));

    assert.ok(editBlock(element), 'the edit block is drawn');
    assert.equal(diffLines(element), 2);
  });

  test('clicking the header reports chosen false, and a view with chosen false folds the same element', async () => {
    const mountedCall = await mountEditCall(finished(null));
    const { element } = mountedCall;

    element
      .querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
      ?.click();
    await settle();
    assert.deepEqual(mountedCall.chosen, [false]);

    await mountedCall.setView(finished(false));
    assert.ok(editBlock(element), 'the same element still draws the block');
    assert.equal(diffLines(element), 0, 'the diff is folded');

    await mountedCall.setView(finished(true));
    assert.equal(diffLines(element), 2, 'chosen true opens it again');
  });
});

/** What the files client part's activation asked of `chat.views/v1`. */
interface Registrations {
  readonly defined: readonly string[];
  readonly registered: readonly ToolRendererSpec[];
  readonly disposed: readonly string[];
  /** What the `whenAvailable` callbacks threw, as the platform records it. */
  readonly failures: readonly unknown[];
  readonly cleanup: () => void;
}

/**
 * Activates the files client part over fakes, with `chat.views/v1` served.
 * `whenAvailable` runs each callback at once and keeps what one throws, as
 * the platform does (`when_available_failed`); `refuse` names the tool whose
 * registration the fake refuses with `registration_conflict`.
 */
const activateWithViews = async (refuse?: string): Promise<Registrations> => {
  installWindow();
  const { still, storyServices } = await import(
    '../../stories/support/services.js'
  );
  const { activate } = await import('../../src/client/index.js');
  const { ContractError } = await import('bundle/contracts');
  const disposed = { dispose: () => undefined };
  const defined: string[] = [];
  const registered: ToolRendererSpec[] = [];
  const released: string[] = [];
  const failures: unknown[] = [];
  const base = storyServices({
    apis: {
      'ui/v1': {
        define: (tag: string) => {
          defined.push(tag);
          return disposed;
        },
      },
      'commands/v1': { register: () => disposed },
      'regions/v1': { add: () => disposed },
      'hooks/v1': { whenAvailable: () => disposed },
      'layout.panel/v3': { ...still, select: () => undefined },
      'chat.views/v1': {
        registerToolRenderer: (spec: ToolRendererSpec) => {
          if (spec.toolName === refuse) {
            throw new ContractError(
              'registration_conflict',
              `${spec.toolName} is already registered.`,
            );
          }
          registered.push(spec);
          return { dispose: () => released.push(spec.toolName) };
        },
      },
    },
  });
  const services: typeof base = {
    ...base,
    whenAvailable: (contract, callback) => {
      try {
        return base.whenAvailable(contract, callback);
      } catch (error) {
        failures.push(error);
        return disposed;
      }
    },
  };
  const cleanup = activate({ services } as unknown as Parameters<
    typeof activate
  >[0]);
  return {
    defined,
    registered,
    disposed: released,
    failures,
    cleanup: () => {
      if (typeof cleanup === 'function') cleanup();
    },
  };
};

/** A spec's facts, an absent flag read as its default `false` (the contract's rule). */
const facts = (spec: ToolRendererSpec) => ({
  toolName: spec.toolName,
  elementTag: spec.elementTag,
  standalone: spec.standalone ?? false,
  openByDefault: spec.openByDefault ?? false,
});

const EDIT_SPEC = {
  elementTag: 'files-edit-call',
  standalone: true,
  openByDefault: true,
} as const;

describe('the files client part registers its tools with chat.views/v1', () => {
  test('edit and write are drawn by files-edit-call, standalone and open by default; view-image is the generic row, open by default', async (t) => {
    const activation = await activateWithViews();
    t.after(activation.cleanup);

    assert.ok(
      activation.defined.includes('files-edit-call'),
      `defined: ${activation.defined.join(', ')}`,
    );
    assert.deepEqual(
      activation.registered
        .map(facts)
        .sort((a, b) => a.toolName.localeCompare(b.toolName)),
      [
        { toolName: 'edit', ...EDIT_SPEC },
        {
          toolName: 'view-image',
          elementTag: undefined,
          standalone: false,
          openByDefault: true,
        },
        { toolName: 'write', ...EDIT_SPEC },
      ],
    );
    assert.deepEqual(activation.failures, []);
  });

  test('one refused registration leaves the other two in place', async (t) => {
    const activation = await activateWithViews('write');
    t.after(activation.cleanup);

    assert.deepEqual(
      activation.registered.map((spec) => spec.toolName).sort(),
      ['edit', 'view-image'],
    );
    assert.equal(activation.failures.length, 1);
  });

  test('the cleanup disposes every registration', async () => {
    const activation = await activateWithViews();
    activation.cleanup();

    assert.deepEqual([...activation.disposed].sort(), [
      'edit',
      'view-image',
      'write',
    ]);
  });
});

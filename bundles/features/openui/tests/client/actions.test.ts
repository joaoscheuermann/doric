// C1 and C2 (conversation-openui.md D20): actions back to the agent. C1: the
// text the chunk's `actions.ts` builds from react-lang's `ActionEvent`, or the
// line it shows under the fence instead. C2: a click on a control of a fence
// drawn by `ConversationFence` sends through `chat.send/v1.sendAction` only on
// the latest closed revision in a main Thread, once per click, and says why
// when it does not.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { ActionEvent } from '@openuidev/lang-core';
import { ContractError } from 'bundle/contracts';
import { act } from 'react';

import type { ChatFence } from '../../src/client/chat-contract.js';
import { closeWindow, settle } from './support/dom.js';
import {
  chatFence,
  clickButton,
  fenceServices,
  type Mounted,
  mountFence,
  projectId,
  revisionOf,
  threadId,
} from './support/fence.js';

/** What `src/client/actions.ts` exports for D20's text: what to send, or the line under the fence. */
interface Actions {
  actionText(
    event: ActionEvent,
  ): { readonly send: string } | { readonly line: string };
}

const loadActions = async (): Promise<Actions> =>
  (await import(
    new URL('../../src/client/actions.js', import.meta.url).href
  )) as Actions;

after(closeWindow);

const tagIt = (overrides: Partial<ActionEvent> = {}): ActionEvent => ({
  type: 'continue_conversation',
  humanFriendlyMessage: 'Tag the release',
  params: {},
  formName: 'release',
  formState: {
    release: { version: { value: '1.4.0', componentType: 'Input' } },
  },
  ...overrides,
});

test('C1: the "Tag it" event gives the text D20 shows', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(actionText(tagIt()), {
    send: 'Tag the release\n\nrelease.version: 1.4.0',
  });
});

test('C1: a form the store does not hold gives the message alone', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(
    actionText(
      tagIt({
        formState: {
          other: { name: { value: 'x', componentType: 'Input' } },
          $filter: 'open',
        },
      }),
    ),
    { send: 'Tag the release' },
  );
});

test('C1: context adds its line, before the value lines', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(
    actionText(tagIt({ params: { context: 'for production' } })),
    {
      send: 'Tag the release\n\ncontext: for production\n\nrelease.version: 1.4.0',
    },
  );
});

test("C1: a card's item fields follow the context line, in their own order", async () => {
  const { actionText } = await loadActions();
  const card = {
    type: 'continue_conversation',
    humanFriendlyMessage: 'Postgres',
    params: { itemIndex: 0, itemId: 'pg', itemHeaderTitle: 'Postgres' },
  } satisfies ActionEvent;

  assert.deepEqual(actionText(card), {
    send: 'Postgres\n\nitemIndex: 0\nitemId: pg\nitemHeaderTitle: Postgres',
  });
  assert.deepEqual(
    actionText({
      ...card,
      params: {
        itemIndex: 0,
        itemId: 'pg',
        itemHeaderTitle: 'Postgres',
        context: 'db',
      },
    }),
    {
      send: 'Postgres\n\ncontext: db\nitemIndex: 0\nitemId: pg\nitemHeaderTitle: Postgres',
    },
  );
});

test('C1: an EditableTable "Save Changes" gives one table line with the rows as JSON', async () => {
  const { actionText } = await loadActions();
  const rows = [
    { name: 'Ana', role: 'admin' },
    { name: 'Rui', role: 'viewer' },
  ];

  assert.deepEqual(
    actionText({
      type: 'continue_conversation',
      humanFriendlyMessage: 'Save Changes',
      params: {},
      formName: 'people',
      formState: {
        people: { people: { value: rows, componentType: 'EditableTable' } },
      },
    }),
    { send: `Save Changes\n\npeople.people: ${JSON.stringify(rows)}` },
  );
});

test('C1: outside a form only the $variables are sent', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(
    actionText({
      type: 'continue_conversation',
      humanFriendlyMessage: 'Filter',
      params: {},
      formState: {
        $filter: 'open',
        release: { version: { value: '1.4.0', componentType: 'Input' } },
        loose: { value: 'typed', componentType: 'Input' },
      },
    }),
    { send: 'Filter\n\n$filter: open' },
  );
});

test('C1: undefined, null, 3 and a function give no line, null, 3 and no line', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(
    actionText(
      tagIt({
        formState: {
          release: {
            a: { value: undefined, componentType: 'Input' },
            b: { value: null, componentType: 'Input' },
            c: { value: 3, componentType: 'Input' },
            d: { value: () => 1, componentType: 'Input' },
          },
        },
      }),
    ),
    { send: 'Tag the release\n\nrelease.b: null\nrelease.c: 3' },
  );
});

test('C1: a Button with no action sends its label', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(
    actionText({
      type: 'continue_conversation',
      humanFriendlyMessage: '  Not now ',
      params: {},
    }),
    { send: 'Not now' },
  );
});

test('C1: an empty message, an open_url, an unknown type and a text over 16,000 send nothing and give their line', async () => {
  const { actionText } = await loadActions();

  assert.deepEqual(actionText(tagIt({ humanFriendlyMessage: '   ' })), {
    line: 'Not sent: the action has no message',
  });
  assert.deepEqual(
    actionText({
      type: 'open_url',
      humanFriendlyMessage: 'Docs',
      params: { url: 'https://example.com/docs' },
    }),
    { line: 'https://example.com/docs' },
  );
  assert.deepEqual(
    actionText({ type: 'refresh', humanFriendlyMessage: 'Go', params: {} }),
    { line: 'Not sent: action type refresh is not supported' },
  );
  assert.deepEqual(
    actionText({
      type: 'continue_conversation',
      humanFriendlyMessage: 'x'.repeat(16_001),
      params: {},
    }),
    { line: "Not sent: the action's text is over 16,000 characters" },
  );
  assert.deepEqual(
    actionText({
      type: 'continue_conversation',
      humanFriendlyMessage: 'x'.repeat(16_000),
      params: {},
    }),
    { send: 'x'.repeat(16_000) },
  );
});

// C2: through the chunk's ConversationFence.

const program =
  'root = Stack([btns])\nbtns = Buttons([b])\nb = Button("Tag it")\n';

const mountWith = async (
  options: {
    readonly state?: ChatFence['state'];
    readonly origin?: 'user' | 'agent';
    readonly latest?: boolean;
    readonly sendAction?: (input: unknown) => Promise<unknown>;
  } = {},
): Promise<{
  mounted: Mounted;
  calls: ReturnType<typeof fenceServices>['calls'];
}> => {
  const fence = chatFence(program, { state: options.state ?? 'closed' });
  const { services, calls } = fenceServices(
    options.sendAction === undefined ? {} : { sendAction: options.sendAction },
  );
  const mounted = await mountFence({
    view: { fence, origin: options.origin ?? 'user', fences: [fence] },
    revision: revisionOf(fence),
    latest: options.latest ?? true,
    services,
  });
  return { mounted, calls };
};

test('C2: a click on the latest closed revision in a main Thread sends its text with the program', async () => {
  const { mounted, calls } = await mountWith();

  await clickButton(mounted.container, 'Tag it');
  await settle(10);

  assert.deepEqual(calls.actions, [
    { projectId, threadId, program: 'tag', text: 'Tag it' },
  ]);
  await mounted.unmount();
});

test('C2: no send on a streaming, a cut-off or an older fence, or in an agent Thread, and the line says why', async () => {
  const cases = [
    [{ state: 'streaming' as const }, 'Actions work once the UI is complete'],
    [
      { state: 'unterminated' as const },
      'Actions are off: this UI was cut off before it was complete',
    ],
    [{ latest: false }, 'Actions work in the latest version of this UI'],
    [
      { origin: 'agent' as const },
      "Actions are off in a subagent's thread: only the main thread takes the reader's messages",
    ],
  ] as const;

  for (const [options, line] of cases) {
    const { mounted, calls } = await mountWith(options);
    const button = [...mounted.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Tag it',
    );
    if (button !== undefined) {
      await act(async () => {
        button.click();
      });
    }
    await settle(10);

    assert.deepEqual(calls.actions, [], line);
    assert.ok(mounted.container.textContent?.includes(line), line);
    await mounted.unmount();
  }
});

test('C2: two events in one task send once', async () => {
  const { mounted, calls } = await mountWith();
  const button = [...mounted.container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Tag it',
  );
  assert.ok(button !== undefined);

  await act(async () => {
    button.click();
    button.click();
  });
  await settle(10);

  assert.equal(calls.actions.length, 1);
  await mounted.unmount();
});

test('C2: a second click within 500 ms of an accepted send does not send; one after does', async () => {
  const { mounted, calls } = await mountWith();

  await clickButton(mounted.container, 'Tag it');
  await settle(50);
  assert.equal(calls.actions.length, 1);

  const button = [...mounted.container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === 'Tag it',
  );
  await act(async () => {
    button?.click();
  });
  await settle(10);
  assert.equal(calls.actions.length, 1);

  await settle(550);
  await clickButton(mounted.container, 'Tag it');
  await settle(10);
  assert.equal(calls.actions.length, 2);
  await mounted.unmount();
});

test('C2: a rejected sendAction shows "Not sent: " and its message, reports nothing, and takes the next click after 500 ms', async () => {
  let first = true;
  const { mounted, calls } = await mountWith({
    sendAction: async () => {
      if (first) {
        first = false;
        throw new ContractError('invalid_input', 'The action text is invalid.');
      }
      return { status: 'accepted' };
    },
  });

  await clickButton(mounted.container, 'Tag it');
  await settle(20);

  assert.ok(
    mounted.container.textContent?.includes(
      'Not sent: The action text is invalid.',
    ),
  );
  assert.deepEqual(calls.reports, []);

  await settle(550);
  await clickButton(mounted.container, 'Tag it');
  await settle(10);

  assert.equal(calls.actions.length, 2);
  assert.deepEqual(calls.reports, []);
  await mounted.unmount();
});

test('C2: a refused send says the thread did not take the message, and the fence works again', async () => {
  let refuse = true;
  const { mounted, calls } = await mountWith({
    sendAction: async () => {
      const status = refuse ? 'refused' : 'accepted';
      refuse = false;
      return { status };
    },
  });

  await clickButton(mounted.container, 'Tag it');
  await settle(20);
  assert.ok(
    mounted.container.textContent?.includes(
      'Not sent: the thread did not take the message',
    ),
  );

  await settle(550);
  await clickButton(mounted.container, 'Tag it');
  await settle(10);
  assert.equal(calls.actions.length, 2);
  await mounted.unmount();
});

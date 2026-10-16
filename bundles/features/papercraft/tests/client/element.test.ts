// The preview frame as the conversation mounts it (the node chrome) and as
// the route mounts it (the canvas chrome): the built markup lands in the
// shadow root, the live module falls back to it, the comment gesture joins
// the composer stack — or records directly as its fallback — the command bar
// shows its four groups and obeys the `request` policy, and the revision
// reading switches the revision on screen.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { type Call, CommandsV1, type Services } from 'bundle/contracts';
import { Window } from 'happy-dom';
import { createElement } from 'react';

const window = new Window();
const installed = [
  'window',
  'document',
  'location',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'customElements',
  'DOMParser',
] as const;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

for (const name of installed) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name as keyof Window],
    writable: true,
  });
}

type React = typeof import('react');
type ReactDomClient = typeof import('react-dom/client');
type Commands = typeof import('../../src/client/commands.js');
type Comment = typeof import('../../src/client/comment.js');
type Container = typeof import('../../src/client/surface/preview-container.js');
type Elements = typeof import('../../src/client/elements.js');
type Flush = typeof import('../../src/desktop/comment-flush.js');

let react: React;
let reactDomClient: ReactDomClient;
let commands: Commands;
let comment: Comment;
let elements: Elements;
let papercraftFlush: Flush['papercraftFlush'];
let PreviewContainer: Container['PreviewContainer'];

before(async () => {
  [react, reactDomClient, commands, comment, elements] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/client/commands.js'),
    import('../../src/client/comment.js'),
    import('../../src/client/elements.js'),
  ]);

  papercraftFlush = (await import('../../src/desktop/comment-flush.js'))
    .papercraftFlush;

  PreviewContainer = (
    await import('../../src/client/surface/preview-container.js')
  ).PreviewContainer;
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * Polls until `read()` holds: the frame is driven by effects the test cannot
 * observe synchronously, and the assertion follows the state, not a tick count.
 */
const settle = async <T>(
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();

    if (holds(value)) return value;

    await new Promise((done) => setTimeout(done, 5));
    await react.act(async () => {});
  }

  throw new Error(message);
};

const MARKUP = [
  '<!DOCTYPE html>',
  '<html lang="pt-BR">',
  '<head>',
  '<style>body { margin: 0; padding: 16px; }</style>',
  '</head>',
  '<body>',
  '<h1 id="title" data-papercraft-source="src/checkout.html:12">Checkout</h1>',
  '<button id="pay" data-papercraft-source="src/checkout.html:42">Pagar agora</button>',
  '</body>',
  '</html>',
].join('\n');

const baseRecord = () => ({
  artifactId: 'checkout-7f3a',
  kind: 'preview',
  title: 'Checkout',
  revision: 2,
  revisions: 2,
  targets: [{ path: 'src/checkout.html' }],
  source: 'html' as const,
  path: 'src/checkout.html',
  state: 'open' as 'open' | 'approved',
  createdAt: '2024-01-01T00:00:00Z',
});

const previewStateOf = (revision: number) => ({
  artifactId: 'checkout-7f3a',
  revision,
  kind: 'preview' as const,
  files: [{ path: 'index.html', sha256: 'abc' }],
  markup: MARKUP,
});

type Registry = Map<
  string,
  { execute: (input: unknown, call: Call, services: Services) => Promise<void> }
>;

interface Mounted {
  readonly frame: HTMLElement;
  readonly unmount: () => Promise<void>;
}

interface Harness {
  readonly services: Services;
  readonly reads: { artifactId: string; revision: number }[];
  readonly executes: [string, unknown][];
  readonly comments: unknown[];
  readonly approvals: unknown[];
  readonly policy: { value: 'proceed' | 'request' };
  /** Composers the harness would hand a `whenAvailable` registration. */
  readonly composers: unknown[];
  mount(
    chrome: 'node' | 'canvas',
    props: Record<string, unknown>,
  ): Promise<Mounted>;
}

const harness = (): Harness => {
  const record = baseRecord();
  const reads: { artifactId: string; revision: number }[] = [];
  const executes: [string, unknown][] = [];
  const comments: unknown[] = [];
  const approvals: unknown[] = [];
  const policy = { value: 'proceed' as 'proceed' | 'request' };

  const registry: Registry = new Map();
  const composers: unknown[] = [];
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { id?: string }) => {
      switch (contract.id) {
        case 'papercraft.previews/v1':
          return {
            read: async (input: { artifactId: string; revision: number }) => {
              reads.push(input);

              return previewStateOf(input.revision);
            },
          };
        case 'artifacts/v1':
          return {
            read: async () => record,
            policy: async () => ({ policy: policy.value }),
            approve: async (input: unknown) => {
              approvals.push(input);
              record.state = 'approved';

              return record;
            },
          };
        case 'commands/v1':
          return {
            register: (command: { id: string }) => {
              registry.set(command.id, command as never);

              return { dispose: () => registry.delete(command.id) };
            },
            execute: async (id: string, input: unknown) => {
              executes.push([id, input]);
              await registry.get(id)?.execute(input, {} as Call, services);
            },
          };
        case 'comments/v1':
          return {
            add: async (input: unknown) => {
              comments.push(input);

              return {
                commentId: 'c1',
                target: {},
                text: '',
                resolved: false,
                createdAt: '',
              };
            },
          };
        default:
          throw new Error(`unexpected contract ${String(contract.id)}`);
      }
    },
    whenAvailable: (
      contract: { id?: string },
      callback: (api: unknown) => void,
    ) => {
      if (contract.id === 'chat.composer/v1') {
        const api = composers.at(-1);

        if (api !== undefined) callback(api);
      }

      return { dispose: () => undefined };
    },
  } as unknown as Services;

  for (const command of [...commands.canvasCommands, commands.approveCommand]) {
    registry.set(command.id, command as never);
  }

  const frame = document.createElement('div');
  document.body.append(frame);
  const root = reactDomClient.createRoot(frame);

  const mount = async (
    chrome: 'node' | 'canvas',
    props: Record<string, unknown>,
  ): Promise<Mounted> => {
    const render = async (next: Record<string, unknown>) => {
      await react.act(async () => {
        root.render(
          createElement(PreviewContainer, {
            services,
            chrome,
            artifactId: 'checkout-7f3a',
            ...next,
          } as never),
        );
      });
      await tick();
      await tick();
    };

    await render(props);

    return {
      frame,
      unmount: async () => {
        await react.act(async () => {
          root.unmount();
        });
      },
    };
  };

  return {
    services,
    reads,
    executes,
    comments,
    approvals,
    policy,
    mount,
    composers,
  };
};

const shadowOf = (frame: HTMLElement): ShadowRoot => {
  const host = frame.querySelector('.papercraft-surface-host') as HTMLElement;

  assert.ok(host?.shadowRoot !== null && host.shadowRoot !== undefined);

  return host.shadowRoot;
};

test('the node renders the markup in its shadow root, header and revision reading', async () => {
  const h = harness();
  const mounted = await h.mount('node', {
    blockRevision: 1,
    blockTitle: 'Checkout',
  });

  const shadow = shadowOf(mounted.frame);
  assert.match(shadow.innerHTML, /<h1 id="title"[^>]*>Checkout<\/h1>/);
  assert.match(mounted.frame.textContent ?? '', /src\/checkout\.html/);
  assert.match(
    mounted.frame.querySelector('[data-testid="papercraft-revision"]')
      ?.textContent ?? '',
    /rev 1\/2/,
  );
  assert.deepEqual(h.reads, [{ artifactId: 'checkout-7f3a', revision: 1 }]);

  // The path A markup keeps its styles and a real body element.
  assert.ok(shadow.querySelector('style') !== null);
  assert.ok(shadow.querySelector('body #title') !== null);

  // The module did not load: the discreet notice, never an empty canvas.
  assert.equal(
    mounted.frame.querySelector('[data-testid="papercraft-notice"]')
      ?.textContent,
    'o preview não carregou · mostrando o markup',
  );

  // [ abrir ] opens the canvas window through the command.
  (
    mounted.frame.querySelector(
      '[data-testid="papercraft-open"]',
    ) as HTMLElement
  ).click();
  await tick();
  assert.deepEqual(h.executes, [
    ['papercraft.open-canvas/v1', { artifactId: 'checkout-7f3a' }],
  ]);

  // The node has no approve button: under `request` it is a reading only.
  assert.equal(mounted.frame.querySelector('[aria-label="Autorizar"]'), null);

  await mounted.unmount();
});

test('the node shows the request reading and no button under the request policy', async () => {
  const h = harness();
  h.policy.value = 'request';
  const mounted = await h.mount('node', { blockRevision: 2 });

  assert.equal(
    mounted.frame.querySelector('[data-testid="papercraft-request"]')
      ?.textContent,
    'aguardando autorização',
  );
  assert.equal(mounted.frame.textContent?.includes('Autorizar'), false);

  await mounted.unmount();
});

test('the fallback gesture records a comment through comments/v1', async () => {
  const h = harness();
  const mounted = await h.mount('node', { blockRevision: 1 });

  // No composer is bound: the gesture falls back to the note form.
  (
    mounted.frame.querySelector(
      '[data-testid="papercraft-comment"]',
    ) as HTMLElement
  ).click();
  await tick();

  const shadow = shadowOf(mounted.frame);
  (shadow.querySelector('#title') as HTMLElement).click();
  await tick();

  const form = (await settle(
    () => mounted.frame.querySelector('[data-testid="papercraft-note"]'),
    (value) => value !== null,
    'the fallback note form never appeared',
  )) as HTMLFormElement;

  (form.querySelector('.papercraft-note-input') as HTMLInputElement).value =
    'aqui precisa de respiro';

  // Let the frame's effects settle — the submit listener the fallback form
  // hangs from is one of them — before the dispatch.
  await new Promise((done) => setTimeout(done, 50));
  await react.act(async () => {});
  await react.act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle(
    () => h.comments.length,
    (length) => length === 1,
    'the comment was never recorded',
  );

  assert.equal(h.comments.length, 1);
  const added = h.comments[0] as {
    target: {
      kind: string;
      id: string;
      revision: number;
      anchor: { form: string; path?: string; line?: number };
    };
    text: string;
  };
  assert.equal(added.target.kind, 'artifact');
  assert.equal(added.target.id, 'checkout-7f3a');
  assert.equal(added.target.revision, 1);
  assert.equal(added.target.anchor.form, 'source');
  assert.equal(added.target.anchor.path, 'src/checkout.html');
  assert.equal(added.target.anchor.line, 12);
  assert.equal(added.text, 'aqui precisa de respiro');

  // The comment became a numbered pin, and the button carries the count.
  assert.equal(mounted.frame.textContent?.includes('[1]'), true);
  assert.match(
    mounted.frame.querySelector('[data-testid="papercraft-comment"]')
      ?.textContent ?? '',
    /1/,
  );

  await mounted.unmount();
});

test('the gesture joins the composer stack when chat provides one', async () => {
  const h = harness();
  await window.happyDOM.setURL('https://doric.app/projects/p1/threads/t-123');

  interface StackItem {
    id: string;
    kind: string;
    elementTag: string;
    data: unknown;
    author?: string;
    note: string;
  }

  type Watch =
    | {
        kind: 'snapshot';
        threadId: string;
        text: string;
        items: StackItem[];
      }
    | { kind: 'added'; threadId: string; item: StackItem };

  const added: {
    threadId: string;
    kind: string;
    elementTag: string;
    data?: unknown;
    note?: string;
    author?: string;
  }[] = [];
  const listeners: ((watch: Watch) => void)[] = [];
  const items: StackItem[] = [];
  let nextId = 0;

  comment.setComposer({
    addItem: async (input: {
      threadId: string;
      kind: string;
      elementTag: string;
      data?: unknown;
      note?: string;
      author?: string;
    }) => {
      added.push(input);
      nextId += 1;
      const item: StackItem = {
        id: `i${String(nextId)}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        note: input.note ?? '',
        ...(input.author === undefined ? {} : { author: input.author }),
      };
      items.push(item);

      for (const listener of [...listeners]) {
        listener({ kind: 'added', threadId: input.threadId, item });
      }

      return item;
    },
    watch: (threadId: string, listener: (watch: Watch) => void) => {
      listeners.push(listener);
      // The portrait first, as the real stream does.
      listener({ kind: 'snapshot', threadId, text: '', items: [...items] });

      return { dispose: () => undefined };
    },
  } as never);
  h.composers.push(comment.composer());

  const mounted = await h.mount('node', { blockRevision: 1 });

  (
    mounted.frame.querySelector(
      '[data-testid="papercraft-comment"]',
    ) as HTMLElement
  ).click();
  await tick();

  const shadow = shadowOf(mounted.frame);
  (shadow.querySelector('#pay') as HTMLElement).click();

  // One stack item, no durable comment yet.
  await settle(
    () => added.length,
    (length) => length === 1,
    'the gesture never joined the composer stack',
  );
  await settle(
    () => mounted.frame.textContent?.includes('[1]') === true,
    (pin) => pin,
    'the stack delivery never lit the pin',
  );
  assert.equal(h.comments.length, 0);

  const input = added[0] as {
    threadId: string;
    kind: string;
    elementTag: string;
    data: {
      artifactId: string;
      revision: number;
      pin: number;
      anchor: { form: string; selector?: string };
    };
    note?: string;
  };
  assert.equal(input.threadId, 't-123');
  assert.equal(input.kind, 'papercraft-preview');
  assert.equal(input.elementTag, 'papercraft-comment-card');
  assert.equal(input.data.artifactId, 'checkout-7f3a');
  assert.equal(input.data.revision, 1);
  assert.equal(input.data.pin, 1);
  assert.equal(input.data.anchor.selector, 'button#pay');
  assert.equal(input.note, '');

  // The stack delivery lights the pin and the count.
  assert.equal(mounted.frame.textContent?.includes('[1]'), true);

  // The flush the main process registers answers the durable writes the
  // sender then performs: the client records nothing itself here.
  const writes = await papercraftFlush(
    {
      id: 'i1',
      kind: 'papercraft-preview',
      elementTag: 'papercraft-comment-card',
      data: input.data,
      note: '  aumenta o respiro do botão  ',
    },
    { threadId: 't-123', promptId: 'p-1' },
  );

  assert.equal(h.comments.length, 0);
  assert.equal(writes.length, 1);
  const write = writes[0];
  assert.ok(write !== undefined);
  assert.deepEqual(write.target, {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: input.data.anchor,
  });
  assert.equal(write.text, 'aumenta o respiro do botão');

  comment.setComposer(undefined);
  await mounted.unmount();
});

test('the papercraft flush leaves a note-less or target-less item drafted', async () => {
  const context = { threadId: 't-123', promptId: 'p-1' };
  const data = {
    artifactId: 'checkout-7f3a',
    revision: 2,
    anchor: { form: 'selector', selector: 'button#pay' },
    pin: 3,
    point: { x: 10, y: 20 },
  };

  // A blank note answers no write — nothing was asked yet.
  assert.deepEqual(
    await papercraftFlush(
      {
        id: 'i2',
        kind: 'papercraft-preview',
        elementTag: 'papercraft-comment-card',
        data,
        note: '   ',
      },
      context,
    ),
    [],
  );

  // An item whose data no longer names a target is not ours.
  assert.deepEqual(
    await papercraftFlush(
      {
        id: 'i3',
        kind: 'papercraft-preview',
        elementTag: 'papercraft-comment-card',
        data: { something: 'else' },
        note: 'não é meu',
      },
      context,
    ),
    [],
  );

  // A named note carries the author through.
  const writes = await papercraftFlush(
    {
      id: 'i4',
      kind: 'papercraft-preview',
      elementTag: 'papercraft-comment-card',
      data,
      note: 'aumenta o respiro',
      author: 'ada',
    },
    context,
  );

  assert.deepEqual(writes, [
    {
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 2,
        anchor: data.anchor,
      },
      text: 'aumenta o respiro',
      author: 'ada',
    },
  ]);
});

test('the comment card element accepts the stack line props', async () => {
  const Element = elements.defineCommentCardElement();
  const tag = 'papercraft-comment-card-props-test';

  if (customElements.get(tag) === undefined) {
    customElements.define(tag, Element);
  }

  const el = document.createElement(tag) as HTMLElement & {
    services: unknown;
    item?: unknown;
    pin?: number;
    open?: boolean;
    onNote?: (note: string) => void;
  };
  document.body.append(el);
  el.services = {};

  let edited: string | undefined;
  el.item = {
    id: 'i1',
    kind: 'papercraft-preview',
    elementTag: 'papercraft-comment-card',
    data: {
      artifactId: 'checkout-7f3a',
      revision: 1,
      anchor: { form: 'selector', selector: 'button#pay' },
      pin: 1,
      point: { x: 0, y: 0 },
    },
    note: '',
  };
  el.pin = 7;
  el.open = true;
  el.onNote = (note) => {
    edited = note;
  };

  await react.act(async () => {
    await tick();
  });

  // The stack's props landed: its number and the anchor are on the line, and
  // the opened line edits the note in place.
  assert.match(el.textContent ?? '', /\[7\] button#pay/);

  const area = el.querySelector('textarea') as HTMLTextAreaElement | null;
  assert.ok(area !== null, 'the opened line never asked');

  // React tracks a controlled textarea's value; set it through the native
  // setter so the change is not swallowed, then let the input event bubble.
  const value = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  value?.call(area, 'mais respiro');
  area.dispatchEvent(new Event('input', { bubbles: true }));

  await react.act(async () => {
    await tick();
  });

  assert.equal(edited, 'mais respiro');

  el.remove();
});

test('the canvas draws the toolbar groups and the tree, and obeys the policy', async () => {
  const h = harness();
  const mounted = await h.mount('canvas', {});

  // The window opens at the newest revision.
  assert.match(
    mounted.frame.querySelector('[role="toolbar"]')?.textContent ?? '',
    /rev 2\/2/,
  );
  assert.match(
    mounted.frame.querySelector('.papercraft-tree')?.textContent ?? '',
    /h1#title/,
  );

  // Four groups and three dividers.
  const toolbar = mounted.frame.querySelector(
    '[role="toolbar"]',
  ) as HTMLElement;
  const groupCommands = [
    'papercraft.select/v1',
    'papercraft.comment/v1',
    'papercraft.pan/v1',
    'papercraft.isolate/v1',
    'papercraft.show-all/v1',
    'papercraft.zoom-out/v1',
    'papercraft.zoom-reset/v1',
    'papercraft.zoom-in/v1',
    'papercraft.zoom-fit/v1',
  ];
  for (const command of groupCommands) {
    assert.ok(
      toolbar.querySelector(`[data-command="${command}"]`) !== null,
      `missing ${command}`,
    );
  }
  assert.equal(toolbar.querySelectorAll('[data-slot="separator"]').length, 3);

  // Under `proceed` there is no approval and no reading for it.
  assert.equal(toolbar.textContent?.includes('Autorizar'), false);
  assert.equal(toolbar.textContent?.includes('Autorizado'), false);

  // Disabled, not hidden: nothing is selected, nothing is hidden.
  assert.ok(
    (
      toolbar.querySelector(
        '[data-command="papercraft.isolate/v1"]',
      ) as HTMLButtonElement
    ).disabled,
  );
  assert.ok(
    (
      toolbar.querySelector(
        '[data-command="papercraft.show-all/v1"]',
      ) as HTMLButtonElement
    ).disabled,
  );

  // Selecting an element enables Isolar; isolating enables Mostrar tudo.
  const shadow = shadowOf(mounted.frame);
  (shadow.querySelector('#pay') as HTMLElement).click();
  await tick();
  await tick();

  assert.ok(
    mounted.frame.querySelector('[data-testid="papercraft-selection"]') !==
      null,
  );
  assert.equal(
    (
      toolbar.querySelector(
        '[data-command="papercraft.isolate/v1"]',
      ) as HTMLButtonElement
    ).disabled,
    false,
  );

  (
    toolbar.querySelector(
      '[data-command="papercraft.isolate/v1"]',
    ) as HTMLElement
  ).click();
  await tick();
  await tick();

  assert.equal(
    (
      toolbar.querySelector(
        '[data-command="papercraft.show-all/v1"]',
      ) as HTMLButtonElement
    ).disabled,
    false,
  );
  // The hidden layer is applied to the derived tree's DOM.
  assert.equal(
    (shadow.querySelector('#title') as HTMLElement).style.visibility,
    'hidden',
  );

  (
    toolbar.querySelector(
      '[data-command="papercraft.show-all/v1"]',
    ) as HTMLElement
  ).click();
  await tick();
  await tick();
  assert.equal(
    (shadow.querySelector('#title') as HTMLElement).style.visibility,
    '',
  );

  // The tree highlights the selected node, and selecting from it lights the
  // element in the canvas.
  const row = mounted.frame.querySelector(
    '.papercraft-tree [data-node-id]',
  ) as HTMLElement;
  assert.ok(row !== null);
  (row.querySelector('button') as HTMLElement).click();
  await tick();
  assert.equal(row.dataset.selected, 'true');

  await mounted.unmount();
});

test('the zoom controls dispatch commands and the reading follows', async () => {
  const h = harness();
  const mounted = await h.mount('canvas', {});
  const toolbar = mounted.frame.querySelector(
    '[role="toolbar"]',
  ) as HTMLElement;

  assert.match(
    toolbar.querySelector('[data-command="papercraft.zoom-reset/v1"]')
      ?.textContent ?? '',
    /100%/,
  );

  (
    toolbar.querySelector(
      '[data-command="papercraft.zoom-in/v1"]',
    ) as HTMLElement
  ).click();
  await tick();
  await tick();

  assert.deepEqual(h.executes[0], [
    'papercraft.zoom-in/v1',
    { artifactId: 'checkout-7f3a' },
  ]);
  assert.match(
    toolbar.querySelector('[data-command="papercraft.zoom-reset/v1"]')
      ?.textContent ?? '',
    /120%/,
  );

  (
    toolbar.querySelector(
      '[data-command="papercraft.zoom-reset/v1"]',
    ) as HTMLElement
  ).click();
  await tick();
  await tick();
  assert.match(
    toolbar.querySelector('[data-command="papercraft.zoom-reset/v1"]')
      ?.textContent ?? '',
    /100%/,
  );

  await mounted.unmount();
});

test('the revision reading switches the revision on screen', async () => {
  const h = harness();
  const mounted = await h.mount('canvas', {});
  const toolbar = mounted.frame.querySelector(
    '[role="toolbar"]',
  ) as HTMLElement;

  // More than one revision: the reading is a dropdown.
  assert.ok(
    toolbar.querySelector('[aria-label="Revisão"]') !== null,
    'the revision reading exists',
  );

  await h.services.use(CommandsV1).execute('papercraft.select-revision/v1', {
    artifactId: 'checkout-7f3a',
    revision: 1,
  });
  await tick();
  await tick();

  assert.match(
    toolbar.querySelector('[aria-label="Revisão"]')?.textContent ?? '',
    /rev 1\/2/,
  );
  assert.deepEqual(h.reads.at(-1), {
    artifactId: 'checkout-7f3a',
    revision: 1,
  });

  await mounted.unmount();
});

test('Autorizar lives in the bar, and turns into the reading once approved', async () => {
  const h = harness();
  h.policy.value = 'request';
  const mounted = await h.mount('canvas', {});
  const toolbar = mounted.frame.querySelector(
    '[role="toolbar"]',
  ) as HTMLElement;

  const approve = toolbar.querySelector(
    '[aria-label="Autorizar"]',
  ) as HTMLElement;
  assert.ok(approve !== null);
  assert.match(approve.textContent ?? '', /Autorizar/);

  approve.click();
  await tick();
  await tick();

  assert.deepEqual(h.approvals, [{ artifactId: 'checkout-7f3a', revision: 2 }]);

  // The approval turned the button into the reading.
  assert.equal(toolbar.querySelector('[aria-label="Autorizar"]'), null);
  assert.match(toolbar.textContent ?? '', /Autorizado/);

  await mounted.unmount();
});

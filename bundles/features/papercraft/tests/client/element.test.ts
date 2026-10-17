// The preview frame as the conversation mounts it (the node chrome) and as
// the route mounts it (the canvas chrome): the built markup lands in the
// shadow root, every host call carries the preview's Project scope, the header
// overlays the canvas, the comment flow is Figma's — an inline input at the
// pin, and the composer stack only hears of a note once it is confirmed; a
// comment that is never sent never becomes an event — sent comments stay as
// pins, `Cmd+Enter` sends the stack through chat's send, the command bar shows
// its four groups and obeys the `request` policy, and the revision reading
// switches the revision on screen.

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

// The thread's menus measure what they open beside.
Object.defineProperty(globalThis, 'getComputedStyle', {
  configurable: true,
  value: window.getComputedStyle.bind(window),
  writable: true,
});

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
  /** Renders the same frame again with new props. */
  readonly rerender: (props: Record<string, unknown>) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

interface Harness {
  readonly services: Services;
  readonly reads: { artifactId: string; revision: number }[];
  readonly executes: [string, unknown][];
  readonly comments: unknown[];
  readonly approvals: unknown[];
  readonly policy: { value: 'proceed' | 'request' };
  /** The durable comments `comments/v1.list` answers. */
  readonly durable: unknown[];
  /** How many times the frame listed the durable comments. */
  readonly lists: number;
  /** Every `comments/v1.resolve` the frame asked for, with its scope. */
  readonly resolves: { input: unknown; scope: unknown }[];
  /**
   * The Thread's log `runtime.threads/v1.watchThread` replays, once a test
   * sets one; without it the watch never answers.
   */
  log: unknown[] | undefined;
  /** The scopes every host call carried. */
  readonly scopes: unknown[];
  /** The composer `chat.composer/v1` answers, once a test sets one. */
  composer: unknown;
  /** Every `chat.send/v1.send` the frame asked for, with its scope. */
  readonly sends: { input: unknown; scope: unknown }[];
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
  const durable: unknown[] = [];
  const counts = { lists: 0 };
  const resolves: { input: unknown; scope: unknown }[] = [];
  const thread: { log: unknown[] | undefined } = { log: undefined };
  const scopes: unknown[] = [];
  const sends: { input: unknown; scope: unknown }[] = [];
  const state: { composer: unknown } = { composer: undefined };
  const scopedContracts = new Set([
    'papercraft.previews/v1',
    'artifacts/v1',
    'comments/v1',
    'chat.composer/v1',
    'runtime.threads/v1',
  ]);
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { id?: string }, scope?: { projectId?: string }) => {
      // As the real host's lease: a Project-bound call without its Project
      // is refused.
      if (scopedContracts.has(contract.id ?? '')) {
        if (scope?.projectId === undefined) {
          throw new Error(`${String(contract.id)} used without a projectId`);
        }

        scopes.push(scope);
      }

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
            list: async () => {
              counts.lists += 1;

              return durable;
            },
            resolve: async (input: unknown) => {
              resolves.push({ input, scope });

              return undefined;
            },
          };
        case 'chat.composer/v1':
          return state.composer;
        case 'chat.send/v1':
          return {
            send: async (input: unknown) => {
              sends.push({ input, scope });

              return { status: 'accepted' };
            },
          };
        case 'runtime.threads/v1':
          return {
            watchThread: (
              _input: unknown,
              listener: (item: unknown) => void,
            ) => {
              if (thread.log !== undefined)
                listener({ kind: 'snapshot', events: [...thread.log] });

              return { dispose: () => undefined };
            },
          };
        default:
          throw new Error(`unexpected contract ${String(contract.id)}`);
      }
    },
    whenAvailable: () => ({ dispose: () => undefined }),
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
            scope: { projectId: 'p1', threadId: 't-123' },
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
      rerender: render,
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
    durable,
    get lists() {
      return counts.lists;
    },
    resolves,
    get log() {
      return thread.log;
    },
    set log(value: unknown[] | undefined) {
      thread.log = value;
    },
    scopes,
    sends,
    get composer() {
      return state.composer;
    },
    set composer(value: unknown) {
      state.composer = value;
    },
    mount,
  };
};

const shadowOf = (frame: HTMLElement): ShadowRoot => {
  const host = frame.querySelector('.papercraft-surface-host') as HTMLElement;

  assert.ok(host?.shadowRoot !== null && host.shadowRoot !== undefined);

  return host.shadowRoot;
};

/** One item of the fake composer's stack. */
interface StackItem {
  id: string;
  kind: string;
  elementTag: string;
  data: unknown;
  author?: string;
  note: string;
}

type Watch =
  | { kind: 'snapshot'; threadId: string; text: string; items: StackItem[] }
  | { kind: 'added' | 'updated'; threadId: string; item: StackItem }
  | { kind: 'removed'; threadId: string; id: string };

/**
 * A `chat.composer/v1` double: the host-held stack, its watch (portrait
 * first, then deltas) and a record of every write the frame asked for.
 */
const fakeComposer = (initial: StackItem[] = []) => {
  const items: StackItem[] = [...initial];
  const listeners: ((watch: Watch) => void)[] = [];
  const added: { threadId: string; data?: unknown; note?: string }[] = [];
  const notes: { id: string; note: string }[] = [];
  const removed: string[] = [];
  const emit = (watch: Watch) => {
    for (const listener of [...listeners]) listener(watch);
  };

  const api = {
    addItem: async (input: {
      threadId: string;
      kind: string;
      elementTag: string;
      data?: unknown;
      note?: string;
    }) => {
      added.push(input);
      const item: StackItem = {
        id: `i${String(items.length + added.length)}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        note: input.note ?? '',
      };
      items.push(item);
      emit({ kind: 'added', threadId: input.threadId, item });

      return item;
    },
    updateNote: async (input: {
      threadId: string;
      id: string;
      note: string;
    }) => {
      notes.push({ id: input.id, note: input.note });
      const index = items.findIndex((item) => item.id === input.id);
      const item = items[index];
      if (item === undefined) return;
      items[index] = { ...item, note: input.note };
      emit({ kind: 'updated', threadId: input.threadId, item: items[index] });
    },
    removeItem: async (input: { threadId: string; id: string }) => {
      removed.push(input.id);
      const index = items.findIndex((item) => item.id === input.id);
      if (index >= 0) items.splice(index, 1);
      emit({ kind: 'removed', threadId: input.threadId, id: input.id });
    },
    watch: (threadId: string, listener: (watch: Watch) => void) => {
      listeners.push(listener);
      listener({ kind: 'snapshot', threadId, text: '', items: [...items] });

      return { dispose: () => undefined };
    },
  };

  return { api, added, notes, removed };
};

/** A draft of this preview, as the stack holds it. */
const draftOf = (
  id: string,
  revision: number,
  note: string,
  extra: Record<string, unknown> = {},
): StackItem => ({
  id,
  kind: 'papercraft-preview',
  elementTag: 'chat-comment-line',
  data: {
    target: {
      kind: 'artifact',
      id: 'checkout-7f3a',
      revision,
      anchor: { form: 'point', x: 10, y: 20 },
    },
    pin: 1,
    point: { x: 10, y: 20 },
    ...extra,
  },
  note,
});

/** A durable comment of this preview, as `comments/v1.list` answers it. */
const sentOf = (
  commentId: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  commentId,
  target: {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { form: 'source', path: 'src/checkout.html', line: 42 },
  },
  text,
  resolved: false,
  createdAt: '2024-01-01T00:00:00Z',
  ...extra,
});

/** A `comments.*` event of the Thread's log, written under a prompt. */
const logged = (type: string, promptId: string, event: unknown) => ({
  type,
  promptId,
  event,
});

const query = <T extends Element = HTMLElement>(
  root: ParentNode,
  testId: string,
): T | null => root.querySelector(`[data-testid="${testId}"]`) as T | null;

/** Sets a controlled field's value the way typing does. */
const type = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

const key = (
  target: EventTarget,
  name: string,
  init: Record<string, unknown> = {},
) =>
  react.act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      }) as never,
    );
  });

/** A click on an element of the preview, inside its shadow root. */
const clickIn = (target: Element, init: Record<string, unknown> = {}) =>
  react.act(async () => {
    target.dispatchEvent(
      new window.MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true,
        ...init,
      }) as never,
    );
  });

/**
 * A press on an element of the frame, the way a pointer makes one: the
 * pointer-down, then the click.
 */
const press = (target: Element, init: Record<string, unknown> = {}) =>
  react.act(async () => {
    const options = { bubbles: true, composed: true, cancelable: true };

    target.dispatchEvent(
      new window.PointerEvent('pointerdown', { ...options, ...init }) as never,
    );
    target.dispatchEvent(
      new window.MouseEvent('click', { ...options, ...init }) as never,
    );
  });

/** The reader's first press on the node, which only focuses it. */
const focusNode = (frame: HTMLElement) =>
  press(shadowOf(frame).querySelector('#title') as Element);

/** Mounts a node with chat's composer on, focused, in comment mode. */
const commenting = async (
  h: Harness,
  composer = fakeComposer(),
  blockRevision = 1,
) => {
  h.composer = composer.api;
  comment.setComposerAvailable(true);
  const mounted = await h.mount('node', { blockRevision });

  await focusNode(mounted.frame);
  await react.act(async () => {
    query(mounted.frame, 'papercraft-comment')?.click();
  });

  return { mounted, composer };
};

const inputOf = (frame: HTMLElement) =>
  query(frame, 'papercraft-comment-input')?.querySelector(
    'textarea',
  ) as HTMLTextAreaElement | null;

test('the node renders the markup in its shadow root, in the preview scope', async () => {
  const h = harness();
  const mounted = await h.mount('node', { blockRevision: 1 });

  const shadow = shadowOf(mounted.frame);
  assert.match(shadow.innerHTML, /<h1 id="title"[^>]*>Checkout<\/h1>/);
  assert.deepEqual(h.reads, [{ artifactId: 'checkout-7f3a', revision: 1 }]);

  // Every host call named the preview's Project.
  assert.ok(h.scopes.length > 0);
  for (const scope of h.scopes) {
    assert.equal((scope as { projectId: string }).projectId, 'p1');
  }

  // The path A markup keeps its styles and a real body element.
  assert.ok(shadow.querySelector('style') !== null);
  assert.ok(shadow.querySelector('body #title') !== null);

  // The revision names no module: the markup is the revision, no notice.
  assert.equal(
    mounted.frame.querySelector('[data-testid="papercraft-notice"]'),
    null,
  );

  // [ abrir ] opens the canvas window through the command, once the node
  // is focused and shows its controls.
  await focusNode(mounted.frame);
  (
    mounted.frame.querySelector(
      '[data-testid="papercraft-open"]',
    ) as HTMLElement
  ).click();
  await tick();
  assert.deepEqual(h.executes, [
    [
      'papercraft.open-canvas/v1',
      { artifactId: 'checkout-7f3a', projectId: 'p1', threadId: 't-123' },
    ],
  ]);

  // The node has no approve button: under `request` it is a reading only.
  assert.equal(mounted.frame.querySelector('[aria-label="Autorizar"]'), null);

  await mounted.unmount();
});

test('the header overlays the canvas with the title, the revision and icon controls', async () => {
  const h = harness();
  const mounted = await h.mount('node', { blockRevision: 2 });
  await focusNode(mounted.frame);
  const header = query(mounted.frame, 'papercraft-header') as HTMLElement;

  assert.match(header.textContent ?? '', /src\/checkout\.html/);
  assert.match(
    query(header, 'papercraft-revision')?.textContent ?? '',
    /rev 2/,
  );
  // Icon buttons, named for the reader and the tooltips.
  assert.equal(
    query(header, 'papercraft-open')?.getAttribute('aria-label'),
    'Abrir',
  );
  const control = query(header, 'papercraft-comment') as HTMLButtonElement;
  assert.equal(control.getAttribute('aria-label'), 'Comentar');
  assert.equal(control.getAttribute('aria-pressed'), 'false');
  // The canvas fills the frame from the top: the header floats over it.
  assert.match(
    (mounted.frame.querySelector('.papercraft-canvas') as HTMLElement)
      .className,
    /\binset-0\b/,
  );

  await mounted.unmount();
});

test('the node is a square, with no resize handle', async () => {
  const h = harness();
  const mounted = await h.mount('node', {});
  const container = mounted.frame.querySelector(
    '.papercraft-container',
  ) as HTMLElement;

  // Every child is absolute, so the ratio is the container's own.
  assert.match(container.className, /\baspect-square\b/);
  assert.match(container.className, /\bw-full\b/);
  assert.equal(container.style.height, '');
  assert.equal(mounted.frame.querySelector('.papercraft-resize'), null);

  await mounted.unmount();
});

const activeOf = (frame: HTMLElement) =>
  (frame.querySelector('[data-active]') as HTMLElement).dataset.active;

test('the first press on the node only focuses it, and its controls come with the focus', async () => {
  const h = harness();
  const mounted = await h.mount('node', { blockRevision: 1 });
  const container = mounted.frame.querySelector(
    '.papercraft-container',
  ) as HTMLElement;
  const canvas = mounted.frame.querySelector('.papercraft-canvas');
  const pay = shadowOf(mounted.frame).querySelector('#pay') as Element;

  // Unfocused, the node shows its title but none of its controls.
  assert.equal(activeOf(mounted.frame), 'false');
  assert.match(
    query(mounted.frame, 'papercraft-header')?.textContent ?? '',
    /src\/checkout\.html/,
  );
  assert.equal(query(mounted.frame, 'papercraft-open'), null);
  assert.equal(query(mounted.frame, 'papercraft-comment'), null);
  assert.equal(query(mounted.frame, 'papercraft-footer'), null);
  assert.doesNotMatch(container.className, /\boutline-primary\b/);

  // The first press focuses the canvas, outlines the frame and selects
  // nothing.
  await press(pay);
  assert.equal(document.activeElement, canvas);
  assert.equal(activeOf(mounted.frame), 'true');
  assert.match(container.className, /\boutline-primary\b/);
  assert.equal(query(mounted.frame, 'papercraft-selection'), null);
  assert.ok(query(mounted.frame, 'papercraft-open') !== null);
  assert.ok(query(mounted.frame, 'papercraft-comment') !== null);
  assert.ok(query(mounted.frame, 'papercraft-footer') !== null);

  // The focused canvas answers the next one.
  await press(pay);
  assert.ok(query(mounted.frame, 'papercraft-selection') !== null);

  await mounted.unmount();
});

test('the tools armed on the node wait out the blur and return with the focus', async () => {
  const h = harness();
  const { mounted } = await commenting(h);
  const pay = shadowOf(mounted.frame).querySelector('#pay') as Element;
  const hover = () =>
    react.act(async () => {
      pay.dispatchEvent(
        new window.PointerEvent('pointermove', {
          bubbles: true,
          composed: true,
        }) as never,
      );
    });
  const toolOf = () =>
    (mounted.frame.querySelector('[data-tool]') as HTMLElement).dataset.tool;

  await hover();
  assert.ok(query(mounted.frame, 'papercraft-hover') !== null);

  // The focus goes elsewhere in the app: the tools hide, comment mode stays.
  const elsewhere = document.createElement('button');
  document.body.append(elsewhere);
  await react.act(async () => elsewhere.focus());
  assert.equal(activeOf(mounted.frame), 'false');
  assert.equal(query(mounted.frame, 'papercraft-hover'), null);
  assert.equal(query(mounted.frame, 'papercraft-comment'), null);
  assert.equal(toolOf(), 'comment');

  await hover();
  assert.equal(query(mounted.frame, 'papercraft-hover'), null);

  // The press that brings the focus back drops no pin; the tool is there.
  await focusNode(mounted.frame);
  assert.equal(query(mounted.frame, 'papercraft-comment-input'), null);
  assert.equal(
    query(mounted.frame, 'papercraft-comment')?.getAttribute('aria-pressed'),
    'true',
  );
  await hover();
  assert.ok(query(mounted.frame, 'papercraft-hover') !== null);

  elsewhere.remove();
  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('Esc with nothing to cancel hands the focus back', async () => {
  const h = harness();
  const mounted = await h.mount('node', { blockRevision: 1 });

  await focusNode(mounted.frame);
  assert.equal(activeOf(mounted.frame), 'true');

  await key(
    mounted.frame.querySelector('.papercraft-canvas') as Element,
    'Escape',
  );
  assert.equal(activeOf(mounted.frame), 'false');

  await mounted.unmount();
});

test('without the composer the comment control is disabled and nothing is drafted', async () => {
  const h = harness();
  comment.setComposerAvailable(false);
  const mounted = await h.mount('node', { blockRevision: 1 });
  await focusNode(mounted.frame);

  assert.equal(
    (query(mounted.frame, 'papercraft-comment') as HTMLButtonElement).disabled,
    true,
  );
  await mounted.rerender({ blockRevision: 1, commentRequest: 1 });
  assert.equal(
    (mounted.frame.querySelector('[data-tool]') as HTMLElement).dataset.tool,
    'select',
  );

  await clickIn(shadowOf(mounted.frame).querySelector('#title') as Element);
  assert.equal(query(mounted.frame, 'papercraft-comment-input'), null);
  assert.equal(h.comments.length, 0);

  await mounted.unmount();
});

test('the comment control, C and Esc toggle comment mode', async () => {
  const h = harness();
  const { mounted } = await commenting(h);
  const control = query(mounted.frame, 'papercraft-comment') as HTMLElement;
  const canvas = mounted.frame.querySelector('.papercraft-canvas') as Element;
  const toolOf = () =>
    (mounted.frame.querySelector('[data-tool]') as HTMLElement).dataset.tool;

  assert.equal(toolOf(), 'comment');
  assert.equal(control.getAttribute('aria-pressed'), 'true');

  await key(canvas, 'c');
  assert.equal(toolOf(), 'select');
  assert.equal(control.getAttribute('aria-pressed'), 'false');

  await key(canvas, 'C');
  assert.equal(toolOf(), 'comment');

  await key(canvas, 'Escape');
  assert.equal(toolOf(), 'select');

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('the element a comment would land on is outlined unlike the selection; Alt clears it', async () => {
  const h = harness();
  const { mounted } = await commenting(h);
  const pay = shadowOf(mounted.frame).querySelector('#pay') as Element;
  const move = (init: Record<string, unknown> = {}) =>
    react.act(async () => {
      pay.dispatchEvent(
        new window.PointerEvent('pointermove', {
          bubbles: true,
          composed: true,
          ...init,
        }) as never,
      );
    });

  await move();
  const hover = query(mounted.frame, 'papercraft-hover') as HTMLElement;
  assert.ok(hover !== null);
  assert.match(hover.className, /border-dashed/);
  assert.equal(query(mounted.frame, 'papercraft-selection'), null);
  // The label names the element and the source line it came from.
  assert.equal(
    query(mounted.frame, 'papercraft-hover-label')?.textContent,
    'button#pay · checkout.html:42',
  );

  await move({ altKey: true });
  assert.equal(query(mounted.frame, 'papercraft-hover'), null);
  assert.equal(query(mounted.frame, 'papercraft-hover-label'), null);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('the new comment opens in a popover, and the hover label steps aside while it is open', async () => {
  const h = harness();
  const { mounted } = await commenting(h);
  const pay = shadowOf(mounted.frame).querySelector('#pay') as Element;

  await react.act(async () => {
    pay.dispatchEvent(
      new window.PointerEvent('pointermove', {
        bubbles: true,
        composed: true,
      }) as never,
    );
  });
  assert.ok(query(mounted.frame, 'papercraft-hover-label') !== null);

  await clickIn(pay);
  const popover = query(mounted.frame, 'papercraft-comment-input');
  assert.ok(popover !== null, 'the inline input never opened');
  // The thread's surface: the popover colours, a border, a radius.
  for (const surface of [
    /\bbg-popover\b/,
    /\btext-popover-foreground\b/,
    /\bborder\b/,
    /\brounded-lg\b/,
  ])
    assert.match(popover.className, surface);
  // The label never covers the field or its pending pin.
  assert.equal(query(mounted.frame, 'papercraft-hover-label'), null);

  // Esc still cancels, and the label comes back.
  await key(inputOf(mounted.frame) as HTMLTextAreaElement, 'Escape');
  assert.equal(query(mounted.frame, 'papercraft-comment-input'), null);
  assert.ok(query(mounted.frame, 'papercraft-hover-label') !== null);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('a click opens the inline input; Enter confirms one draft with its note', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(h);

  await clickIn(shadowOf(mounted.frame).querySelector('#pay') as Element);

  const field = inputOf(mounted.frame);
  assert.ok(field !== null, 'the inline input never opened');
  assert.equal(field.getAttribute('placeholder'), 'Adicionar comentário');
  // Nothing reached the stack while the note is being written.
  assert.equal(composer.added.length, 0);
  assert.equal(
    (query(mounted.frame, 'papercraft-comment-confirm') as HTMLButtonElement)
      .disabled,
    true,
  );

  await react.act(async () => type(field, 'mais respiro'));
  // Shift+Enter breaks the line: nothing is confirmed.
  await key(field, 'Enter', { shiftKey: true });
  await tick();
  assert.equal(composer.added.length, 0);
  assert.ok(inputOf(mounted.frame) !== null);
  await key(field, 'Enter');

  await settle(
    () => composer.added.length,
    (length) => length === 1,
    'the confirmed note never joined the stack',
  );
  const added = composer.added[0] as {
    threadId: string;
    note: string;
    elementTag: string;
    data: {
      target: {
        kind: string;
        id: string;
        revision: number;
        anchor: {
          form: string;
          path?: string;
          line?: number;
          selector?: string;
        };
      };
      pin: number;
      inReplyTo?: string;
      refs: { title?: string; source?: string };
    };
  };
  assert.equal(added.threadId, 't-123');
  assert.equal(added.note, 'mais respiro');
  // Chat draws the line itself.
  assert.equal(added.elementTag, 'chat-comment-line');
  assert.equal(added.data.target.kind, 'artifact');
  assert.equal(added.data.target.id, 'checkout-7f3a');
  assert.equal(added.data.target.revision, 1);
  assert.equal(added.data.target.anchor.form, 'source');
  assert.equal(added.data.target.anchor.path, 'src/checkout.html');
  assert.equal(added.data.target.anchor.line, 42);
  assert.equal(added.data.target.anchor.selector, 'button#pay');
  // Where it was clicked, for a later revision without the element.
  const recorded = added.data.target.anchor as { x?: unknown; y?: unknown };
  assert.equal(typeof recorded.x, 'number');
  assert.equal(typeof recorded.y, 'number');
  assert.equal(added.data.pin, 1);
  assert.equal(added.data.inReplyTo, undefined);
  assert.deepEqual(added.data.refs, {
    title: 'Checkout',
    source: 'src/checkout.html',
  });

  // The input closes, the draft is a numbered pin, and comment mode stays.
  await settle(
    () => query(mounted.frame, 'papercraft-pin')?.getAttribute('data-pin'),
    (pin) => pin === '1',
    'the draft never became a pin',
  );
  assert.equal(query(mounted.frame, 'papercraft-comment-input'), null);
  assert.equal(
    (mounted.frame.querySelector('[data-tool]') as HTMLElement).dataset.tool,
    'comment',
  );
  // Still a draft: nothing durable was written.
  assert.equal(h.comments.length, 0);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('an empty input that loses focus is discarded, and Esc cancels a written one', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(h);
  const pay = shadowOf(mounted.frame).querySelector('#pay') as Element;

  await clickIn(pay);
  await react.act(async () => inputOf(mounted.frame)?.blur());
  assert.equal(query(mounted.frame, 'papercraft-comment-input'), null);

  // The focus left the node with the input: the next press only focuses it.
  await focusNode(mounted.frame);
  await clickIn(pay);
  const field = inputOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'deixa pra lá'));
  await key(field, 'Escape');
  assert.equal(query(mounted.frame, 'papercraft-comment-input'), null);

  await tick();
  assert.equal(composer.added.length, 0);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('Alt forces a free point over an element', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(h);

  await clickIn(shadowOf(mounted.frame).querySelector('#pay') as Element, {
    altKey: true,
  });
  const field = inputOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'aqui'));
  await key(field, 'Enter');

  await settle(
    () => composer.added.length,
    (length) => length === 1,
    'the note never joined the stack',
  );
  const data = composer.added[0]?.data as
    | { target?: { anchor?: { form?: string } } }
    | undefined;
  assert.equal(data?.target?.anchor?.form, 'point');

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

/** Opens one `⋯` menu of the thread the way the keyboard does. */
const openMenu = async (trigger: Element) => {
  await key(trigger, 'Enter');
  await react.act(async () => {
    await tick();
  });
};

/** Picks one item of an open menu. */
const pick = async (frame: HTMLElement, testId: string) => {
  const item = await settle(
    () => query(frame, testId),
    (found) => found !== null,
    `the menu item ${testId} never showed`,
  );

  await react.act(async () => {
    item?.click();
    await tick();
  });
};

const threadOf = (frame: HTMLElement) => query(frame, 'papercraft-thread');

const replyFieldOf = (frame: HTMLElement) =>
  threadOf(frame)?.querySelector('textarea') as HTMLTextAreaElement | null;

test('a draft pin opens its thread; a reply joins the stack answering it', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(
    h,
    fakeComposer([draftOf('comment-d1', 1, 'primeira versão')]),
  );

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the draft never became a pin',
  );
  assert.equal(pin?.dataset.state, 'draft');
  await react.act(async () => pin?.click());

  const thread = threadOf(mounted.frame) as HTMLElement;
  assert.ok(thread !== null, 'the thread never opened');
  assert.equal(pin?.dataset.active, 'true');
  const messages = thread.querySelectorAll(
    '[data-testid="papercraft-thread-message"]',
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0]?.textContent ?? '', /na pilha/);
  assert.match(messages[0]?.textContent ?? '', /primeira versão/);
  // A draft root cannot be resolved: there is nothing durable yet.
  assert.equal(query(thread, 'papercraft-thread-resolve'), null);

  const field = replyFieldOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'e o espaçamento?'));
  await key(field, 'Enter');

  await settle(
    () => composer.added.length,
    (length) => length === 1,
    'the reply never joined the stack',
  );
  const reply = composer.added[0] as {
    note: string;
    data: { inReplyTo?: string; pin?: number; target?: { id?: string } };
  };
  assert.equal(reply.note, 'e o espaçamento?');
  assert.equal(reply.data.inReplyTo, 'comment-d1');
  assert.equal(reply.data.pin, 1);
  assert.equal(reply.data.target?.id, 'checkout-7f3a');
  // Nothing durable: the reply leaves with the next prompt.
  assert.equal(h.comments.length, 0);
  // The thread stays open with the reply drafted under its root.
  await settle(
    () =>
      threadOf(mounted.frame)?.querySelectorAll(
        '[data-testid="papercraft-thread-message"]',
      ).length,
    (length) => length === 2,
    'the drafted reply never showed in the thread',
  );

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('a draft of the thread is edited from its menu, and saving it empty removes it', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(
    h,
    fakeComposer([
      draftOf('comment-d1', 1, 'primeira versão'),
      draftOf('comment-r1', 1, 'uma resposta', { inReplyTo: 'comment-d1' }),
    ]),
  );

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the draft never became a pin',
  );
  // The draft reply is no pin of its own.
  assert.equal(
    mounted.frame.querySelectorAll('[data-testid="papercraft-pin"]').length,
    1,
  );
  await react.act(async () => pin?.click());

  const mores = threadOf(mounted.frame)?.querySelectorAll(
    '[data-testid="papercraft-message-more"]',
  );
  await openMenu(mores?.[0] as Element);
  await pick(mounted.frame, 'papercraft-message-edit');

  const field = replyFieldOf(mounted.frame) as HTMLTextAreaElement;
  assert.equal(field.value, 'primeira versão');
  assert.equal(field.getAttribute('placeholder'), 'Editar comentário…');
  await react.act(async () => type(field, 'segunda versão'));
  await key(field, 'Enter');
  await settle(
    () => composer.notes.length,
    (length) => length === 1,
    'the edit never reached the stack',
  );
  assert.deepEqual(composer.notes, [
    { id: 'comment-d1', note: 'segunda versão' },
  ]);

  // Editing the root again and saving it empty drops it and its replies.
  const again = threadOf(mounted.frame)?.querySelectorAll(
    '[data-testid="papercraft-message-more"]',
  );
  await openMenu(again?.[0] as Element);
  await pick(mounted.frame, 'papercraft-message-edit');
  const emptied = replyFieldOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(emptied, ''));
  await key(emptied, 'Enter');
  await settle(
    () => composer.removed.length,
    (length) => length === 2,
    'the emptied draft was never removed',
  );
  assert.deepEqual([...composer.removed].sort(), ['comment-d1', 'comment-r1']);
  await settle(
    () => threadOf(mounted.frame),
    (found) => found === null,
    'the thread of a removed draft stayed open',
  );
  assert.equal(composer.added.length, 0);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('a draft is removed from the stack from its thread', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(
    h,
    fakeComposer([draftOf('comment-d1', 1, 'primeira versão')]),
  );

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the draft never became a pin',
  );
  await react.act(async () => pin?.click());

  await openMenu(query(mounted.frame, 'papercraft-thread-more') as Element);
  await pick(mounted.frame, 'papercraft-thread-remove');
  await settle(
    () => composer.removed.length,
    (length) => length === 1,
    'the removal never reached the stack',
  );
  assert.deepEqual(composer.removed, ['comment-d1']);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('Esc closes a thread without adding what its field holds', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(
    h,
    fakeComposer([draftOf('comment-d1', 1, 'primeira versão')]),
  );

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the draft never became a pin',
  );
  await react.act(async () => pin?.click());
  const field = replyFieldOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'deixa'));
  await key(field, 'Escape');

  assert.equal(threadOf(mounted.frame), null);
  await tick();
  assert.equal(composer.added.length, 0);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('sent pins say where their thread stands, and the control counts the open ones', async () => {
  const h = harness();
  h.durable.push(
    sentOf('c-open', 'mais respiro'),
    sentOf('c-reply', 'qual cor?', { author: 'agent', inReplyTo: 'c-open' }),
    sentOf('c-me', 'azul', { inReplyTo: 'c-open' }),
    sentOf('c-await', 'o título'),
    sentOf('c-agent', 'maior ou menor?', {
      author: 'agent',
      inReplyTo: 'c-await',
    }),
    sentOf('c-done', 'pronto', { resolved: true }),
  );
  const { mounted } = await commenting(h);

  const stateOfPin = (number: string) =>
    mounted.frame.querySelector(
      `[data-testid="papercraft-pin"][data-pin="${number}"]`,
    ) as HTMLElement | null;

  await settle(
    () => stateOfPin('3')?.dataset.state,
    (state) => state === 'done',
    'the resolved thread never became a pin',
  );
  // The reader answered last: open, with its replies counted.
  assert.equal(stateOfPin('1')?.dataset.state, 'open');
  assert.equal(
    stateOfPin('1')?.querySelector('[data-testid="papercraft-pin-badge"]')
      ?.textContent,
    '2',
  );
  // The agent asked last: the thread awaits the reader.
  assert.equal(stateOfPin('2')?.dataset.state, 'await');
  assert.equal(
    stateOfPin('2')?.querySelector('[data-testid="papercraft-pin-badge"]')
      ?.textContent,
    '?',
  );
  assert.equal(
    stateOfPin('3')?.querySelector('[data-testid="papercraft-pin-badge"]')
      ?.textContent,
    '✓',
  );
  // The replies are no pins; the control counts the unresolved roots.
  assert.equal(
    mounted.frame.querySelectorAll('[data-testid="papercraft-pin"]').length,
    3,
  );
  assert.equal(
    query(mounted.frame, 'papercraft-comment-count')?.textContent,
    '2',
  );

  // The header hides the resolved pins, and shows them again.
  const eye = query(mounted.frame, 'papercraft-show-resolved') as HTMLElement;
  assert.ok(eye !== null, 'no show/hide control with a resolved thread');
  await react.act(async () => eye.click());
  assert.equal(stateOfPin('3'), null);
  await react.act(async () => eye.click());
  assert.equal(stateOfPin('3')?.dataset.state, 'done');

  // The awaiting thread opens with its messages and its state chip.
  await react.act(async () => stateOfPin('2')?.click());
  const thread = threadOf(mounted.frame) as HTMLElement;
  assert.equal(
    query(thread, 'papercraft-thread-title')?.textContent,
    'checkout:42',
  );
  assert.equal(
    thread.querySelectorAll('[data-testid="papercraft-thread-message"]').length,
    2,
  );
  assert.match(
    query(thread, 'papercraft-thread-state')?.textContent ?? '',
    /aguardando você/,
  );

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('threads and drafts of an earlier revision carry over to the newest, keeping their numbers', async () => {
  const h = harness();
  h.durable.push(sentOf('c1', 'mais respiro'));
  const { mounted, composer } = await commenting(
    h,
    fakeComposer([draftOf('comment-d1', 1, 'e o título?', { pin: 2 })]),
    2,
  );

  const pinOf = (number: string) =>
    mounted.frame.querySelector(
      `[data-testid="papercraft-pin"][data-pin="${number}"]`,
    ) as HTMLElement | null;

  await settle(
    () => [pinOf('1')?.dataset.state, pinOf('2')?.dataset.state],
    ([sent, drafted]) => sent === 'open' && drafted === 'draft',
    "revision 1's thread and draft never showed on revision 2",
  );
  assert.equal(
    query(mounted.frame, 'papercraft-comment-count')?.textContent,
    '2',
  );

  // A reply answers the root on the root's own target.
  await react.act(async () => pinOf('1')?.click());
  const field = replyFieldOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'ainda apertado'));
  await key(field, 'Enter');
  await settle(
    () => composer.added.length,
    (length) => length === 1,
    'the reply never joined the stack',
  );
  const reply = composer.added[0]?.data as {
    inReplyTo?: string;
    target?: { revision?: number };
  };
  assert.equal(reply.inReplyTo, 'c1');
  assert.equal(reply.target?.revision, 1);
  await key(replyFieldOf(mounted.frame) as HTMLTextAreaElement, 'Escape');

  // A new comment is written against the revision on screen, numbered next.
  await clickIn(shadowOf(mounted.frame).querySelector('#title') as Element);
  const input = inputOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(input, 'novo'));
  await key(input, 'Enter');
  await settle(
    () => composer.added.length,
    (length) => length === 2,
    'the new comment never joined the stack',
  );
  const added = composer.added[1]?.data as {
    pin?: number;
    target?: { revision?: number };
  };
  assert.equal(added.target?.revision, 2);
  assert.equal(added.pin, 3);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('a thread whose element is gone from the revision on screen stays a reachable pin', async () => {
  const h = harness();
  h.durable.push(
    sentOf('c-gone', 'a seção antiga', {
      target: {
        kind: 'artifact',
        id: 'checkout-7f3a',
        revision: 1,
        anchor: {
          form: 'source',
          path: 'src/old.html',
          line: 7,
          selector: 'section#gone',
        },
      },
    }),
  );
  const { mounted } = await commenting(h, fakeComposer(), 2);

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the thread without its element was dropped',
  );
  assert.equal(pin?.dataset.detached, 'true');
  assert.equal(
    query(mounted.frame, 'papercraft-comment-count')?.textContent,
    '1',
  );

  await react.act(async () => pin?.click());
  assert.match(threadOf(mounted.frame)?.textContent ?? '', /a seção antiga/);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('a sent thread resolves under the prompt its root was written in', async () => {
  const h = harness();
  const target = {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { form: 'source', path: 'src/checkout.html', line: 42 },
  };
  h.log = [
    logged('comments.added/v1', 'prompt-root', {
      commentId: 'c1',
      target,
      text: 'mais respiro',
    }),
    logged('comments.added/v1', 'prompt-agent', {
      commentId: 'c2',
      target,
      text: 'feito',
      author: 'agent',
      inReplyTo: 'c1',
    }),
  ];
  const { mounted } = await commenting(h);

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found?.dataset.state === 'await',
    'the logged thread never became an awaiting pin',
  );
  await react.act(async () => pin?.click());

  const resolve = query(
    mounted.frame,
    'papercraft-thread-resolve',
  ) as HTMLButtonElement;
  assert.equal(resolve.disabled, false);
  await react.act(async () => resolve.click());

  await settle(
    () => h.resolves.length,
    (length) => length === 1,
    'the resolve was never asked',
  );
  assert.deepEqual(h.resolves[0]?.input, { commentId: 'c1', resolved: true });
  assert.deepEqual(h.resolves[0]?.scope, {
    projectId: 'p1',
    threadId: 't-123',
    promptId: 'prompt-root',
  });

  comment.setComposerAvailable(false);
  await mounted.unmount();
  h.log = undefined;
});

test('the durable comments are not listed again while the Thread log answers', async () => {
  const h = harness();
  const target = {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 1,
    anchor: { form: 'source', path: 'src/checkout.html', line: 42 },
  };
  h.log = [
    logged('comments.added/v1', 'prompt-root', {
      commentId: 'c1',
      target,
      text: 'mais respiro',
    }),
  ];
  const { mounted } = await commenting(h);

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the logged thread never became a pin',
  );
  const listed = h.lists;

  // A resolve asks the comments to be read again: the log answers, so the
  // list is not.
  await react.act(async () => pin?.click());
  await react.act(async () => {
    query(mounted.frame, 'papercraft-thread-resolve')?.click();
  });
  await settle(
    () => h.resolves.length,
    (length) => length === 1,
    'the resolve was never asked',
  );
  await tick();
  await tick();

  assert.equal(h.lists, listed);

  comment.setComposerAvailable(false);
  await mounted.unmount();
  h.log = undefined;
});

test('a thread whose prompt is unknown cannot be resolved', async () => {
  const h = harness();
  h.durable.push(sentOf('c1', 'mais respiro'));
  const { mounted } = await commenting(h);

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the sent comment never became a pin',
  );
  await react.act(async () => pin?.click());

  const resolve = query(
    mounted.frame,
    'papercraft-thread-resolve',
  ) as HTMLButtonElement;
  assert.equal(resolve.disabled, true);
  assert.equal(h.resolves.length, 0);

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

/** The conversation asking to see a thread, as chat dispatches it. */
const askThread = (from: Element, detail: object) =>
  react.act(async () => {
    from.dispatchEvent(
      new window.CustomEvent('doric:comment-thread-open', {
        bubbles: true,
        detail,
      }) as never,
    );
    await tick();
  });

test('the conversation opens a thread of this preview, and only of its own revision', async () => {
  const h = harness();
  h.durable.push(
    sentOf('c1', 'mais respiro'),
    sentOf('c2', 'feito', { author: 'agent', inReplyTo: 'c1' }),
  );
  comment.setComposerAvailable(true);
  const mounted = await h.mount('node', { blockRevision: 1 });
  await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the sent comment never became a pin',
  );
  const elsewhere = document.body;

  // Another artifact's thread, and another revision's, are not this node's.
  await askThread(elsewhere, {
    commentId: 'c1',
    target: { kind: 'artifact', id: 'other-1', revision: 1 },
  });
  await askThread(elsewhere, {
    commentId: 'c1',
    target: { kind: 'artifact', id: 'checkout-7f3a', revision: 2 },
  });
  assert.equal(threadOf(mounted.frame), null);

  // A reply's id opens its root's thread.
  await askThread(elsewhere, {
    commentId: 'c2',
    target: { kind: 'artifact', id: 'checkout-7f3a', revision: 1 },
  });
  const thread = await settle(
    () => threadOf(mounted.frame),
    (found) => found !== null,
    'the asked thread never opened',
  );
  assert.equal(
    thread?.querySelectorAll('[data-testid="papercraft-thread-message"]')
      .length,
    2,
  );
  assert.equal(query(mounted.frame, 'papercraft-pin')?.dataset.active, 'true');

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('the window opens the asked thread on the revision on screen', async () => {
  const h = harness();
  h.durable.push(sentOf('c1', 'na revisão um'));
  const mounted = await h.mount('canvas', {});
  await settle(
    () => h.reads.at(-1)?.revision,
    (revision) => revision === 2,
    'the window never opened at the newest revision',
  );

  await askThread(document.body, {
    commentId: 'c1',
    target: { kind: 'artifact', id: 'checkout-7f3a', revision: 1 },
  });

  const thread = await settle(
    () => threadOf(mounted.frame),
    (found) => found !== null,
    'the asked thread never opened',
  );
  assert.match(thread?.textContent ?? '', /na revisão um/);
  // Every revision shows every thread: the newest stays on screen.
  assert.equal(h.reads.at(-1)?.revision, 2);

  await mounted.unmount();
});

test('a thread asked for without a revision opens on the node of the newest revision only', async () => {
  const older = harness();
  const newer = harness();
  for (const h of [older, newer]) h.durable.push(sentOf('c1', 'mais respiro'));
  const first = await older.mount('node', { blockRevision: 1 });
  const second = await newer.mount('node', { blockRevision: 2 });
  for (const mounted of [first, second])
    await settle(
      () => query(mounted.frame, 'papercraft-pin'),
      (found) => found !== null,
      'the thread never became a pin',
    );

  await askThread(document.body, {
    commentId: 'c1',
    target: { kind: 'artifact', id: 'checkout-7f3a' },
  });

  await settle(
    () => threadOf(second.frame),
    (found) => found !== null,
    'the newest node never opened the thread',
  );
  assert.equal(threadOf(first.frame), null);

  await first.unmount();
  await second.unmount();
});

test('Cmd+Enter confirms the open note and sends the stack through chat', async () => {
  const h = harness();
  const { mounted, composer } = await commenting(h);

  await clickIn(shadowOf(mounted.frame).querySelector('#pay') as Element);
  const field = inputOf(mounted.frame) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'manda já'));
  await key(field, 'Enter', { metaKey: true });

  await settle(
    () => h.sends.length,
    (length) => length === 1,
    'the stack was never sent',
  );
  assert.equal(composer.added.length, 1);
  assert.equal(composer.added[0]?.note, 'manda já');
  assert.deepEqual(h.sends[0]?.input, { projectId: 'p1', threadId: 't-123' });

  // On the focused canvas, with nothing open, it sends too.
  await key(
    mounted.frame.querySelector('.papercraft-canvas') as Element,
    'Enter',
    { ctrlKey: true },
  );
  await settle(
    () => h.sends.length,
    (length) => length === 2,
    'the canvas never sent',
  );

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

test('the body the frame mounts arms its comment mode, even when chat comes late', async () => {
  const h = harness();
  const composer = fakeComposer();
  h.composer = composer.api;

  // The body as the registry's frame mounts it: `<papercraft-preview>` with
  // the frame's block, the frame's comment gesture reaching `comment(detail)`.
  const tag = 'papercraft-preview-body-test';
  if (customElements.get(tag) === undefined) {
    customElements.define(tag, elements.definePreviewElement());
  }
  const body = document.createElement(tag) as HTMLElement & {
    services: unknown;
    block: unknown;
    comment: (detail: unknown) => void;
  };
  body.services = h.services;
  body.block = {
    id: 'artifacts:checkout-7f3a@1',
    type: 'papercraft.preview/v1',
    data: {
      artifactId: 'checkout-7f3a',
      revision: 1,
      kind: 'preview',
      title: 'Checkout',
      targets: [],
      entries: [{ path: 'index.html', sha256: 'abc' }],
      createdAt: '',
      projectId: 'p1',
      threadId: 't-123',
    },
  };
  const detail = { artifactId: 'checkout-7f3a', revision: 1, kind: 'preview' };
  const toolOf = () =>
    (body.querySelector('[data-tool]') as HTMLElement | null)?.dataset.tool;

  comment.setComposerAvailable(false);
  await react.act(async () => {
    document.body.append(body);
  });
  await settle(toolOf, (tool) => tool === 'select', 'the body never rendered');

  await react.act(async () => body.comment(detail));
  assert.equal(toolOf(), 'select');

  await react.act(async () => {
    comment.setComposerAvailable(true);
  });
  await react.act(async () => body.comment(detail));
  await settle(
    toolOf,
    (tool) => tool === 'comment',
    'the late composer never armed the gesture',
  );

  await clickIn(shadowOf(body).querySelector('#pay') as Element);
  const field = inputOf(body) as HTMLTextAreaElement;
  await react.act(async () => type(field, 'aumenta o respiro do botão'));
  await key(field, 'Enter');
  await settle(
    () => composer.added.length,
    (length) => length === 1,
    'the note never joined the stack',
  );

  // The composer was called in the preview's Project and Thread.
  assert.ok(
    h.scopes.some(
      (scope) =>
        (scope as { threadId?: string }).threadId === 't-123' &&
        (scope as { projectId?: string }).projectId === 'p1',
    ),
  );

  // The flush the main process registers answers the durable write the
  // sender performs once the prompt is accepted.
  const data = composer.added[0]?.data as { anchor: unknown };
  const writes = await papercraftFlush(
    {
      id: 'i1',
      kind: 'papercraft-preview',
      elementTag: 'chat-comment-line',
      data,
      note: '  aumenta o respiro do botão  ',
    },
    { threadId: 't-123', promptId: 'p-1' },
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.text, 'aumenta o respiro do botão');
  assert.equal(h.comments.length, 0);

  comment.setComposerAvailable(false);
  await react.act(async () => body.remove());
});

test('the papercraft flush writes the item as the comment, under its own id', async () => {
  const context = { threadId: 't-123', promptId: 'p-1' };
  const target = {
    kind: 'artifact',
    id: 'checkout-7f3a',
    revision: 2,
    anchor: { form: 'selector', selector: 'button#pay' },
  };
  const item = (id: string, data: unknown, note: string, author?: string) => ({
    id,
    kind: 'papercraft-preview',
    elementTag: 'chat-comment-line',
    data,
    note,
    ...(author === undefined ? {} : { author }),
  });

  // A blank note answers no write — nothing was asked yet.
  assert.deepEqual(
    await papercraftFlush(
      item('comment-a', { target, pin: 3 }, '   '),
      context,
    ),
    [],
  );

  // An item whose data no longer names a target is not ours.
  assert.deepEqual(
    await papercraftFlush(
      item('comment-b', { something: 'else' }, 'não é meu'),
      context,
    ),
    [],
  );

  // A root carries its id and its author through.
  assert.deepEqual(
    await papercraftFlush(
      item('comment-c', { target, pin: 3 }, ' aumenta o respiro ', 'ada'),
      context,
    ),
    [
      {
        target,
        text: 'aumenta o respiro',
        commentId: 'comment-c',
        author: 'ada',
      },
    ],
  );

  // A reply names the root it answers.
  assert.deepEqual(
    await papercraftFlush(
      item('comment-d', { target, pin: 3, inReplyTo: 'comment-c' }, 'e mais'),
      context,
    ),
    [
      {
        target,
        text: 'e mais',
        commentId: 'comment-d',
        inReplyTo: 'comment-c',
      },
    ],
  );

  // A draft written before items carried their target still flushes.
  assert.deepEqual(
    await papercraftFlush(
      item(
        'comment-e',
        {
          artifactId: 'checkout-7f3a',
          revision: 2,
          anchor: target.anchor,
          pin: 1,
          point: { x: 10, y: 20 },
        },
        'antigo',
      ),
      context,
    ),
    [{ target, text: 'antigo', commentId: 'comment-e' }],
  );
});

test('a draft written before items carried their target is still a pin', async () => {
  const h = harness();
  const { mounted } = await commenting(
    h,
    fakeComposer([
      {
        id: 'i1',
        kind: 'papercraft-preview',
        elementTag: 'papercraft-comment-card',
        data: {
          artifactId: 'checkout-7f3a',
          revision: 1,
          anchor: { form: 'point', x: 10, y: 20 },
          pin: 4,
          point: { x: 10, y: 20 },
        },
        note: 'antigo',
      },
    ]),
  );

  const pin = await settle(
    () => query(mounted.frame, 'papercraft-pin'),
    (found) => found !== null,
    'the old draft never became a pin',
  );
  assert.equal(pin?.dataset.pin, '4');
  assert.equal(pin?.dataset.state, 'draft');

  comment.setComposerAvailable(false);
  await mounted.unmount();
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

test('the node footer zooms, returns to 100% and centres', async () => {
  const h = harness();
  const mounted = await h.mount('node', {});
  await focusNode(mounted.frame);
  const footer = mounted.frame.querySelector(
    '[data-testid="papercraft-footer"]',
  ) as HTMLElement;
  const reading = () =>
    footer.querySelector('[data-testid="papercraft-zoom-reset"]')
      ?.textContent ?? '';
  const press = async (id: string) => {
    (footer.querySelector(`[data-testid="${id}"]`) as HTMLElement).click();
    await tick();
    await tick();
  };

  assert.match(reading(), /100%/);
  assert.ok(footer.querySelector('[aria-label="Centralizar"]'));

  await press('papercraft-zoom-in');
  assert.match(reading(), /120%/);

  await press('papercraft-zoom-out');
  await press('papercraft-zoom-out');
  assert.match(reading(), /83%/);

  await press('papercraft-zoom-reset');
  assert.match(reading(), /100%/);

  // The window has its own command bar, not this footer.
  const window_ = await h.mount('canvas', {});
  assert.equal(
    window_.frame.querySelector('[data-testid="papercraft-footer"]'),
    null,
  );

  await window_.unmount();
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

test('the window sends its drafts from the header, having no prompt of its own', async () => {
  const h = harness();
  const composer = fakeComposer([draftOf('d1', 2, 'ajuste o botão')]);
  h.composer = composer.api;
  comment.setComposerAvailable(true);
  const mounted = await h.mount('canvas', {});

  const send = await settle(
    () => query(mounted.frame, 'papercraft-send'),
    (found) => found !== null,
    'the send button never showed for the draft',
  );
  assert.match(send?.textContent ?? '', /Enviar ao agente \(1\)/);
  // The window has no `abrir`: it is the window.
  assert.equal(query(mounted.frame, 'papercraft-open'), null);

  await react.act(async () => send?.click());
  await settle(
    () => h.sends.length,
    (length) => length === 1,
    'the stack was never sent',
  );
  assert.deepEqual(h.sends[0]?.input, { projectId: 'p1', threadId: 't-123' });

  comment.setComposerAvailable(false);
  await mounted.unmount();
});

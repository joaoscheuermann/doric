// The papercraft client part as a window runs it: `activate` over a services
// double that answers by contract id and records each call with the scope of
// its `use`. The chat is a double of `chat.views/v1` (the fence renderers and
// projectors registered, `watchFences`), the host's `papercraft.programs/v1`,
// the desktop's `papercraft.cache/v1` and `openui.programs/v1` are doubles at
// their bridge boundary, and every frame is a fake (`fake-frame.ts`) that
// speaks the protocol its iframe's entry speaks. The window is whatever DOM
// the test file installed as globals first (`./dom.js`, or its own).

import assert from 'node:assert/strict';

import {
  type ClientContext,
  ContractError,
  type Services,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';
import { act } from 'react';

import { activate } from '../../../src/client/index.js';
import type {
  ChatFence,
  ChatFenceView,
  FenceRendererSpec,
  ProjectorSpec,
} from '../../../src/contracts/chat.js';
import type {
  ExportAnswer,
  LibraryAnswer,
  ModuleEntries,
  ModuleRef,
} from '../../../src/contracts/programs.js';
import {
  delivered,
  type FakeFrame,
  type FakeFrames,
  type FakeOptions,
  fakeFrames,
} from './fake-frame.js';

/** The DOM the test file installed as this process's globals. */
const dom = () =>
  globalThis.window as unknown as Window &
    typeof globalThis & {
      readonly happyDOM?: unknown;
    };

export const PROJECT = 'p1';
export const THREAD = 't1';
export const MODULES = 'doric://app/papercraft-modules/';

/** A module the host's memo holds, as `ModuleRef` names it. */
export const moduleRef = (dir: string, css = true): ModuleRef => ({
  dir,
  files: [
    { path: 'index.js', sha256: `${dir}-js` },
    ...(css ? [{ path: 'index.css', sha256: `${dir}-css` }] : []),
  ],
});

/** A library answer `ready` with the module of `dir`. */
export const readyLibrary = (dir = 'lib0'): LibraryAnswer => ({
  status: 'ready',
  root: '/workspace/app',
  module: moduleRef(dir),
});

/** One papercraft fence of the Thread, as the chat lists it. */
export const programFence = (
  body: string,
  options: {
    readonly identity?: string;
    readonly state?: ChatFence['state'];
    readonly promptId?: string;
    readonly turnSequence?: number;
    readonly index?: number;
    readonly threadId?: string;
  } = {},
): ChatFence => {
  const promptId = options.promptId ?? 'p-1';
  const turnSequence = options.turnSequence ?? 3;
  const index = options.index ?? 0;

  return {
    key: `${promptId}/${String(turnSequence)}/${String(index)}`,
    projectId: PROJECT,
    threadId: options.threadId ?? THREAD,
    promptId,
    turnSequence,
    index,
    info: `papercraft ${options.identity ?? 'settings'}`,
    body,
    state: options.state ?? 'closed',
  };
};

/** The view chat sets on a fence element: the fence and its tag's fences. */
export const viewOf = (
  fence: ChatFence,
  fences: readonly ChatFence[] = [fence],
): ChatFenceView => ({ fence, origin: 'agent', fences });

export interface Recorded {
  readonly input: unknown;
  readonly scope: unknown;
}

/** An artifact of the old path, as `artifacts/v1` and `papercraft.previews/v1` serve it. */
export interface ArtifactFixture {
  readonly artifactId: string;
  readonly title: string;
  readonly markup: string;
  readonly revisions?: number;
}

export interface HostCalls {
  readonly library: Recorded[];
  readonly exports: Recorded[];
  readonly reads: Recorded[];
  readonly ensures: Recorded[];
  readonly reports: Recorded[];
  readonly windows: Recorded[];
  /** `chat.composer/v1.addItem` inputs. */
  readonly drafts: Recorded[];
  /** `papercraft.previews/v1.read` inputs (the old path). */
  readonly previewReads: Recorded[];
}

export interface HostOptions {
  /** The Generative UI setting when the client activates (on by default). */
  readonly setting?: boolean;
  /** `papercraft.programs/v1.library`; `ready` with `lib0` by default. */
  readonly library?: (input: unknown) => Promise<LibraryAnswer>;
  /** `papercraft.programs/v1.export`; `ready` by default, one dir per key. */
  readonly export?: (input: {
    readonly path: string;
    readonly name?: string;
  }) => Promise<ExportAnswer>;
  /** `papercraft.programs/v1.read`; the bytes of any dir by default. */
  readonly read?: (input: { readonly dir: string }) => Promise<ModuleEntries>;
  /** The fake frames' options (their protocol follows each iframe's entry). */
  readonly frame?: FakeOptions;
  /** The test file's own fake frames, when it has some; the host then makes none. */
  readonly frames?: FakeFrames;
  /** Whether chat's composer is active (it is by default). */
  readonly composer?: boolean;
  /** `comments/v1.list`'s answer. */
  readonly comments?: readonly unknown[];
  /** The Thread's artifacts of the old path; `artifacts/v1.read` refuses others. */
  readonly artifacts?: readonly ArtifactFixture[];
}

export interface Host {
  readonly services: Services;
  readonly calls: HostCalls;
  readonly frames: FakeFrames;
  /** The fence renderers registered now. */
  readonly fenceRenderers: () => readonly FenceRendererSpec[];
  /** Every projector registered so far. */
  readonly projectors: () => readonly ProjectorSpec[];
  /** Turns the Generative UI setting on or off, as `openui.setting/v1.watch` says. */
  readonly setSetting: (enabled: boolean) => Promise<void>;
  /** Lists the Thread's papercraft fences, as `chat.views/v1.watchFences` streams them. */
  readonly setFences: (fences: readonly ChatFence[]) => Promise<void>;
  /** Mounts the element chat mounts for a `papercraft` fence, with `view`. */
  readonly mountFence: (view: ChatFenceView) => Promise<MountedElement>;
  /** Mounts the element the canvas route creates, with its path params. */
  readonly mountRoute: (
    params: Readonly<Record<string, string>>,
  ) => Promise<MountedElement>;
  /** The routes the client registered, by path. */
  readonly routes: () => readonly {
    readonly path: string;
    readonly create: (match: {
      readonly path: string;
      readonly pattern: string;
      readonly params: Readonly<Record<string, string>>;
    }) => object;
  }[];
  readonly dispose: () => Promise<void>;
}

export interface MountedElement {
  readonly element: HTMLElement & { view?: ChatFenceView };
  /** Sets a new `view`, as chat does when the fence changes. */
  readonly update: (view: ChatFenceView) => Promise<void>;
  /** The newest fake frame under the element. */
  readonly frame: () => FakeFrame | undefined;
  readonly text: () => string;
  readonly remove: () => Promise<void>;
}

/** A thenable that is also a `Disposable`: what an unknown contract's method answers. */
const nothing = () =>
  Object.assign(Promise.resolve(undefined), { dispose: () => undefined });

const anyApi = (): unknown =>
  new Proxy(
    {},
    {
      get: (_target, name) => (name === 'then' ? undefined : nothing),
    },
  );

/** Lets queued messages, effects and timers settle inside `act`. */
export const flush = async (rounds = 4): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await delivered();
    });
  }
};

/**
 * Polls until `read()` holds, letting the window settle between reads: the
 * element is driven by effects and by messages the test cannot await.
 */
export const until = async <T>(
  read: () => T,
  holds: (value: T) => boolean,
  message: string,
): Promise<T> => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = read();

    if (holds(value)) return value;

    await act(async () => {
      await new Promise((done) => setTimeout(done, 4));
    });
  }

  throw new Error(message);
};

/** Activates the papercraft client part in the happy-dom window. */
export const startHost = async (options: HostOptions = {}): Promise<Host> => {
  const calls: HostCalls = {
    library: [],
    exports: [],
    reads: [],
    ensures: [],
    reports: [],
    windows: [],
    drafts: [],
    previewReads: [],
  };
  const window = dom();
  const frames =
    options.frames ?? fakeFrames(window as never, options.frame ?? {});
  const artifactOf = (artifactId: string): ArtifactFixture => {
    const found = options.artifacts?.find(
      (artifact) => artifact.artifactId === artifactId,
    );

    if (found === undefined)
      throw new ContractError('not_found', `no artifact ${artifactId}`);

    return found;
  };
  const setting = {
    enabled: options.setting ?? true,
    listeners: [] as StreamListener<{ readonly enabled: boolean }>[],
  };
  const renderers = new Set<FenceRendererSpec>();
  const projectors: ProjectorSpec[] = [];
  const routes: ReturnType<Host['routes']>[number][] = [];
  const fenceWatch = {
    fences: [] as readonly ChatFence[],
    listeners: [] as {
      readonly input: { readonly threadId: string; readonly tag: string };
      readonly listener: StreamListener<readonly ChatFence[]>;
    }[],
  };
  const cleanups: (() => void | Promise<void>)[] = [];
  const modules = new Map<string, ModuleRef>();
  const remember = <A extends { readonly status: string }>(answer: A): A => {
    const module = (answer as { readonly module?: ModuleRef }).module;

    if (module !== undefined) modules.set(module.dir, module);

    return answer;
  };

  const chatViews = {
    registerProjector: (spec: ProjectorSpec) => {
      projectors.push(spec);

      return { dispose: () => undefined };
    },
    registerRenderer: () => ({ dispose: () => undefined }),
    registerFenceRenderer: (spec: FenceRendererSpec) => {
      renderers.add(spec);

      return { dispose: () => renderers.delete(spec) };
    },
    watchFences: (
      input: { readonly threadId: string; readonly tag: string },
      listener: StreamListener<readonly ChatFence[]>,
    ) => {
      const entry = { input, listener };
      fenceWatch.listeners.push(entry);
      toStreamObserver(listener).next(
        fenceWatch.fences.filter(
          (fence) =>
            fence.threadId === input.threadId &&
            fence.info.trim().split(/\s+/)[0] === input.tag,
        ),
      );

      return {
        dispose: () => {
          fenceWatch.listeners = fenceWatch.listeners.filter(
            (other) => other !== entry,
          );
        },
      };
    },
  };

  const composerItems: {
    id: string;
    kind: string;
    elementTag: string;
    data: unknown;
    note: string;
  }[] = [];
  const composerListeners: ((watch: unknown) => void)[] = [];
  const composer = {
    addItem: async (input: {
      threadId: string;
      kind: string;
      elementTag: string;
      data?: unknown;
      note?: string;
    }) => {
      const item = {
        id: `i${String(composerItems.length + 1)}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        note: input.note ?? '',
      };
      composerItems.push(item);
      for (const listener of [...composerListeners])
        listener({ kind: 'added', threadId: input.threadId, item });

      return item;
    },
    updateNote: async () => undefined,
    removeItem: async () => undefined,
    watch: (threadId: string, listener: (watch: unknown) => void) => {
      composerListeners.push(listener);
      listener({
        kind: 'snapshot',
        threadId,
        text: '',
        items: [...composerItems],
      });

      return { dispose: () => undefined };
    },
  };

  const apis = (id: string, scope: unknown): unknown => {
    const record = (into: Recorded[], input: unknown) =>
      into.push({ input, scope });

    switch (id) {
      case 'ui/v1':
        return {
          define: (tag: string, element: CustomElementConstructor) => {
            if (window.customElements.get(tag) === undefined)
              window.customElements.define(tag, element as never);

            return { dispose: () => undefined };
          },
          create: (tag: string, props: Record<string, unknown> = {}) => {
            const element = window.document.createElement(tag) as unknown as {
              services?: Services;
            } & Record<string, unknown>;
            element.services = services;
            Object.assign(element, props);

            return element;
          },
          dispose: () => undefined,
        };
      case 'navigation/v1':
        return {
          register: (route: ReturnType<Host['routes']>[number]) => {
            routes.push(route);

            return { dispose: () => undefined };
          },
        };
      case 'commands/v1':
        return {
          register: () => ({ dispose: () => undefined }),
          execute: async () => undefined,
        };
      case 'menus/v1':
        return { addKeybinding: async () => ({ dispose: () => undefined }) };
      case 'openui.setting/v1':
        return {
          get: async () => ({ enabled: setting.enabled }),
          watch: (listener: StreamListener<{ readonly enabled: boolean }>) => {
            setting.listeners.push(listener);
            toStreamObserver(listener).next({ enabled: setting.enabled });

            return { dispose: () => undefined };
          },
        };
      case 'chat.views/v1':
        return chatViews;
      case 'chat.composer/v1':
        return {
          ...composer,
          addItem: async (input: Parameters<typeof composer.addItem>[0]) => {
            record(calls.drafts, input);

            return composer.addItem(input);
          },
        };
      case 'papercraft.programs/v1':
        return {
          library: async (input: unknown) => {
            record(calls.library, input);

            return remember(
              await (options.library?.(input) ??
                Promise.resolve(readyLibrary())),
            );
          },
          export: async (input: { path: string; name?: string }) => {
            record(calls.exports, input);

            return remember(
              await (options.export?.(input) ??
                Promise.resolve<ExportAnswer>({
                  status: 'ready',
                  module: moduleRef(
                    `x-${input.path.replace(/\W/g, '-')}-${input.name ?? ''}`,
                    false,
                  ),
                })),
            );
          },
          read: async (input: { dir: string }) => {
            record(calls.reads, input);
            if (options.read !== undefined) return options.read(input);

            const module = modules.get(input.dir) ?? moduleRef(input.dir);

            return {
              entries: module.files.map((file) => ({
                path: `${module.dir}/${file.path}`,
                sha256: file.sha256,
                base64: '',
              })),
            };
          },
        };
      case 'papercraft.cache/v1':
        return {
          ensure: async (input: {
            entries: readonly { readonly path: string }[];
          }) => {
            record(calls.ensures, input);

            return {
              written: input.entries.map((entry) => entry.path),
              kept: [],
              failed: [],
            };
          },
        };
      case 'openui.programs/v1':
        return {
          reportErrors: async (input: unknown) => {
            record(calls.reports, input);
          },
        };
      case 'windows/v1':
        return {
          open: async (input: unknown) => {
            record(calls.windows, input);
          },
        };
      case 'comments/v1':
        return {
          list: async () => options.comments ?? [],
          add: async (input: unknown) => input,
          resolve: async () => undefined,
        };
      case 'runtime.threads/v1':
        return { watchThread: () => ({ dispose: () => undefined }) };
      case 'artifacts/v1':
        return {
          read: async (input: { artifactId: string }) => {
            const artifact = artifactOf(input.artifactId);
            const revisions = artifact.revisions ?? 1;

            return {
              artifactId: artifact.artifactId,
              kind: 'preview',
              title: artifact.title,
              revision: revisions,
              revisions,
              targets: [{ path: 'src/checkout.html' }],
              source: 'html',
              path: 'src/checkout.html',
              state: 'open',
              createdAt: '2026-11-06T12:00:00Z',
            };
          },
          policy: async () => ({ policy: 'proceed' }),
          approve: async () => undefined,
        };
      case 'papercraft.previews/v1':
        return {
          read: async (input: { artifactId: string; revision: number }) => {
            record(calls.previewReads, input);
            const artifact = artifactOf(input.artifactId);

            return {
              artifactId: artifact.artifactId,
              revision: input.revision,
              kind: 'preview',
              files: [{ path: 'index.html', sha256: 'abc' }],
              markup: artifact.markup,
            };
          },
        };
      default:
        return anyApi();
    }
  };

  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: { readonly id?: string }, scope?: unknown) =>
      apis(contract.id ?? '', scope),
    whenAvailable: (
      contract: { readonly id?: string },
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      const id = contract.id ?? '';
      const available =
        id === 'chat.views/v1' ||
        (id === 'chat.composer/v1' && options.composer !== false);

      if (available) {
        const cleanup = callback(apis(id, undefined), {
          bundleId: 'chat',
          version: '1.1.0',
        });

        if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
      }

      return { dispose: () => undefined };
    },
  } as unknown as Services;

  let deactivate: (() => void | Promise<void>) | undefined;
  await act(async () => {
    deactivate = activate({ services } as unknown as ClientContext);
    await delivered();
  });

  const container = window.document.createElement('div');
  window.document.body.append(container);

  const mounted = (element: HTMLElement): MountedElement => ({
    element: element as MountedElement['element'],
    update: async (view) => {
      await act(async () => {
        (element as MountedElement['element']).view = view;
        await delivered();
      });
      await flush();
    },
    frame: () => frames.latest(element),
    text: () => element.textContent ?? '',
    remove: async () => {
      await act(async () => {
        element.remove();
        await delivered();
      });
    },
  });

  return {
    services,
    calls,
    frames,
    fenceRenderers: () => [...renderers],
    projectors: () => [...projectors],
    routes: () => [...routes],
    setSetting: async (enabled) => {
      setting.enabled = enabled;
      await act(async () => {
        for (const listener of setting.listeners)
          toStreamObserver(listener).next({ enabled });
        await delivered();
      });
    },
    setFences: async (fences) => {
      fenceWatch.fences = fences;
      await act(async () => {
        for (const { input, listener } of fenceWatch.listeners)
          toStreamObserver(listener).next(
            fences.filter(
              (fence) =>
                fence.threadId === input.threadId &&
                fence.info.trim().split(/\s+/)[0] === input.tag,
            ),
          );
        await delivered();
      });
      await flush();
    },
    mountFence: async (view) => {
      const spec = [...renderers].find((one) => one.tag === 'papercraft');

      if (spec === undefined)
        throw new Error('papercraft registered no renderer for its fences');

      const element = window.document.createElement(
        spec.elementTag,
      ) as unknown as HTMLElement & {
        services?: Services;
        view?: ChatFenceView;
      };
      element.services = services;
      element.view = view;
      await act(async () => {
        container.append(element as never);
        await delivered();
      });
      await flush();

      return mounted(element);
    },
    mountRoute: async (params) => {
      const route = routes.find((one) => one.path.startsWith('/papercraft/'));

      if (route === undefined)
        throw new Error('papercraft registered no canvas route');

      let element: HTMLElement | undefined;
      await act(async () => {
        element = route.create({
          path: `/papercraft/${Object.values(params).join('/')}`,
          pattern: route.path,
          params,
        }) as HTMLElement;
        container.append(element as never);
        await delivered();
      });
      await flush();

      return mounted(element as HTMLElement);
    },
    dispose: async () => {
      await act(async () => {
        container.remove();
        for (const cleanup of cleanups.reverse()) await cleanup();
        await deactivate?.();
        await delivered();
      });
      if (options.frames === undefined) frames.dispose();
    },
  };
};

const testId = (node: MountedElement, id: string) =>
  node.element.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** Sets a controlled field's value the way typing does. */
const typeInto = (field: HTMLTextAreaElement, value: string) => {
  const window = dom();
  Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(field, value);
  field.dispatchEvent(new window.Event('input', { bubbles: true }) as never);
};

/**
 * The reader's comment on the element `selector` of the node's frame: the
 * first press focuses the node and the comment control arms comment mode
 * (`first`), the click opens the inline input, Enter confirms `note`. Answers
 * the `chat.composer/v1.addItem` input it caused.
 */
export const commentOn = async (
  host: Host,
  node: MountedElement,
  selector: string,
  note: string,
  first = true,
): Promise<{ readonly data: unknown; readonly kind: string }> => {
  const frame = node.frame();
  assert.ok(frame !== undefined, 'the node has no live frame');
  const before = host.calls.drafts.length;

  if (first) {
    for (const type of ['down', 'up', 'click'] as const) {
      await act(async () => frame.pointer(type, selector));
      await flush();
    }
    await act(async () => testId(node, 'papercraft-comment')?.click());
    await flush();
  }

  await act(async () => frame.pointer('click', selector, { x: 12, y: 8 }));
  await flush();
  const field = await until(
    () =>
      testId(node, 'papercraft-comment-input')?.querySelector(
        'textarea',
      ) as HTMLTextAreaElement | null,
    (found) => found !== null,
    'the inline input never opened',
  );
  await act(async () => typeInto(field as HTMLTextAreaElement, note));
  await act(async () => {
    field?.dispatchEvent(
      new (dom().KeyboardEvent)('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }) as never,
    );
  });
  await until(
    () => host.calls.drafts.length,
    (count) => count > before,
    'the confirmed note never joined the stack',
  );

  return host.calls.drafts.at(-1)?.input as {
    readonly data: unknown;
    readonly kind: string;
  };
};

/** Mounts the old path's `<papercraft-preview>` for one artifact revision, as the registry's frame does. */
export const mountPreview = async (
  host: Host,
  block: Readonly<Record<string, unknown>>,
): Promise<MountedElement> => {
  const ui = host.services.use({ id: 'ui/v1' } as never) as {
    create(tag: string, props?: Readonly<Record<string, unknown>>): object;
  };
  const element = ui.create('papercraft-preview', { block }) as HTMLElement;
  await act(async () => {
    dom().document.body.append(element as never);
    await delivered();
  });
  await flush();

  return {
    element: element as MountedElement['element'],
    update: async () => undefined,
    frame: () => host.frames.latest(element),
    text: () => element.textContent ?? '',
    remove: async () => {
      await act(async () => {
        element.remove();
        await delivered();
      });
    },
  };
};

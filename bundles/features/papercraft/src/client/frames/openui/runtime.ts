// The program frame's runtime (D6, protocol 2): OpenUI's `Renderer` with
// `openuiLibrary`, `Export` and the bound repository library, inside the frame
// shell. It renders one program for its life, takes any number of `program`
// messages without resetting local state, wraps each named statement for the
// scene, posts the renderer's errors, and posts nothing for an action.
//
// With `client/openui-adapter.ts`, the only module of papercraft that imports
// `@openuidev/*` (concept R12, M12). It imports no `.css`: the entry hands it
// its sheets as text (`sheets.ts`).

import * as langCore from '@openuidev/lang-core';
import * as reactLang from '@openuidev/react-lang';
import {
  type DefinedComponent,
  defineComponent,
  type OpenUIError,
  Renderer,
} from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui/genui-lib';
import {
  type ComponentType,
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as zod from 'zod';
import * as zodCore from 'zod/v4/core';

import { SHIM_ABI } from '../../../sandbox/shim-names.js';
import { PROGRAM_PROTOCOL } from '../../frame-constants.js';
import type {
  PreviewTheme,
  ProgramAppMessage,
  ProgramModule,
} from '../../frame-protocol.js';
import { COMPONENT_ATTRIBUTE, STATEMENT_ATTRIBUTE } from '../preview/scene.js';
import {
  type FrameShell,
  type FrameWindow,
  startFrameShell,
} from '../preview/shell.js';

export type { FrameWindow };

type ProgramMessage = Extract<ProgramAppMessage, { kind: 'program' }>;

/** Where the namespaces a compiled library's shims read are published (D13; `sandbox/library.ts`). */
const FRAME_GLOBAL = 'doric.papercraft.openui';

/** How long a sheet may take to load before the frame goes on without it. */
const SHEET_WAIT_MS = 3000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const moduleOf = (value: unknown): ProgramModule | undefined =>
  isRecord(value) &&
  typeof value.module === 'string' &&
  (value.styles === undefined || typeof value.styles === 'string')
    ? {
        module: value.module,
        ...(value.styles === undefined ? {} : { styles: value.styles }),
      }
    : undefined;

/** A `program` message, else undefined. */
const programOf = (
  data: Record<string, unknown>,
): ProgramMessage | undefined => {
  if (
    typeof data.text !== 'string' ||
    typeof data.streaming !== 'boolean' ||
    !isRecord(data.exports)
  )
    return undefined;

  return {
    kind: 'program',
    text: data.text,
    streaming: data.streaming,
    exports: Object.fromEntries(
      Object.entries(data.exports).flatMap(([key, value]) => {
        const built = moduleOf(value);

        return built === undefined ? [] : [[key, built] as const];
      }),
    ),
  };
};

/** A compiled module the frame imports: a library's or an export's. */
interface LoadedModule {
  readonly components?: unknown;
  readonly Harness?: unknown;
  readonly papercraftAbi?: unknown;
  readonly mount?: (
    root: HTMLElement,
    context: { readonly theme: PreviewTheme; readonly args: unknown },
  ) => undefined | (() => void);
}

type Harness = ComponentType<{ theme: PreviewTheme; children?: ReactNode }>;

/** What the frame's components read: the theme and the program with its built exports. */
interface FrameState {
  readonly theme: PreviewTheme;
  readonly program?: ProgramMessage;
}

interface FrameServices {
  readonly reportError: (error: unknown, prefix: string) => void;
  readonly linkSheet: (href: string) => Promise<void>;
}

const ServicesContext = createContext<FrameServices | undefined>(undefined);
const StateContext = createContext<FrameState>({ theme: 'light' });

/** D16: one export, mounted by its module's `mount` in a `<div>`; a placeholder until built. */
function ExportView({
  path,
  name,
  args,
}: {
  readonly path: string;
  readonly name?: string;
  readonly args?: unknown;
}): ReactNode {
  const { theme, program } = useContext(StateContext);
  const services = useContext(ServicesContext);
  const key = `${path}#${name ?? ''}`;
  const built = program?.exports[key];
  const host = useRef<HTMLDivElement>(null);
  const argsText = JSON.stringify(args ?? {});

  useEffect(() => {
    const element = host.current;

    if (built === undefined || element === null || services === undefined)
      return;

    let unmount: (() => void) | undefined;
    let cancelled = false;
    const mount = async (): Promise<void> => {
      if (built.styles !== undefined) await services.linkSheet(built.styles);

      const loaded = (await import(
        /* @vite-ignore */ built.module
      )) as LoadedModule;

      if (cancelled) return;
      if (typeof loaded.mount !== 'function')
        throw new TypeError('The export module exports no mount.');

      const result = loaded.mount(element, {
        theme,
        args: JSON.parse(argsText) as unknown,
      });

      unmount =
        typeof result === 'function' ? result : () => element.replaceChildren();
    };

    mount().catch((error: unknown) =>
      services.reportError(error, `papercraft: Export ${key} did not mount`),
    );

    return () => {
      cancelled = true;
      unmount?.();
    };
  }, [built, theme, argsText, key, services]);

  return built === undefined
    ? createElement(
        'div',
        {
          'data-papercraft-export': key,
          style: {
            padding: '8px',
            font: '12px ui-monospace, monospace',
            opacity: 0.7,
          },
        },
        `Export ${key}…`,
      )
    : createElement('div', { ref: host, 'data-papercraft-export': key });
}

/** Papercraft's built-in `Export(path, name?, props?)` (D16). */
const ExportComponent = defineComponent({
  name: 'Export',
  props: zod.z.object({
    path: zod.z.string().describe('The workspace-relative path of the file'),
    name: zod.z
      .string()
      .optional()
      .describe('The export or story to show; the default export when absent'),
    props: zod.z
      .record(zod.z.string(), zod.z.unknown())
      .optional()
      .describe("Spread over the story's args, or the component's props"),
  }),
  description:
    "A component or story of the repository's own code, built from its file.",
  component: ({ props }) =>
    createElement(ExportView, {
      path: props.path,
      ...(props.name === undefined ? {} : { name: props.name }),
      args: props.props,
    }),
});

/** D19's statement wrapper around the component of every named statement. */
const wrapped = (component: DefinedComponent): DefinedComponent => {
  const Inner = component.component;

  return defineComponent({
    name: component.name,
    props: component.props,
    description: component.description,
    component: (renderProps) =>
      renderProps.statementId === undefined
        ? createElement(Inner, renderProps)
        : createElement(
            'span',
            {
              [STATEMENT_ATTRIBUTE]: renderProps.statementId,
              [COMPONENT_ATTRIBUTE]: component.name,
              style: { display: 'contents' },
            },
            createElement(Inner, renderProps),
          ),
  });
};

/** react-ui's library, `Export` and the repository's components, each wrapped. */
const programLibrary = (repository: readonly DefinedComponent[]) => {
  const added = openuiLibrary.extend({
    components: { add: [ExportComponent, ...repository] },
  });

  return added.extend({
    components: { override: Object.values(added.components).map(wrapped) },
  });
};

type ProgramLibrary = ReturnType<typeof programLibrary>;

const realm = globalThis as { window?: unknown; document?: unknown };

/** Whether the realm had no window and was lent a frame's. */
let lent = false;

/**
 * Starts the protocol-2 runtime on the frame's window, loading `sheets` (the
 * CSS texts of Doric's tokens, react-ui's layered sheet and openui's tokens)
 * as `<style>` elements before anything renders. Returns at once; a failure
 * to render is posted as an `error` message, never thrown.
 */
export const startProgramFrame = (
  win: FrameWindow,
  sheets: readonly string[],
): void => {
  const document = win.document;

  // React DOM reads its realm's `window` (an event's priority, among
  // others). In a frame the realm's global is `win` itself; a realm with no
  // window of its own renders into `win` with `win` as that global.
  if (realm.window === undefined || lent) {
    lent = true;
    realm.window = win;
    realm.document = document;
  }

  // D13: what a compiled library's shims read, before any library loads.
  (win as unknown as Record<symbol, unknown>)[Symbol.for(FRAME_GLOBAL)] = {
    reactLang,
    langCore,
    zod,
    zodCore,
  };

  for (const text of [
    ...sheets,
    'html, body { margin: 0; background: transparent; }',
  ]) {
    const style = document.createElement('style');
    style.textContent = text;
    document.head.append(style);
  }

  let initialized = false;
  let disposed = false;
  let rootElement: HTMLElement | undefined;
  let reactRoot: Root | undefined;
  let state: FrameState = { theme: 'light' };
  const listeners = new Set<() => void>();

  const setState = (next: FrameState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const shell: FrameShell = startFrameShell(win, {
    protocol: PROGRAM_PROTOCOL,
    root: () => rootElement,
    onMessage: (data) => onAppMessage(data),
    onDispose: () => {
      disposed = true;
      reactRoot?.unmount();
      reactRoot = undefined;
      rootElement = undefined;
    },
  });

  const sheetsLinked = new Map<string, Promise<void>>();
  const linkSheet = (href: string): Promise<void> => {
    const known = sheetsLinked.get(href);

    if (known !== undefined) return known;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;

    const settled = new Promise<void>((resolve) => {
      const done = (): void => {
        resolve();
        shell.schedule();
      };

      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
      win.setTimeout(resolve, SHEET_WAIT_MS);
    });

    document.head.append(link);
    sheetsLinked.set(href, settled);

    return settled;
  };

  const onError = (errors: readonly OpenUIError[]): void => {
    shell.send({
      kind: 'errors',
      errors: errors.slice(0, 50).map((error) => ({
        code: error.code.slice(0, 64),
        ...(error.statementId !== undefined &&
        /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(error.statementId)
          ? { statementId: error.statementId }
          : {}),
        message: error.message.slice(0, 1_024),
      })),
    });
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => listeners.delete(listener);
  };
  const services: FrameServices = {
    reportError: (error, prefix) => shell.reportError(error, prefix),
    linkSheet,
  };

  function ProgramView({
    library,
    harness,
  }: {
    readonly library: ProgramLibrary;
    readonly harness?: Harness;
  }): ReactNode {
    const current = useSyncExternalStore(subscribe, () => state);
    const program = current.program;

    if (program === undefined) return null;

    const rendered = createElement(Renderer, {
      response: program.text,
      library,
      isStreaming: program.streaming,
      // Local state only: an action reaches nothing outside the frame.
      onAction: () => undefined,
      onError,
    });

    return createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        StateContext.Provider,
        { value: current },
        harness === undefined
          ? rendered
          : createElement(harness, { theme: current.theme }, rendered),
      ),
    );
  }

  /** The repository library of `init`, or built-ins only when it fails to load or names another ABI. */
  const loadLibrary = async (
    library: ProgramModule | undefined,
  ): Promise<{
    readonly repository: readonly DefinedComponent[];
    readonly harness?: Harness;
  }> => {
    if (library === undefined) return { repository: [] };

    try {
      const sheet =
        library.styles === undefined ? undefined : linkSheet(library.styles);
      const [loaded] = await Promise.all([
        import(/* @vite-ignore */ library.module) as Promise<LoadedModule>,
        sheet,
      ]);

      if (loaded.papercraftAbi !== SHIM_ABI) {
        shell.reportError(
          new Error(
            'the library was built against other OpenUI packages than this frame; it was left out',
          ),
          'papercraft: the repository library was left out',
        );

        return { repository: [] };
      }

      return {
        repository: Array.isArray(loaded.components)
          ? (loaded.components as DefinedComponent[])
          : [],
        ...(typeof loaded.Harness === 'function'
          ? { harness: loaded.Harness as Harness }
          : {}),
      };
    } catch (error) {
      shell.reportError(
        error,
        'papercraft: the repository library did not load',
      );

      return { repository: [] };
    }
  };

  const init = async (library: ProgramModule | undefined): Promise<void> => {
    setState({ ...state, theme: shell.theme() });

    let { repository, harness } = await loadLibrary(library);

    if (disposed) return;

    let built: ProgramLibrary;
    try {
      built = programLibrary(repository);
    } catch (error) {
      shell.reportError(
        error,
        'papercraft: the repository library was left out',
      );
      repository = [];
      harness = undefined;
      built = programLibrary(repository);
    }

    const element = document.createElement('div');
    element.id = 'root';
    document.body.append(element);
    rootElement = element;
    reactRoot = createRoot(element, {
      onCaughtError: (error) =>
        shell.reportError(error, 'papercraft: a render error'),
      onUncaughtError: (error) =>
        shell.reportError(error, 'papercraft: an uncaught render error'),
    });
    reactRoot.render(
      createElement(ProgramView, {
        library: built,
        ...(harness === undefined ? {} : { harness }),
      }),
    );
    shell.send({ kind: 'mounted', mode: 'module', layout: 'padded' });
    shell.schedule(true);
  };

  function onAppMessage(data: unknown): void {
    if (disposed || !isRecord(data)) return;

    switch (data.kind) {
      case 'init': {
        if (initialized) return;
        if (data.library !== undefined && moduleOf(data.library) === undefined)
          return;
        initialized = true;
        void init(moduleOf(data.library));

        return;
      }
      case 'program': {
        const program = programOf(data);

        if (program !== undefined) setState({ ...state, program });

        return;
      }
      case 'theme':
        setState({ ...state, theme: shell.theme() });

        return;
      default:
        return;
    }
  }
};

// The MCP pane as the Project view's sidebar mounts it: the group the client
// part registers in the layout's stack (`layout.stack/v1`), the rows of the
// current Project's servers over `mcp/v1.watch`, and the dialogs the reader
// adds, edits, removes and signs in to a server through.
//
// The part is driven only through `activate`: the pane it registers names the
// elements `ui/v1` defines, and this file mounts those elements the way the
// layout does (the header element and the rows element of the open pane), with
// every host contract answered by a double keyed by contract ID. What is
// asserted is what the reader sees — roles, accessible names, text — and the
// contract calls the window makes, with the scope it makes them in.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  type CallScope,
  type ClientContext,
  ContractError,
  type CredentialDescription,
  type Services,
} from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui';
import { Window } from 'happy-dom';

import type {
  McpServerInput,
  McpServerView,
} from '../../src/contracts/index.js';

const window = new Window({ url: 'http://localhost/' });
const globals = globalThis as unknown as Record<string, unknown>;
const installed = [
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'HTMLIFrameElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
  'SVGElement',
  'ShadowRoot',
  'DocumentFragment',
  'Text',
  'Node',
  'Element',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'InputEvent',
  'UIEvent',
  'customElements',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'matchMedia',
] as const;

let act: (callback: () => void | Promise<void>) => Promise<void>;
let createRoot: typeof import('react-dom/client')['createRoot'];
let createElement: typeof import('react')['createElement'];
let Toaster: typeof import('desktop/ui/sonner')['Toaster'];
let activate: typeof import('../../src/client/index.js')['activate'];
let mcpPane: typeof import('../../src/client/index.js')['mcpPane'];
let McpV1: typeof import('../../src/contracts/index.js')['McpV1'];

before(async () => {
  for (const name of installed) {
    const value = window[name as keyof Window] as unknown;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      // Window functions (`getComputedStyle`, `requestAnimationFrame`) need
      // their window as `this`; constructors are installed as they are.
      value:
        typeof value === 'function' && /^[a-z]/.test(name)
          ? (value as (...args: unknown[]) => unknown).bind(window)
          : value,
      writable: true,
    });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  ({ act, createElement } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  ({ Toaster } = await import('desktop/ui/sonner'));

  ({ activate, mcpPane } = await import('../../src/client/index.js'));
  ({ McpV1 } = await import('../../src/contracts/index.js'));
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

// ---------------------------------------------------------------------------
// Fixtures

const linear: McpServerView = {
  id: 's1',
  projectId: 'p1',
  name: 'Linear',
  enabled: true,
  transport: {
    kind: 'http',
    url: 'https://mcp.linear.app/mcp',
    headers: [{ name: 'Authorization', credentialId: 'c1' }],
  },
  status: { state: 'connected' },
  signedIn: true,
  tools: [
    { name: 'list_issues', description: 'List the issues of a team.' },
    { name: 'create_issue', description: 'Create an issue in a team.' },
    { name: 'get_issue' },
  ],
  skills: [
    {
      uri: 'skill://triage/SKILL.md',
      name: 'triage',
      description: 'Sort new issues by team.',
    },
    {
      uri: 'skill://release-notes/SKILL.md',
      name: 'release-notes',
      description: 'Draft release notes from closed issues.',
    },
  ],
};

const files: McpServerView = {
  id: 's2',
  projectId: 'p1',
  name: 'Files',
  enabled: true,
  transport: {
    kind: 'stdio',
    command: 'npx',
    args: ['-y', '@mcp/files'],
    cwd: '/workspace',
    env: [{ name: 'LOG_LEVEL', value: 'debug' }],
  },
  status: { state: 'idle' },
  signedIn: false,
  tools: [],
  skills: [],
};

const sentry: McpServerView = {
  id: 's3',
  projectId: 'p2',
  name: 'Sentry',
  enabled: false,
  transport: { kind: 'http', url: 'https://mcp.sentry.dev/mcp', headers: [] },
  status: { state: 'disabled' },
  signedIn: false,
  tools: [{ name: 'find_errors' }, { name: 'get_event' }],
  skills: [],
};

/** An http server that asks for a sign-in before it connects. */
const notion: McpServerView = {
  id: 's4',
  projectId: 'p1',
  name: 'Notion',
  enabled: true,
  transport: { kind: 'http', url: 'https://mcp.notion.com/mcp', headers: [] },
  status: { state: 'needs-sign-in' },
  signedIn: false,
  tools: [],
  skills: [],
};

const credentials: readonly CredentialDescription[] = [
  { id: 'c1', kind: 'API_TOKEN', name: 'Linear token', hasSecret: true },
  { id: 'c2', kind: 'API_TOKEN', name: 'GitHub token', hasSecret: true },
];

const authorizeUrl = 'https://mcp.notion.com/authorize?state=abc';

// ---------------------------------------------------------------------------
// The host: one double per contract the part reaches, keyed by contract ID.

interface Recorded {
  readonly method: string;
  readonly scope: CallScope | undefined;
  readonly input?: unknown;
}

interface WatchRecord {
  readonly scope: CallScope | undefined;
  readonly listener: unknown;
  disposed: boolean;
}

type Answer = (input: unknown) => Promise<unknown>;

interface HostOptions {
  readonly project?: { readonly id: string; readonly name: string };
  readonly mcp?: Partial<
    Record<'create' | 'update' | 'remove' | 'signIn' | 'finishSignIn', Answer>
  >;
}

const createHost = (options: HostOptions = {}) => {
  let project = options.project;
  const selectionListeners = new Set<() => void>();
  const panes: unknown[] = [];
  const defined = new Map<string, new () => ReactElementInstance>();
  const calls: Recorded[] = [];
  const watches: WatchRecord[] = [];
  const secretsCreated: unknown[] = [];
  /** The sign-in's steps across contracts, in the order the window took them. */
  const steps: string[] = [];

  const workspace = {
    selectedThread: () =>
      project === undefined ? undefined : { id: 't1', projectId: project.id },
    // A fresh record on every read, as the layout builds them.
    selection: () =>
      project === undefined
        ? {}
        : {
            project: { ...project },
            thread: { id: 't1', projectId: project.id },
          },
    subscribe: (listener: () => void) => {
      selectionListeners.add(listener);
      return { dispose: () => selectionListeners.delete(listener) };
    },
  };

  const stack = {
    register: (pane: unknown) => {
      panes.push(pane);
      return {
        dispose: () => {
          const index = panes.indexOf(pane);
          if (index >= 0) panes.splice(index, 1);
        },
      };
    },
  };

  const ui = {
    define: (tag: string, element: new () => ReactElementInstance) => {
      defined.set(tag, element);
      return { dispose: () => defined.delete(tag) };
    },
    create: () => ({}),
    dispose: () => undefined,
  };

  const viewOf = (input: unknown, scope: CallScope | undefined) => ({
    ...(input as McpServerInput),
    id: 's-new',
    projectId: scope?.projectId ?? 'p1',
    status: { state: 'idle' },
    signedIn: false,
    tools: [],
    skills: [],
  });

  const mcpFor = (scope: CallScope | undefined) => {
    const record =
      (method: keyof NonNullable<HostOptions['mcp']>) =>
      async (input: unknown): Promise<unknown> => {
        calls.push({ method, scope, input });
        if (method === 'signIn' || method === 'finishSignIn') {
          steps.push(`${method} ${(input as { id: string }).id}`);
        }
        const answer = options.mcp?.[method];
        if (answer !== undefined) return answer(input);
        switch (method) {
          case 'create':
          case 'update':
            return viewOf(input, scope);
          case 'remove':
            return undefined;
          case 'signIn':
            return { url: authorizeUrl };
          case 'finishSignIn':
            return {
              ...notion,
              status: { state: 'connected' },
              signedIn: true,
            };
        }
      };

    return {
      list: async () => {
        calls.push({ method: 'list', scope });
        return [];
      },
      create: record('create'),
      update: record('update'),
      remove: record('remove'),
      signIn: record('signIn'),
      finishSignIn: record('finishSignIn'),
      watch: (listener: unknown) => {
        const watch: WatchRecord = { scope, listener, disposed: false };
        watches.push(watch);
        return {
          dispose: () => {
            watch.disposed = true;
          },
        };
      },
    };
  };

  const secrets = {
    list: async () => credentials,
    create: async (input: { readonly name: string; readonly kind: string }) => {
      secretsCreated.push(input);
      return {
        id: 'c-new',
        kind: input.kind,
        name: input.name,
        hasSecret: true,
      };
    },
  };

  const browser = {
    open: async (url: string) => {
      steps.push(`open ${url}`);
    },
  };

  const connection = {
    status: () => 'connected' as const,
    subscribe: () => ({ dispose: () => undefined }),
  };

  const apiOf = (id: string, scope: CallScope | undefined): unknown => {
    switch (id) {
      case 'layout.workspace/v1':
        return workspace;
      case 'layout.stack/v1':
        return stack;
      case 'ui/v1':
        return ui;
      case 'mcp/v1':
        return mcpFor(scope);
      case 'secrets/v1':
        return secrets;
      case 'doric.browser/v1':
        return browser;
      case 'doric.connection/v1':
        return connection;
      default:
        return undefined;
    }
  };

  const idOf = (contract: unknown): string =>
    (contract as { readonly id?: string }).id ?? '';

  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown, scope?: CallScope) => {
      const api = apiOf(idOf(contract), scope);
      if (api === undefined) {
        throw new ContractError(
          'unavailable',
          `No provider for ${idOf(contract)}.`,
        );
      }
      return api;
    },
    whenAvailable: (
      contract: unknown,
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      const api = apiOf(idOf(contract), undefined);
      if (api === undefined) return { dispose: () => undefined };
      const cleanup = callback(api, { bundleId: 'probe', version: '1.0.0' });
      return {
        dispose: () => {
          if (typeof cleanup === 'function') (cleanup as () => void)();
        },
      };
    },
  } as unknown as Services;

  /** Selects another Project and tells the subscribers, as the layout does. */
  const select = async (next: HostOptions['project']): Promise<void> => {
    project = next;
    await act(() => {
      for (const listener of [...selectionListeners]) listener();
    });
  };

  return {
    calls,
    defined,
    panes,
    secretsCreated,
    select,
    services,
    steps,
    watches,
  };
};

type Host = ReturnType<typeof createHost>;

// ---------------------------------------------------------------------------
// The pane as the layout mounts it

const settle = async (rounds = 5): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await act(() => new Promise<void>((done) => setTimeout(done, 0)));
  }
};

/** Settles until `ready` holds, failing with `message` after `ms`. */
const waitFor = async (
  ready: () => boolean,
  message: string,
  ms = 2000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(message);
    await act(() => new Promise<void>((done) => setTimeout(done, 10)));
  }
};

let probe = 0;

/** Mounts one element `ui/v1` was given, under a fresh name of its own. */
const mountElement = (
  host: Host,
  tag: string | undefined,
  parent: HTMLElement,
): ReactElementInstance => {
  assert.ok(tag !== undefined, 'The pane names no element.');
  const Defined = host.defined.get(tag);
  assert.ok(Defined !== undefined, `ui/v1 was never given <${tag}>.`);
  const name = `mcp-probe-${probe++}`;
  // A subclass per mount: a constructor is registered under one name only.
  window.customElements.define(name, class extends Defined {} as never);
  const element = window.document.createElement(
    name,
  ) as unknown as ReactElementInstance;
  element.services = host.services;
  parent.appendChild(element);
  return element;
};

interface OpenPane {
  readonly header: HTMLElement;
  readonly rows: HTMLElement;
  close(): Promise<void>;
}

/**
 * Activates the part and mounts what the layout draws for its open pane: the
 * header element and the rows element, plus the window's one `Toaster` the
 * layout's frame carries.
 */
const openPane = async (host: Host): Promise<OpenPane> => {
  const cleanup = await activate({ services: host.services } as ClientContext);
  const pane = host.panes[0] as {
    readonly tag?: string;
    readonly headerTag?: string;
  };
  assert.ok(pane !== undefined, 'No pane was registered.');

  const body = window.document.body as unknown as HTMLElement;
  const toasts = window.document.createElement('div') as unknown as HTMLElement;
  const headerSlot = window.document.createElement(
    'header',
  ) as unknown as HTMLElement;
  const panel = window.document.createElement(
    'section',
  ) as unknown as HTMLElement;
  body.append(toasts, headerSlot, panel);

  const toaster = createRoot(toasts);
  let header: ReactElementInstance | undefined;
  let rows: ReactElementInstance | undefined;
  await act(() => {
    toaster.render(createElement(Toaster));
    header = mountElement(host, pane.headerTag, headerSlot);
    rows = mountElement(host, pane.tag, panel);
  });
  await settle();

  return {
    header: header as unknown as HTMLElement,
    rows: rows as unknown as HTMLElement,
    close: async () => {
      await act(() => {
        header?.dispose();
        rows?.dispose();
        toaster.unmount();
      });
      if (typeof cleanup === 'function') await cleanup();
      body.replaceChildren();
    },
  };
};

// ---------------------------------------------------------------------------
// Reading the window as the reader does

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

const byId = (id: string): Element | null =>
  window.document.getElementById(id) as unknown as Element | null;

/** The accessible name: `aria-labelledby`, `aria-label`, labels, then content. */
const nameOf = (element: Element): string => {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    return normalized(
      labelledBy
        .split(/\s+/)
        .map((id) => byId(id)?.textContent ?? '')
        .join(' '),
    );
  }
  const label = element.getAttribute('aria-label');
  if (label !== null) return normalized(label);
  return normalized(element.textContent);
};

/** Every name a form control is labelled with. */
const labelsOf = (control: Element): string[] => {
  const names: string[] = [];
  const labelledBy = control.getAttribute('aria-labelledby');
  if (labelledBy !== null) names.push(nameOf(control));
  const label = control.getAttribute('aria-label');
  if (label !== null) names.push(normalized(label));
  const id = control.getAttribute('id');
  if (id !== null && id !== '') {
    for (const element of window.document.querySelectorAll('label')) {
      if ((element as unknown as HTMLLabelElement).htmlFor === id) {
        names.push(normalized(element.textContent));
      }
    }
  }
  const wrapping = control.closest('label');
  if (wrapping !== null) names.push(normalized(wrapping.textContent));
  return names;
};

const controls =
  'input, textarea, select, button, [role="combobox"], [role="checkbox"], [role="textbox"]';

/** The form controls under `root` labelled `label`, in document order. */
const controlsLabelled = (root: Element, label: string): HTMLElement[] =>
  [...root.querySelectorAll(controls)].filter((control) =>
    labelsOf(control as unknown as Element).includes(label),
  ) as unknown as HTMLElement[];

/** The first form control under `root` labelled `label`. */
const controlLabelled = (root: Element, label: string): HTMLElement => {
  const [control] = controlsLabelled(root, label);
  assert.ok(control !== undefined, `No control labelled "${label}".`);
  return control;
};

const buttonsOf = (root: Element): Element[] =>
  [...root.querySelectorAll('button, [role="button"]')] as unknown as Element[];

const findButton = (root: Element, name: string): HTMLElement | undefined =>
  buttonsOf(root).find((button) => nameOf(button) === name) as
    | HTMLElement
    | undefined;

const buttonNamed = (root: Element, name: string): HTMLElement => {
  const button = findButton(root, name);
  assert.ok(
    button !== undefined,
    `No button named "${name}"; there are: ${buttonsOf(root)
      .map(nameOf)
      .join(' | ')}.`,
  );
  return button;
};

const dialogs = (): Element[] =>
  [
    ...window.document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"]',
    ),
  ] as unknown as Element[];

/** The open dialog named `name`, once it is drawn. */
const dialogNamed = async (
  name: string,
  role: 'dialog' | 'alertdialog' = 'dialog',
): Promise<HTMLElement> => {
  const find = () =>
    dialogs().find(
      (dialog) =>
        dialog.getAttribute('role') === role && nameOf(dialog) === name,
    );
  await waitFor(
    () => find() !== undefined,
    `No ${role} named "${name}"; open: ${dialogs().map(nameOf).join(' | ')}.`,
  );
  return find() as unknown as HTMLElement;
};

/**
 * The `fieldset` (by its legend) or `group` (by its name) named `name`
 * under `root`, if there is one.
 */
const findGroup = (root: Element, name: string): HTMLElement | undefined => {
  const groups = [
    ...root.querySelectorAll('fieldset, [role="group"]'),
  ] as unknown as Element[];
  const group = groups.find((candidate) => {
    if (candidate.tagName === 'FIELDSET') {
      const legend = candidate.querySelector('legend');
      if (legend !== null && normalized(legend.textContent) === name) {
        return true;
      }
    }
    return (
      (candidate.hasAttribute('aria-label') ||
        candidate.hasAttribute('aria-labelledby')) &&
      nameOf(candidate) === name
    );
  });
  return group as unknown as HTMLElement | undefined;
};

/** A `fieldset` (by its legend) or a `group` (by its name) named `name`. */
const groupNamed = (root: Element, name: string): HTMLElement => {
  const group = findGroup(root, name);
  assert.ok(group !== undefined, `No group named "${name}".`);
  return group;
};

/** Whether `first` comes before `second` in document order. */
const precedes = (first: Element, second: Element): boolean =>
  // Node.DOCUMENT_POSITION_FOLLOWING
  (first.compareDocumentPosition(second as unknown as Node) & 4) !== 0;

/** Whether the `class` of `element` holds `name`. */
const hasClass = (element: Element | null, name: string): boolean =>
  (element?.getAttribute('class') ?? '').split(/\s+/).includes(name);

/** The pane's rows: the top-level list items of the rows element. */
const rowsOf = (pane: OpenPane): HTMLElement[] =>
  (
    [
      ...pane.rows.querySelectorAll('li, [role="listitem"]'),
    ] as unknown as HTMLElement[]
  ).filter((item) => {
    const outer = item.parentElement?.closest('li, [role="listitem"]');
    return outer == null || !pane.rows.contains(outer);
  });

const rowNamed = (pane: OpenPane, name: string): HTMLElement => {
  const row = rowsOf(pane).find((item) =>
    normalized(item.textContent).includes(name),
  );
  assert.ok(row !== undefined, `No row for "${name}".`);
  return row;
};

/** The one-line button a row is drawn as: the Screens pane's menu button. */
const rowButton = (pane: OpenPane, name: string): HTMLElement => {
  const button = rowNamed(pane, name).querySelector(
    '[data-slot="sidebar-menu-button"]',
  ) as unknown as HTMLElement | null;
  assert.ok(button !== null, `The row for "${name}" has no menu button.`);
  return button;
};

const isDisabled = (control: HTMLElement): boolean =>
  (control as unknown as HTMLButtonElement).disabled ||
  control.getAttribute('aria-disabled') === 'true';

/** The column headers of the table under `root`, as their text reads. */
const columnsOf = (root: Element): string[] =>
  [...root.querySelectorAll('th')].map((cell) => normalized(cell.textContent));

/** The text of the body of the table under `root`. */
const tableBodyOf = (root: Element): string => {
  const body = root.querySelector('tbody');
  assert.ok(body !== null, 'The table has no body.');
  return normalized(body.textContent);
};

const toastsOf = (): string[] =>
  [...window.document.querySelectorAll('[data-sonner-toast]')].map((toast) =>
    normalized(toast.textContent),
  );

// ---------------------------------------------------------------------------
// Acting as the reader does

const click = async (element: HTMLElement): Promise<void> => {
  await act(() => element.click());
  await settle();
};

/** Types `value` into a text field, replacing what it held. */
const type = async (control: HTMLElement, value: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(control),
    'value',
  )?.set;
  assert.ok(setter !== undefined, 'The control takes no typed text.');
  await act(() => {
    setter.call(control, value);
    control.dispatchEvent(
      new window.Event('input', { bubbles: true }) as never,
    );
  });
  await settle();
};

const fieldValue = (control: HTMLElement): string =>
  (control as unknown as HTMLInputElement).value;

const press = (element: HTMLElement): void => {
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
  };
  element.dispatchEvent(new window.PointerEvent('pointerdown', init) as never);
  element.dispatchEvent(new window.MouseEvent('mousedown', init) as never);
  element.dispatchEvent(new window.PointerEvent('pointerup', init) as never);
  element.dispatchEvent(new window.MouseEvent('mouseup', init) as never);
  element.click();
};

/** Presses the transport `name` in the dialog's Transport toggle group. */
const pickTransport = async (
  dialog: HTMLElement,
  name: 'HTTP' | 'stdio',
): Promise<void> => {
  const toggle = buttonNamed(groupNamed(dialog, 'Transport'), name);
  await act(() => press(toggle));
  await settle();
  assert.equal(
    toggle.getAttribute('aria-pressed'),
    'true',
    `The ${name} transport is not pressed.`,
  );
};

/**
 * The credential name the read-only Credential field under `root` shows, or
 * '' while there is none (so it can be waited for).
 */
const credentialShown = (root: Element): string => {
  const [control] = controlsLabelled(root, 'Credential');
  return control === undefined ? '' : fieldValue(control);
};

/**
 * Presses a menu's `trigger`, picks its item named `name` (a menu item or a
 * radio item) and answers the names of every item it offered.
 */
const pickMenuItem = async (
  trigger: HTMLElement,
  name: string,
): Promise<string[]> => {
  await act(() => press(trigger));
  const items = () =>
    [
      ...window.document.querySelectorAll(
        '[role="menuitem"], [role="menuitemradio"]',
      ),
    ] as unknown as HTMLElement[];
  await waitFor(() => items().length > 0, 'The menu opened no items.');
  const offered = items().map((item) => normalized(item.textContent));
  const match = items().find((item) => normalized(item.textContent) === name);
  assert.ok(
    match !== undefined,
    `No menu item "${name}" in ${offered.join(' | ')}.`,
  );
  await act(() => press(match));
  await settle(10);
  return offered;
};

/** Whether the key icon of the credential button under `root` is tinted. */
const keyTinted = (root: Element): boolean =>
  hasClass(
    controlLabelled(root, 'Choose a credential').querySelector('svg'),
    'text-primary',
  );

/** The cells' text of each row in the body of the table under `root`. */
const tableRowsOf = (root: Element): string[][] =>
  [...root.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => normalized(cell.textContent)),
  );

/** The `placeholder` of the control under `root` labelled `label`. */
const placeholderOf = (root: Element, label: string): string | null =>
  controlLabelled(root, label).getAttribute('placeholder');

const commandQuoteMessage =
  'Close the open quote, or end the line with a character after "\\".';

const isChecked = (control: HTMLElement): boolean =>
  control.tagName === 'INPUT'
    ? (control as unknown as HTMLInputElement).checked
    : control.getAttribute('aria-checked') === 'true';

const setChecked = async (
  control: HTMLElement,
  checked: boolean,
): Promise<void> => {
  if (isChecked(control) !== checked) await click(control);
  assert.equal(isChecked(control), checked);
};

/** Whether `control` sits in its dialog's footer. */
const inFooter = (control: Element): boolean =>
  control.closest('[data-slot="dialog-footer"]') !== null;

/** The `aria-checked` of the switch in `dialog`'s footer, or null without one. */
const footerSwitchState = (dialog: Element): string | null =>
  dialog
    .querySelector('[data-slot="dialog-footer"] [role="switch"]')
    ?.getAttribute('aria-checked') ?? null;

/** Hands `servers` to a watch's listener, a function or an observer. */
const emit = async (
  watch: WatchRecord,
  servers: readonly McpServerView[],
): Promise<void> => {
  await act(() => {
    const listener = watch.listener as
      | ((servers: readonly McpServerView[]) => void)
      | { next?: (servers: readonly McpServerView[]) => void };
    if (typeof listener === 'function') listener(servers);
    else listener.next?.(servers);
  });
  await settle();
};

/** The live watch of `projectId`, once the pane has opened it. */
const watchOf = async (host: Host, projectId: string): Promise<WatchRecord> => {
  const find = () =>
    host.watches.find(
      (watch) => watch.scope?.projectId === projectId && !watch.disposed,
    );
  await waitFor(
    () => find() !== undefined,
    `mcp/v1.watch was never opened for ${projectId}.`,
  );
  return find() as WatchRecord;
};

/** Opens the pane on p1 with `servers` delivered by its watch. */
const paneWith = async (
  servers: readonly McpServerView[],
  options: HostOptions = {},
): Promise<{ host: Host; pane: OpenPane }> => {
  const host = createHost({
    project: { id: 'p1', name: 'Doric' },
    ...options,
  });
  const pane = await openPane(host);
  await emit(await watchOf(host, 'p1'), servers);
  return { host, pane };
};

const callsOf = (host: Host, method: string): Recorded[] =>
  host.calls.filter((call) => call.method === method);

// ---------------------------------------------------------------------------
// W1

test('W1 activating with a stack registers the MCP pane once', async () => {
  assert.equal(McpV1.id, 'mcp/v1');
  const host = createHost({ project: { id: 'p1', name: 'Doric' } });
  const cleanup = await activate({ services: host.services } as ClientContext);

  try {
    assert.deepEqual(host.panes, [
      {
        id: 'mcp-sidebar',
        order: 20,
        title: 'MCP',
        tag: 'mcp-sidebar',
        headerTag: 'mcp-group-action',
        collapsible: true,
        initiallyOpen: false,
        minSize: '20%',
        maxSize: '80%',
      },
    ]);
    assert.deepEqual(host.panes[0], mcpPane);
    // The pane's elements are the ones the part defines.
    assert.ok(host.defined.has('mcp-sidebar'), 'mcp-sidebar is not defined.');
    assert.ok(
      host.defined.has('mcp-group-action'),
      'mcp-group-action is not defined.',
    );
  } finally {
    if (typeof cleanup === 'function') await cleanup();
  }

  // Deactivating takes the pane out of the stack.
  assert.deepEqual(host.panes, []);
});

// ---------------------------------------------------------------------------
// W2

test("W2 the rows are the selected Project's servers with their status and tool count", async () => {
  const { host, pane } = await paneWith([linear, files]);

  try {
    assert.equal(rowsOf(pane).length, 2);
    // Connected: the tool count, with the status in the row's title.
    const linearRow = normalized(rowNamed(pane, 'Linear').textContent);
    assert.match(linearRow, /3 tools/);
    assert.equal(rowButton(pane, 'Linear').title, 'Linear — Connected');
    // Otherwise: the status, and no tool count.
    const filesRow = normalized(rowNamed(pane, 'Files').textContent);
    assert.match(filesRow, /Idle/);
    assert.doesNotMatch(filesRow, /tools/);

    // Another Project selected: its servers, through a watch in its scope.
    const p1 = await watchOf(host, 'p1');
    await host.select({ id: 'p2', name: 'Elsewhere' });
    const p2 = await watchOf(host, 'p2');
    assert.equal(p1.disposed, true, "p1's watch outlived the selection.");
    await emit(p2, [sentry]);

    assert.equal(rowsOf(pane).length, 1);
    const sentryRow = normalized(rowNamed(pane, 'Sentry').textContent);
    assert.match(sentryRow, /Disabled/);
    assert.doesNotMatch(sentryRow, /tools/);
    assert.doesNotMatch(normalized(pane.rows.textContent), /Linear|Files/);
  } finally {
    await pane.close();
  }
});

test('W2 every status reads as its label', async () => {
  const labels: readonly [McpServerView['status']['state'], string][] = [
    ['disabled', 'Disabled'],
    ['idle', 'Idle'],
    ['connecting', 'Connecting…'],
    ['connected', 'Connected'],
    ['needs-sign-in', 'Sign in required'],
    ['waiting-for-sandbox', 'Waiting for sandbox'],
    ['error', 'Error'],
  ];
  const servers = labels.map(
    ([state], index): McpServerView => ({
      ...files,
      // Only an http server offers a sign-in.
      ...(state === 'needs-sign-in' ? { transport: notion.transport } : {}),
      id: `s-${state}`,
      name: `Server ${index}`,
      status: state === 'error' ? { state, message: 'exited' } : { state },
    }),
  );
  const { pane } = await paneWith(servers);

  try {
    labels.forEach(([state, label], index) => {
      const name = `Server ${index}`;
      const message = state === 'error' ? ' — exited' : '';
      assert.equal(rowButton(pane, name).title, `${name} — ${label}${message}`);
      const rowElement = rowNamed(pane, name);
      assert.equal(
        rowElement.querySelector('.lucide-log-in') === null,
        true,
        `${name} shows a sign-in icon.`,
      );
      // A row that offers Sign in keeps its name clear of the wider action.
      const buttonClasses = (
        rowButton(pane, name).getAttribute('class') ?? ''
      ).split(/\s+/);
      if (state === 'needs-sign-in') {
        assert.deepEqual(
          [
            buttonClasses.includes(
              'group-has-data-[sidebar=menu-action]/menu-item:pr-22',
            ),
            buttonClasses.includes(
              'group-has-data-[sidebar=menu-action]/menu-item:pr-8',
            ),
          ],
          [true, false],
          `${name} does not clear its Sign in action.`,
        );
      } else {
        assert.equal(
          buttonClasses.some((className) => className.endsWith('pr-22')),
          false,
          `${name} clears a Sign in action it does not have.`,
        );
      }
      if (state === 'needs-sign-in') {
        // The status text itself is the action: a "Sign in" text button.
        const signIn = buttonNamed(rowElement, `Sign in to ${name}`);
        assert.equal(normalized(signIn.textContent), 'Sign in');
        return;
      }
      const row = normalized(rowElement.textContent);
      const shown = state === 'connected' ? '0 tools' : label;
      assert.ok(row.includes(shown), `"${row}" does not read "${shown}".`);
    });
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W3

test('W3 without a selected Project the pane lists nothing, cannot add and watches nothing', async () => {
  const host = createHost();
  const pane = await openPane(host);

  try {
    await settle(10);
    assert.equal(normalized(pane.rows.textContent), '');
    assert.equal(rowsOf(pane).length, 0);
    assert.equal(
      isDisabled(buttonNamed(pane.header, 'Add MCP server')),
      true,
      'Add MCP server is enabled without a Project.',
    );
    assert.equal(host.watches.length, 0);
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W4

test('W4 adding an http server with a credential header creates it in the Project', async () => {
  const { host, pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');

    await type(controlLabelled(dialog, 'Name'), 'Linear');
    await pickTransport(dialog, 'HTTP');
    // Each half of the Transport segmented control carries an icon.
    for (const transport of ['HTTP', 'stdio']) {
      const toggle = buttonNamed(groupNamed(dialog, 'Transport'), transport);
      assert.equal(
        toggle.querySelector('svg') !== null,
        true,
        `The ${transport} toggle has no icon.`,
      );
    }
    await type(controlLabelled(dialog, 'URL'), 'https://mcp.linear.app/mcp');
    // The headers are a table; with none yet it says so.
    assert.deepEqual(columnsOf(groupNamed(dialog, 'Headers')), [
      'Key',
      'Value',
      'Remove',
    ]);
    assert.equal(tableBodyOf(groupNamed(dialog, 'Headers')), 'No headers');
    await click(buttonNamed(dialog, 'Add header'));
    const headers = groupNamed(dialog, 'Headers');
    await type(controlLabelled(headers, 'Key'), 'Authorization');
    await pickMenuItem(
      controlLabelled(headers, 'Choose a credential'),
      'Linear token',
    );
    // The credential is shown by name, in place of the plain value.
    assert.equal(
      credentialShown(groupNamed(dialog, 'Headers')),
      'Linear token',
    );
    assert.equal(
      controlsLabelled(groupNamed(dialog, 'Headers'), 'Value').length,
      0,
      'A header with a credential still offers a plain value.',
    );
    await setChecked(controlLabelled(dialog, 'Enabled'), true);
    // Enabled is a switch in the footer, beside Cancel and Save.
    assert.equal(
      inFooter(controlLabelled(dialog, 'Enabled')),
      true,
      'Enabled is not in the dialog footer.',
    );
    assert.equal(footerSwitchState(dialog), 'true');
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'create').length > 0,
      'Save never called create.',
    );

    assert.deepEqual(callsOf(host, 'create'), [
      {
        method: 'create',
        scope: { projectId: 'p1' },
        input: {
          name: 'Linear',
          enabled: true,
          transport: {
            kind: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: [{ name: 'Authorization', credentialId: 'c1' }],
          },
        } satisfies McpServerInput,
      },
    ]);
  } finally {
    await pane.close();
  }
});

test('W4 adding a stdio server sends its command, arguments, directory and environment', async () => {
  const { host, pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');

    await type(controlLabelled(dialog, 'Name'), 'Files');
    await pickTransport(dialog, 'stdio');
    // One command line holds the command and its arguments.
    await type(controlLabelled(dialog, 'Command'), 'npx -y @mcp/files');
    assert.equal(
      controlsLabelled(dialog, 'Arguments').length,
      0,
      'The dialog still has an Arguments control.',
    );
    // The working directory sits under Advanced, closed at first.
    await click(buttonNamed(dialog, 'Advanced'));
    await type(controlLabelled(dialog, 'Working directory'), '/workspace');
    await click(buttonNamed(dialog, 'Add variable'));
    const environment = groupNamed(dialog, 'Environment');
    assert.deepEqual(columnsOf(environment), ['Key', 'Value', 'Remove']);
    await type(controlLabelled(environment, 'Key'), 'LOG_LEVEL');
    await type(controlLabelled(environment, 'Value'), 'debug');
    await setChecked(controlLabelled(dialog, 'Enabled'), true);
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'create').length > 0,
      'Save never called create.',
    );

    assert.deepEqual(callsOf(host, 'create'), [
      {
        method: 'create',
        scope: { projectId: 'p1' },
        input: {
          name: 'Files',
          enabled: true,
          transport: {
            kind: 'stdio',
            command: 'npx',
            args: ['-y', '@mcp/files'],
            cwd: '/workspace',
            env: [{ name: 'LOG_LEVEL', value: 'debug' }],
          },
        } satisfies McpServerInput,
      },
    ]);
  } finally {
    await pane.close();
  }
});

test('W4 a quoted command line splits into the command and its arguments', async () => {
  const { host, pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');

    await type(controlLabelled(dialog, 'Name'), 'Node');
    await pickTransport(dialog, 'stdio');
    await type(
      controlLabelled(dialog, 'Command'),
      String.raw`node "My Server/index.js" --label 'a b' it\'s`,
    );
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'create').length > 0,
      'Save never called create.',
    );

    assert.deepEqual(
      callsOf(host, 'create').map(({ input }) => {
        const { transport } = input as McpServerInput;
        return transport.kind === 'stdio'
          ? { command: transport.command, args: transport.args }
          : { kind: transport.kind };
      }),
      [
        {
          command: 'node',
          args: ['My Server/index.js', '--label', 'a b', "it's"],
        },
      ],
    );
  } finally {
    await pane.close();
  }
});

test('W4 a command line with an open quote is refused at Save', async () => {
  const { host, pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');

    await type(controlLabelled(dialog, 'Name'), 'Files');
    await pickTransport(dialog, 'stdio');
    await type(controlLabelled(dialog, 'Command'), 'npx "@mcp/files');
    await click(buttonNamed(dialog, 'Save'));
    await settle(10);

    assert.equal(callsOf(host, 'create').length, 0, 'Save created the server.');
    assert.equal(
      controlLabelled(dialog, 'Command').getAttribute('aria-invalid'),
      'true',
    );
    assert.ok(
      normalized(dialog.textContent).includes(commandQuoteMessage),
      'The dialog does not say to close the open quote.',
    );
  } finally {
    await pane.close();
  }
});

test('W4 the fields carry example placeholders', async () => {
  const { pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');
    await pickTransport(dialog, 'HTTP');

    const shown: Record<string, string | null> = {
      name: placeholderOf(dialog, 'Name'),
      url: placeholderOf(dialog, 'URL'),
    };
    await click(buttonNamed(dialog, 'Add header'));
    shown.headerKey = placeholderOf(groupNamed(dialog, 'Headers'), 'Key');
    shown.headerValue = placeholderOf(groupNamed(dialog, 'Headers'), 'Value');
    await pickTransport(dialog, 'stdio');
    shown.command = placeholderOf(dialog, 'Command');
    await click(buttonNamed(dialog, 'Advanced'));
    shown.cwd = placeholderOf(dialog, 'Working directory');
    await click(buttonNamed(dialog, 'Add variable'));
    shown.variableKey = placeholderOf(groupNamed(dialog, 'Environment'), 'Key');

    assert.deepEqual(shown, {
      name: 'GitHub',
      url: 'https://example.com/mcp',
      headerKey: 'Authorization',
      headerValue: 'Plain value',
      command: 'npx -y @modelcontextprotocol/server-everything',
      cwd: "The sandbox's default",
      variableKey: 'LOG_LEVEL',
    });
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W5

test('W5 editing a server starts from its view and updates it by id', async () => {
  const { host, pane } = await paneWith([linear, files]);

  try {
    // The row itself opens the editor; there is no Edit button.
    assert.ok(
      findButton(rowNamed(pane, 'Linear'), 'Edit Linear') === undefined,
      'The Linear row still has an Edit button.',
    );
    await click(rowButton(pane, 'Linear'));
    const dialog = await dialogNamed('Edit MCP server');

    // The dialog's width is important, so a later sheet re-emitting the
    // dialog's default max width cannot narrow it.
    const content = dialog.closest('[data-slot="dialog-content"]');
    assert.deepEqual(
      [content !== null, hasClass(content, 'sm:max-w-xl!')],
      [true, true],
      'The dialog content is not sm:max-w-xl!.',
    );

    // The editor has no tabs: its fields and the server's tools and skills
    // are one form, Tools then Skills right after the Headers.
    assert.equal(dialog.querySelectorAll('[role="tab"]').length, 0);
    assert.deepEqual(
      [
        precedes(groupNamed(dialog, 'Headers'), groupNamed(dialog, 'Tools')),
        precedes(groupNamed(dialog, 'Tools'), groupNamed(dialog, 'Skills')),
      ],
      [true, true],
    );
    assert.equal(fieldValue(controlLabelled(dialog, 'Name')), 'Linear');
    assert.equal(
      fieldValue(controlLabelled(dialog, 'URL')),
      'https://mcp.linear.app/mcp',
    );
    // The header's credential is shown by name, with no plain value beside it.
    await waitFor(
      () => credentialShown(groupNamed(dialog, 'Headers')) === 'Linear token',
      'The header never showed its credential, "Linear token".',
    );
    assert.equal(
      controlsLabelled(groupNamed(dialog, 'Headers'), 'Value').length,
      0,
      'A header with a credential still offers a plain value.',
    );
    await type(controlLabelled(dialog, 'URL'), 'https://mcp.linear.app/v2/mcp');
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'update').length > 0,
      'Save never called update.',
    );

    assert.deepEqual(callsOf(host, 'update'), [
      {
        method: 'update',
        scope: { projectId: 'p1' },
        input: {
          id: 's1',
          name: 'Linear',
          enabled: true,
          transport: {
            kind: 'http',
            url: 'https://mcp.linear.app/v2/mcp',
            headers: [{ name: 'Authorization', credentialId: 'c1' }],
          },
        },
      },
    ]);
    assert.equal(callsOf(host, 'create').length, 0);
  } finally {
    await pane.close();
  }
});

test('W5 editing a stdio server keeps every field it did not change', async () => {
  const { host, pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Files'));
    const dialog = await dialogNamed('Edit MCP server');

    // Tools and Skills follow the Environment, before the Advanced fields.
    assert.deepEqual(
      [
        precedes(
          groupNamed(dialog, 'Environment'),
          groupNamed(dialog, 'Tools'),
        ),
        precedes(groupNamed(dialog, 'Tools'), groupNamed(dialog, 'Skills')),
        precedes(groupNamed(dialog, 'Tools'), buttonNamed(dialog, 'Advanced')),
      ],
      [true, true, true],
    );

    // The command and its arguments read as one command line.
    assert.equal(
      fieldValue(controlLabelled(dialog, 'Command')),
      'npx -y @mcp/files',
    );
    assert.equal(
      controlsLabelled(dialog, 'Arguments').length,
      0,
      'The dialog still has an Arguments control.',
    );
    assert.equal(
      fieldValue(controlLabelled(groupNamed(dialog, 'Environment'), 'Value')),
      'debug',
    );
    await click(buttonNamed(dialog, 'Advanced'));
    assert.equal(
      fieldValue(controlLabelled(dialog, 'Working directory')),
      '/workspace',
    );
    await setChecked(controlLabelled(dialog, 'Enabled'), false);
    // Enabled is a switch in the footer, beside Cancel and Save.
    assert.equal(
      inFooter(controlLabelled(dialog, 'Enabled')),
      true,
      'Enabled is not in the dialog footer.',
    );
    assert.equal(footerSwitchState(dialog), 'false');
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'update').length > 0,
      'Save never called update.',
    );

    assert.deepEqual(callsOf(host, 'update'), [
      {
        method: 'update',
        scope: { projectId: 'p1' },
        input: {
          id: 's2',
          name: 'Files',
          enabled: false,
          transport: {
            kind: 'stdio',
            command: 'npx',
            args: ['-y', '@mcp/files'],
            cwd: '/workspace',
            env: [{ name: 'LOG_LEVEL', value: 'debug' }],
          },
        },
      },
    ]);
  } finally {
    await pane.close();
  }
});

test('W5 arguments with spaces and quotes read back quoted and save unchanged', async () => {
  const docs: McpServerView = {
    ...files,
    id: 's6',
    name: 'Docs',
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['--root', '/my files', "it's"],
      env: [],
    },
  };
  const { host, pane } = await paneWith([docs]);

  try {
    await click(rowButton(pane, 'Docs'));
    const dialog = await dialogNamed('Edit MCP server');

    assert.equal(
      fieldValue(controlLabelled(dialog, 'Command')),
      String.raw`npx --root '/my files' 'it'\''s'`,
    );
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'update').length > 0,
      'Save never called update.',
    );

    assert.deepEqual(
      callsOf(host, 'update').map(({ input }) => input),
      [
        {
          id: 's6',
          name: 'Docs',
          enabled: true,
          transport: {
            kind: 'stdio',
            command: 'npx',
            args: ['--root', '/my files', "it's"],
            env: [],
          },
        },
      ],
    );
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W6

test('W6 removing a server asks first and removes it by id once confirmed', async () => {
  const { host, pane } = await paneWith([linear, files]);

  try {
    await click(buttonNamed(rowNamed(pane, 'Linear'), 'Remove Linear'));
    const alert = await dialogNamed('Remove Linear?', 'alertdialog');
    assert.equal(callsOf(host, 'remove').length, 0, 'Removed before asking.');

    await click(buttonNamed(alert, 'Remove'));
    await waitFor(
      () => callsOf(host, 'remove').length > 0,
      'Confirming never called remove.',
    );

    assert.deepEqual(callsOf(host, 'remove'), [
      { method: 'remove', scope: { projectId: 'p1' }, input: { id: 's1' } },
    ]);
  } finally {
    await pane.close();
  }
});

test('W6 cancelling the removal removes nothing', async () => {
  const { host, pane } = await paneWith([linear, files]);

  try {
    await click(buttonNamed(rowNamed(pane, 'Linear'), 'Remove Linear'));
    const alert = await dialogNamed('Remove Linear?', 'alertdialog');
    await click(buttonNamed(alert, 'Cancel'));
    await settle(10);

    assert.deepEqual(callsOf(host, 'remove'), []);
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W7

test('W7 signing in opens the authorization page between signIn and finishSignIn', async () => {
  const errored: McpServerView = {
    ...files,
    id: 's5',
    name: 'Shell',
    status: { state: 'error', message: 'exited' },
  };
  const { host, pane } = await paneWith([notion, linear, errored]);

  try {
    // Only an http server that needs a sign-in offers one.
    assert.equal(findButton(pane.rows, 'Sign in to Linear'), undefined);
    assert.equal(findButton(pane.rows, 'Sign in to Shell'), undefined);

    const notionRow = rowNamed(pane, 'Notion');
    assert.equal(
      notionRow.querySelector('.lucide-log-in') === null,
      true,
      'The Notion row shows a sign-in icon.',
    );
    const signIn = buttonNamed(notionRow, 'Sign in to Notion');
    assert.equal(normalized(signIn.textContent), 'Sign in');

    await click(signIn);
    await waitFor(
      () => host.steps.length >= 3,
      `The sign-in stopped after: ${host.steps.join(', ')}.`,
    );

    assert.deepEqual(host.steps, [
      'signIn s4',
      `open ${authorizeUrl}`,
      'finishSignIn s4',
    ]);
    assert.deepEqual(
      [...callsOf(host, 'signIn'), ...callsOf(host, 'finishSignIn')].map(
        ({ scope, input }) => ({ scope, input }),
      ),
      [
        { scope: { projectId: 'p1' }, input: { id: 's4' } },
        { scope: { projectId: 'p1' }, input: { id: 's4' } },
      ],
    );
    await settle(10);
    assert.deepEqual(toastsOf(), []);
  } finally {
    await pane.close();
  }
});

test('W7 a sign-in that fails to finish says so in a toast', async () => {
  const { host, pane } = await paneWith([notion], {
    mcp: {
      finishSignIn: async () => {
        throw new ContractError('internal', 'The authorization was refused.');
      },
    },
  });

  try {
    await click(buttonNamed(rowNamed(pane, 'Notion'), 'Sign in to Notion'));
    await waitFor(
      () => toastsOf().length > 0,
      `No toast after: ${host.steps.join(', ')}.`,
    );

    assert.deepEqual(host.steps, [
      'signIn s4',
      `open ${authorizeUrl}`,
      'finishSignIn s4',
    ]);
    assert.equal(toastsOf().length, 1);
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W8

test('W8 the credential picker lists the stored credentials and creates a new token', async () => {
  const { host, pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');
    await type(controlLabelled(dialog, 'Name'), 'Linear');
    await pickTransport(dialog, 'HTTP');
    await type(controlLabelled(dialog, 'URL'), 'https://mcp.linear.app/mcp');
    await click(buttonNamed(dialog, 'Add header'));
    await type(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Key'),
      'X-Api-Key',
    );

    const offered = await pickMenuItem(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Choose a credential'),
      'New credential…',
    );
    assert.deepEqual(offered, [
      'Plain value',
      'Linear token',
      'GitHub token',
      'New credential…',
    ]);

    const create = await dialogNamed('New credential');
    assert.deepEqual(
      [placeholderOf(create, 'Name'), placeholderOf(create, 'Secret')],
      ['GitHub token', 'Paste the token'],
    );
    await type(controlLabelled(create, 'Name'), 'Linear key');
    await type(controlLabelled(create, 'Secret'), 'lin_api_123');
    await click(buttonNamed(create, 'Create'));
    await waitFor(
      () => host.secretsCreated.length > 0,
      'Create never called secrets/v1.create.',
    );
    assert.deepEqual(host.secretsCreated, [
      { kind: 'API_TOKEN', name: 'Linear key', secret: 'lin_api_123' },
    ]);
    // The header now holds the new credential, shown by its name.
    await waitFor(
      () => credentialShown(groupNamed(dialog, 'Headers')) === 'Linear key',
      'The header never showed the new credential, "Linear key".',
    );

    await setChecked(controlLabelled(dialog, 'Enabled'), true);
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'create').length > 0,
      'Save never called create.',
    );

    assert.deepEqual(
      callsOf(host, 'create').map(({ input }) => input),
      [
        {
          name: 'Linear',
          enabled: true,
          transport: {
            kind: 'http',
            url: 'https://mcp.linear.app/mcp',
            headers: [{ name: 'X-Api-Key', credentialId: 'c-new' }],
          },
        },
      ],
    );
  } finally {
    await pane.close();
  }
});

test('W8 choosing Plain value again brings back the value typed before', async () => {
  const { host, pane } = await paneWith([]);

  try {
    await click(buttonNamed(pane.header, 'Add MCP server'));
    const dialog = await dialogNamed('Add MCP server');
    await type(controlLabelled(dialog, 'Name'), 'Linear');
    await pickTransport(dialog, 'HTTP');
    await type(controlLabelled(dialog, 'URL'), 'https://mcp.linear.app/mcp');
    await click(buttonNamed(dialog, 'Add header'));
    await type(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Key'),
      'X-Api-Key',
    );
    await type(controlLabelled(groupNamed(dialog, 'Headers'), 'Value'), 'ab');

    await pickMenuItem(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Choose a credential'),
      'Linear token',
    );
    assert.equal(
      credentialShown(groupNamed(dialog, 'Headers')),
      'Linear token',
    );
    assert.equal(
      controlsLabelled(groupNamed(dialog, 'Headers'), 'Value').length,
      0,
      'A header with a credential still offers a plain value.',
    );

    await pickMenuItem(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Choose a credential'),
      'Plain value',
    );
    assert.equal(
      controlsLabelled(groupNamed(dialog, 'Headers'), 'Credential').length,
      0,
      'A plain header still shows a credential.',
    );
    // The value typed before the credential was chosen is still there.
    assert.equal(
      fieldValue(controlLabelled(groupNamed(dialog, 'Headers'), 'Value')),
      'ab',
    );
    await type(controlLabelled(groupNamed(dialog, 'Headers'), 'Value'), 'abc');
    await click(buttonNamed(dialog, 'Save'));
    await waitFor(
      () => callsOf(host, 'create').length > 0,
      'Save never called create.',
    );

    assert.deepEqual(
      callsOf(host, 'create').map(({ input }) => {
        const { transport } = input as McpServerInput;
        return transport.kind === 'http' ? transport.headers : [];
      }),
      [[{ name: 'X-Api-Key', value: 'abc' }]],
    );
  } finally {
    await pane.close();
  }
});

test('W8 the key icon is tinted while the entry holds a credential', async () => {
  const { pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Linear'));
    const dialog = await dialogNamed('Edit MCP server');
    await waitFor(
      () => credentialShown(groupNamed(dialog, 'Headers')) === 'Linear token',
      'The header never showed its credential, "Linear token".',
    );
    assert.equal(keyTinted(groupNamed(dialog, 'Headers')), true);

    await pickMenuItem(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Choose a credential'),
      'Plain value',
    );
    assert.equal(keyTinted(groupNamed(dialog, 'Headers')), false);

    await pickMenuItem(
      controlLabelled(groupNamed(dialog, 'Headers'), 'Choose a credential'),
      'GitHub token',
    );
    assert.equal(
      credentialShown(groupNamed(dialog, 'Headers')),
      'GitHub token',
    );
    assert.equal(keyTinted(groupNamed(dialog, 'Headers')), true);
  } finally {
    await pane.close();
  }
});

test('W8 the credential menu is as wide as its items, at least 12rem', async () => {
  const { pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Linear'));
    const dialog = await dialogNamed('Edit MCP server');
    const content = () =>
      window.document.querySelector(
        '[data-slot="dropdown-menu-content"]',
      ) as unknown as Element | null;

    await act(() =>
      press(
        controlLabelled(groupNamed(dialog, 'Headers'), 'Choose a credential'),
      ),
    );
    await waitFor(
      () => content() !== null,
      'The credential menu never opened.',
    );

    assert.deepEqual(
      [hasClass(content(), 'w-auto'), hasClass(content(), 'min-w-48')],
      [true, true],
    );
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W10

test("W10 the editor's Tools group lists the server's tools and filters them", async () => {
  const { pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Linear'));
    const dialog = await dialogNamed('Edit MCP server');
    const tools = () => groupNamed(dialog, 'Tools');

    assert.deepEqual(columnsOf(tools()), ['Name', 'Description']);
    assert.deepEqual(tableRowsOf(tools()), [
      ['list_issues', 'List the issues of a team.'],
      ['create_issue', 'Create an issue in a team.'],
      ['get_issue', ''],
    ]);

    const filter = controlLabelled(tools(), 'Filter tools');
    assert.equal(filter.getAttribute('placeholder'), 'Filter tools…');
    await type(filter, 'create');
    assert.deepEqual(tableRowsOf(tools()), [
      ['create_issue', 'Create an issue in a team.'],
    ]);
    // The filter ignores case and reads the descriptions too.
    await type(controlLabelled(tools(), 'Filter tools'), 'TEAM');
    assert.deepEqual(
      tableRowsOf(tools()).map(([name]) => name),
      ['list_issues', 'create_issue'],
    );
    await type(controlLabelled(tools(), 'Filter tools'), 'zzz');
    assert.equal(tableBodyOf(tools()), 'No tool matches that filter.');
  } finally {
    await pane.close();
  }
});

test("W10 the editor's Skills group lists the server's skills and filters them", async () => {
  const { pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Linear'));
    const dialog = await dialogNamed('Edit MCP server');
    const skills = () => groupNamed(dialog, 'Skills');

    assert.deepEqual(columnsOf(skills()), ['Name', 'Description']);
    assert.deepEqual(tableRowsOf(skills()), [
      ['triage', 'Sort new issues by team.'],
      ['release-notes', 'Draft release notes from closed issues.'],
    ]);

    const filter = controlLabelled(skills(), 'Filter skills');
    assert.equal(filter.getAttribute('placeholder'), 'Filter skills…');
    // The filter ignores case and reads the descriptions too.
    await type(filter, 'CLOSED');
    assert.deepEqual(
      tableRowsOf(skills()).map(([name]) => name),
      ['release-notes'],
    );
    await type(controlLabelled(skills(), 'Filter skills'), 'zzz');
    assert.equal(tableBodyOf(skills()), 'No skill matches that filter.');
  } finally {
    await pane.close();
  }
});

test('W10 a server without tools or skills says so, and adding a server shows neither', async () => {
  const { pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Files'));
    const edit = await dialogNamed('Edit MCP server');
    assert.deepEqual(
      [
        tableBodyOf(groupNamed(edit, 'Tools')),
        tableBodyOf(groupNamed(edit, 'Skills')),
      ],
      ['No tools', 'No skills'],
    );
    await click(buttonNamed(edit, 'Cancel'));
    await waitFor(
      () => dialogs().length === 0,
      'Cancel never closed the editor.',
    );

    await click(buttonNamed(pane.header, 'Add MCP server'));
    const add = await dialogNamed('Add MCP server');
    assert.deepEqual(
      [
        findGroup(add, 'Tools') === undefined,
        findGroup(add, 'Skills') === undefined,
        add.querySelectorAll('[role="tab"]').length,
      ],
      [true, true, 0],
    );
  } finally {
    await pane.close();
  }
});

test('W10 saving an invalid edit marks the field and updates nothing', async () => {
  const { host, pane } = await paneWith([linear, files]);

  try {
    await click(rowButton(pane, 'Linear'));
    const dialog = await dialogNamed('Edit MCP server');
    await type(controlLabelled(dialog, 'URL'), '');

    await click(buttonNamed(dialog, 'Save'));
    await settle();

    assert.equal(
      controlLabelled(dialog, 'URL').getAttribute('aria-invalid'),
      'true',
    );
    assert.ok(
      normalized(dialog.textContent).includes(
        'Enter an http:// or https:// URL.',
      ),
      'The dialog does not show the URL error.',
    );
    assert.equal(callsOf(host, 'update').length, 0);
  } finally {
    await pane.close();
  }
});

// ---------------------------------------------------------------------------
// W9

test('W9 a watch lost with the host generation subscribes again', async () => {
  const { host, pane } = await paneWith([linear]);

  try {
    const first = await watchOf(host, 'p1');
    const observer = first.listener as {
      readonly end?: (error?: ContractError) => void;
    };
    assert.equal(
      typeof observer.end,
      'function',
      'The watch takes no observer, so it cannot learn the stream ended.',
    );
    await act(() =>
      observer.end?.(
        new ContractError('generation_lost', 'The host restarted.'),
      ),
    );

    await waitFor(
      () => host.watches.filter((watch) => watch !== first).length > 0,
      'The pane never watched again.',
      3000,
    );
    const second = host.watches.find((watch) => watch !== first);
    assert.deepEqual(second?.scope, { projectId: 'p1' });

    await emit(second as WatchRecord, [linear, files]);
    assert.equal(rowsOf(pane).length, 2);
    assert.match(normalized(rowNamed(pane, 'Files').textContent), /Idle/);
  } finally {
    await pane.close();
  }
});

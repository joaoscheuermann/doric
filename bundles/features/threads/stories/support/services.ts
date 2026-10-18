// Fake services for the threads stories: the window's `ui/v1` (only the
// `chat-readonly-markdown` element a delegated turn creates) and
// `navigation/v1` (opening a sender's conversation), with no host behind
// them.

import type { Services } from 'bundle/contracts';

/**
 * A stand-in for chat's `<chat-readonly-markdown>`: chat owns the real
 * element and is not loaded in this bundle's previews, so the text is drawn
 * as the conversation's plain, wrapped text.
 */
const createReadonlyMarkdown = (text: string): HTMLElement => {
  const element = document.createElement('div');
  element.className = 'whitespace-pre-wrap text-sm text-foreground';
  element.textContent = text;
  Object.defineProperty(element, 'text', {
    configurable: true,
    get: () => element.textContent ?? '',
    set: (value: string) => {
      element.textContent = value;
    },
  });
  return element;
};

const ui = {
  define: () => ({ dispose: () => undefined }),
  create: (tag: string, props?: Readonly<Record<string, unknown>>) => {
    if (tag !== 'chat-readonly-markdown') {
      throw new Error(`The threads stories cannot create <${tag}>.`);
    }
    return createReadonlyMarkdown(String(props?.text ?? ''));
  },
  dispose: () => undefined,
};

const navigation = {
  navigate: (path: string) => {
    console.info(`Navigate to ${path}`);
  },
};

const apis: Readonly<Record<string, unknown>> = {
  'ui/v1': ui,
  'navigation/v1': navigation,
};

const apiOf = (contract: { readonly id: string }): unknown => {
  const api = apis[contract.id];
  if (api === undefined) {
    throw new Error(`The threads stories do not provide ${contract.id}.`);
  }
  return api;
};

export const storyServices: Services = {
  provide: () => {
    throw new Error('The threads stories provide no services.');
  },
  use: ((contract: { readonly id: string }) =>
    apiOf(contract)) as Services['use'],
  whenAvailable: ((
    contract: { readonly id: string },
    callback: (api: unknown, provider: unknown) => unknown,
  ) => {
    const api = apis[contract.id];
    const cleanup =
      api === undefined
        ? undefined
        : callback(api, { bundleId: 'stories', version: '1.0.0' });
    return {
      dispose: () => {
        if (typeof cleanup === 'function') cleanup();
      },
    };
  }) as Services['whenAvailable'],
};

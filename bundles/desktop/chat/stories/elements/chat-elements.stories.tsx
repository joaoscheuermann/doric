// The chat's custom elements as `ui/v1` mounts them: each class is defined
// under a story tag, created in the page, handed the story host's services
// and its listed properties, and then renders its own React root (with the
// chat query client and a tooltip provider, as `ChatRoot` wraps it).

import { createElement, useLayoutEffect, useRef } from 'react';

import { GENERIC_BLOCK_TYPE } from '../../src/client/domain/external-blocks.js';
import {
  ChatComposerElement,
  ChatGenericBlockElement,
  ChatReadonlyMarkdownElement,
  ChatThreadPanelElement,
  ChatViewElement,
} from '../../src/client/elements/chat-elements.js';
import type { RenderBlock } from '../../src/contracts/index.js';
import { installChatHost, selectThread } from '../support/chat-host.js';
import { projectId, threadIds } from '../support/fixtures.js';

type ElementClass = typeof ChatViewElement;

const noProps: Readonly<Record<string, unknown>> = {};

/** Mounts `element` as `tag` with the host's services and `props`. */
function ElementHost({
  tag,
  element,
  props = noProps,
  className,
}: {
  readonly tag: string;
  readonly element: ElementClass;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly className?: string;
}) {
  const services = installChatHost();
  if (customElements.get(tag) === undefined)
    customElements.define(tag, element);
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    Object.assign(node, props, { services });
  }, [props, services]);
  return <div className={className}>{createElement(tag, { ref })}</div>;
}

const conversation = { projectId, threadId: threadIds.conversation };
const running = { projectId, threadId: threadIds.running };

const block: RenderBlock = {
  id: 'event-42',
  type: GENERIC_BLOCK_TYPE,
  promptId: 'a0000000-0000-4000-8000-000000000101',
  sequence: 42,
  data: {
    eventType: 'deploy.preview-ready/v1',
    createdAt: '2026-10-16T08:42:10.000Z',
    payload: { url: 'https://storefront-pr-118.preview.example.com' },
  },
  actions: [],
};

const markdown = {
  text: [
    '## Checkout fixes',
    '',
    'The Pay button now uses the **primary** token:',
    '',
    '- `src/components/Checkout.tsx` — `bg-primary text-primary-foreground`',
    '- `src/components/CartSummary.tsx` — `bg-card`',
    '',
    '```tsx',
    '<Button className="bg-primary text-primary-foreground">',
    '```',
  ].join('\n'),
};

export default {
  title: 'Chat/Elements/Chat elements',
  component: ChatViewElement,
};

export const ChatViewRoute = {
  render: () => (
    <ElementHost
      tag="story-chat-view"
      element={ChatViewElement}
      props={conversation}
      className="flex h-[720px] min-h-0 overflow-hidden rounded-lg border"
    />
  ),
};

export const ThreadPanel = {
  render: () => (
    <ElementHost
      tag="story-chat-thread-panel"
      element={ChatThreadPanelElement}
      props={running}
      className="flex h-[720px] min-h-0 overflow-hidden rounded-lg border"
    />
  ),
};

export const FooterComposer = {
  render: () => {
    selectThread(threadIds.queued);
    return (
      <footer className="flex chrome-bar items-center justify-end gap-2 border-t bg-sidebar px-2">
        <ElementHost tag="story-chat-composer" element={ChatComposerElement} />
      </footer>
    );
  },
};

export const GenericBlock = {
  render: () => (
    <ElementHost
      tag="story-chat-block"
      element={ChatGenericBlockElement}
      props={{ block }}
    />
  ),
};

export const ReadonlyMarkdown = {
  render: () => (
    <ElementHost
      tag="story-chat-readonly-markdown"
      element={ChatReadonlyMarkdownElement}
      props={markdown}
      className="font-conversation text-sm font-light"
    />
  ),
};

// The chat bundle's client part (stage 9, §7.3): the conversation's store,
// host adapters, `chat.views/v1`, `chat.lexical/v1` and `chat.hooks/v1`, the
// conversation route and the footer composer item. Persistent work runs on
// the activation services (D9-17).

import {
  type Cleanup,
  type ClientContext,
  HooksV1,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { ChatHooksV1 } from '../contracts/index.js';
import { HistorySnapshotsV1 } from './api/history-contract.js';
import { LayoutWorkspaceV1 } from './api/workspace-contract.js';
import { THREAD_ROUTE } from './domain/thread-route.js';
import {
  ChatComposerElement,
  ChatGenericBlockElement,
  ChatReadonlyMarkdownElement,
  ChatViewElement,
} from './elements/chat-elements.js';
import { setChatHooks } from './services/chat-hooks.js';
import {
  initChat,
  setHistory,
  setWorkspace,
} from './services/chat-services.js';
import {
  createChatLexical,
  setChatLexicalRegistry,
} from './services/lexical.js';
import { watchSandboxActivity } from './services/sandbox-activity.js';
import {
  createChatViews,
  GENERIC_BLOCK_TAG,
  setChatViewsRegistry,
} from './services/views.js';
import { resetConnectionStore } from './stores/connection.js';
import { threadChatsStore } from './stores/thread-chats.js';

export function activate({ services }: ClientContext): Cleanup {
  initChat(services);
  const hooks = services.use(HooksV1).define(ChatHooksV1);
  setChatHooks(hooks);

  const views = createChatViews();
  services.provide(views.service);
  setChatViewsRegistry(views.registry);
  const lexical = createChatLexical();
  services.provide(lexical.service);
  setChatLexicalRegistry(lexical.registry);

  const ui = services.use(UiV1);
  const elements = [
    ui.define('chat-view', ChatViewElement),
    ui.define('chat-composer', ChatComposerElement),
    ui.define(GENERIC_BLOCK_TAG, ChatGenericBlockElement),
    ui.define('chat-readonly-markdown', ChatReadonlyMarkdownElement),
  ];
  const route = services.use(NavigationV1).register({
    path: THREAD_ROUTE,
    parent: '/',
    create: (match) => ui.create('chat-view', match.params),
  });
  // D9-11: the composer controls sit in the content footer, with or without
  // a Thread.
  const composer = services
    .use(RegionsV1)
    .add('layout.footer', { id: 'composer', tag: 'chat-composer', order: 40 });

  const workspace = services.whenAvailable(LayoutWorkspaceV1, (api) => {
    setWorkspace(api);
    return () => setWorkspace(undefined);
  });
  const history = services.whenAvailable(HistorySnapshotsV1, (api) => {
    setHistory(api);
    return () => setHistory(undefined);
  });
  const stopActivity = watchSandboxActivity(threadChatsStore, hooks);

  return () => {
    stopActivity();
    threadChatsStore.getState().closeAll();
    history.dispose();
    workspace.dispose();
    composer.dispose();
    route.dispose();
    for (const element of elements.reverse()) element.dispose();
    resetConnectionStore();
    setChatLexicalRegistry(undefined);
    setChatViewsRegistry(undefined);
    setChatHooks(undefined);
    initChat(undefined);
  };
}

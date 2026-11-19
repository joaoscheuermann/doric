// The chat bundle's client part (stage 9, §7.3): the conversation's store,
// host adapters, `chat.views/v1`, `chat.lexical/v1`, `chat.send/v1` and
// `chat.hooks/v2`, the conversation route, the footer composer item and,
// while `settings.models/v1` is available, the footer execution picker item.
// Persistent work runs on the activation services (D9-17).

import {
  type Cleanup,
  type ClientContext,
  CommandsV1,
  HooksV1,
  MenusV1,
  ModelsV1,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import type { SHELL_CONVERSATION_FOOTER } from 'layout/contracts';

import { ChatHooksV2, SEND_PROMPT_COMMAND } from '../contracts/index.js';
import { HistorySnapshotsV1 } from './api/history-contract.js';
import { setModelsApi } from './api/model-icons.js';
import { SettingsModelsV1 } from './api/settings-models.js';
import { WorkspaceSelectionV1 } from './api/workspace-selection.js';
import { THREAD_ROUTE } from './domain/thread-route.js';
import {
  ChatComposerElement,
  ChatExecutionPickerElement,
  ChatGenericBlockElement,
  ChatReadonlyMarkdownElement,
  ChatThreadPanelElement,
  ChatThreadTabIconElement,
  ChatViewElement,
} from './elements/chat-elements.js';
import { setChatHooks } from './services/chat-hooks.js';
import { initChat, setHistory } from './services/chat-services.js';
import {
  createChatLexical,
  setChatLexicalRegistry,
} from './services/lexical.js';
import { watchSandboxActivity } from './services/sandbox-activity.js';
import { createChatSend } from './services/send.js';
import { sendPromptCommand } from './services/send-command.js';
import { watchThreadTabs } from './services/thread-tabs.js';
import { watchThreadViews } from './services/thread-views.js';
import {
  createChatViews,
  GENERIC_BLOCK_TAG,
  setChatViewsRegistry,
} from './services/views.js';
import { resetComposers } from './stores/composer.js';
import { resetComposerStack } from './stores/composer-stack.js';
import { resetConnectionStore } from './stores/connection.js';
import {
  setSettingsModels,
  setWorkspaceSelection,
} from './stores/execution-sources.js';
import { threadChatsStore } from './stores/thread-chats.js';

export function activate({ services }: ClientContext): Cleanup {
  initChat(services);
  const hooks = services.use(HooksV1).define(ChatHooksV2);
  setChatHooks(hooks);

  const views = createChatViews();
  services.provide(views.service);
  setChatViewsRegistry(views.registry);
  const lexical = createChatLexical();
  services.provide(lexical.service);
  // The stack's send for surfaces outside the composer (`chat.send/v1`).
  services.provide(createChatSend());
  setChatLexicalRegistry(lexical.registry);

  const ui = services.use(UiV1);
  const elements = [
    ui.define('chat-view', ChatViewElement),
    ui.define('chat-composer', ChatComposerElement),
    ui.define('chat-thread-panel', ChatThreadPanelElement),
    ui.define(GENERIC_BLOCK_TAG, ChatGenericBlockElement),
    ui.define('chat-readonly-markdown', ChatReadonlyMarkdownElement),
    ui.define('chat-thread-tab-icon', ChatThreadTabIconElement),
    ui.define('chat-execution-picker', ChatExecutionPickerElement),
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
    .add(
      'shell.conversation.footer' satisfies typeof SHELL_CONVERSATION_FOOTER,
      { id: 'composer', tag: 'chat-composer', order: 40 },
    );
  // The send's chord, owned by the window on the conversation's route: no
  // surface inside it answers `Cmd+Enter` on its own.
  const sendCommand = services.use(CommandsV1).register(sendPromptCommand);
  void services.use(MenusV1).addKeybinding({
    command: SEND_PROMPT_COMMAND,
    key: 'CmdOrCtrl+Enter',
    when: { path: THREAD_ROUTE },
  });

  // The footer's execution picker reads the selection while `workspace`
  // answers, and is a footer item only while `settings` answers its view
  // (bundle isolation 6(c), decisions O2 and O4).
  const selection = services.whenAvailable(WorkspaceSelectionV1, (api) => {
    setWorkspaceSelection(api);
    return () => setWorkspaceSelection(undefined);
  });
  const settingsModels = services.whenAvailable(SettingsModelsV1, (api) => {
    setSettingsModels(api);
    const item = services
      .use(RegionsV1)
      .add(
        'shell.conversation.footer' satisfies typeof SHELL_CONVERSATION_FOOTER,
        { id: 'execution', tag: 'chat-execution-picker', order: 20 },
      );
    return () => {
      item.dispose();
      setSettingsModels(undefined);
    };
  });
  const history = services.whenAvailable(HistorySnapshotsV1, (api) => {
    setHistory(api);
    return () => setHistory(undefined);
  });
  const models = services.whenAvailable(ModelsV1, (api) => {
    setModelsApi(api);
    return () => setModelsApi(undefined);
  });
  const stopActivity = watchSandboxActivity(threadChatsStore, hooks);
  // The Thread tabs the chat opens beside the conversation, and the views of
  // the Threads the window shows (bundle isolation 4(c)).
  const stopThreadTabs = watchThreadTabs(services);
  const stopThreadViews = watchThreadViews(services);

  return () => {
    stopThreadViews();
    stopThreadTabs();
    stopActivity();
    threadChatsStore.getState().closeAll();
    history.dispose();
    models.dispose();
    settingsModels.dispose();
    selection.dispose();
    composer.dispose();
    sendCommand.dispose();
    route.dispose();
    for (const element of elements.reverse()) element.dispose();
    resetConnectionStore();
    resetComposers();
    resetComposerStack();
    setChatLexicalRegistry(undefined);
    setChatViewsRegistry(undefined);
    setChatHooks(undefined);
    initChat(undefined);
  };
}

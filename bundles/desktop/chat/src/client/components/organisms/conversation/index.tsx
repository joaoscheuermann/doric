import { ClipboardDOMImportExtension } from '@lexical/clipboard';
import { CodeNode } from '@lexical/code';
import { EditorStateExtension, HMRExtension } from '@lexical/extension';
import { HistoryExtension } from '@lexical/history';
import {
  DOMImportExtension,
  DOMRenderExtension,
  defineImportRule,
  domOverride,
  sel,
} from '@lexical/html';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { TreeViewExtension } from '@lexical/react/TreeViewExtension';
import { HeadingNode, QuoteNode, RichTextExtension } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import type { Ui } from 'bundle/contracts';
import { ScrollArea } from 'desktop/ui/scroll-area';
import { toast } from 'desktop/ui/sonner';
import {
  $getRoot,
  $isTextNode,
  configExtension,
  defineExtension,
  isHTMLElement,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

import {
  isReadOnlyBlock,
  isUndeletableBlock,
} from '../../../domain/conversation-nodes.js';
import { withPendingTurns } from '../../../domain/pending-turns.js';
import { composerAction } from '../../../domain/queue.js';
import type { Thread } from '../../../domain/workspace.js';
import { useExternalBlocks } from '../../../hooks/use-external-blocks.js';
import { useThreadChat } from '../../../hooks/use-thread-chat.js';
import { useThreadQueue } from '../../../hooks/use-thread-queue.js';
import { useThreadStop } from '../../../hooks/use-thread-stop.js';
import {
  type ChatLexicalRegistry,
  chatLexicalRegistry,
} from '../../../services/lexical.js';
import type { PromptSignal } from '../../../utility/prompt-signal.js';
import { ThreadNavRail } from '../../molecules/thread-nav-rail.js';
import { ActivityTurnNode } from './nodes/activity-turn-node.js';
import { AgentTurnNode } from './nodes/agent-turn-node.js';
import {
  CHAT_BLOCK_NODE,
  ChatBlockNode,
  ChatBlocksContext,
} from './nodes/chat-block-node.js';
import { CompactionTurnNode } from './nodes/compaction-turn-node.js';
import { DelegatedTurnNode } from './nodes/delegated-turn-node.js';
import { FailureTurnNode } from './nodes/failure-turn-node.js';
import { LifecycleTurnNode } from './nodes/lifecycle-turn-node.js';
import { PromptEditNode } from './nodes/prompt-edit-node.js';
import { QueueNode } from './nodes/queue-node.js';
import { QueuedTurnNode } from './nodes/queued-turn-node.js';
import { ThinkingTurnNode } from './nodes/thinking-turn-node.js';
import { ToolTurnNode } from './nodes/tool-turn-node.js';
import { TurnAuthorNode } from './nodes/turn-author-node.js';
import {
  $createUserPromptNode,
  UserPromptNode,
} from './nodes/user-prompt-node.js';
import { UserTurnNode } from './nodes/user-turn-node.js';
import { CaretNavigation } from './plugins/caret-navigation.js';
import { EditQueuePrompt } from './plugins/edit-queue-prompt.js';
import { InsertThreadTurnNodes } from './plugins/insert-thread-turn-nodes.js';
import { MarkdownPromptPlugin } from './plugins/markdown-prompt.js';
import { PromptLineBreaks } from './plugins/prompt-line-breaks.js';
import { ReadOnlyBlocksPlugin } from './plugins/read-only-blocks.js';
import { SendPrompt } from './plugins/send-prompt.js';
import { TableBlocksPlugin } from './plugins/table-blocks.js';
import { UndeletableBlocksPlugin } from './plugins/undeletable-blocks.js';
import { conversationTheme } from './theme.js';

const MIN_ALLOWED_FONT_SIZE = 8;
const MAX_ALLOWED_FONT_SIZE = 72;

const parseAllowedFontSize = (input: string): string => {
  const match = input.match(/^(\d+(?:\.\d+)?)px$/);

  if (match) {
    const n = Number(match[1]);

    if (n >= MIN_ALLOWED_FONT_SIZE && n <= MAX_ALLOWED_FONT_SIZE) return input;
  }

  return '';
};

const parseAllowedColor = (input: string): string =>
  /^rgb\(\d+, \d+, \d+\)$/.test(input) ? input : '';

const RemoveStylesOverride = domOverride<ParagraphNode | TextNode>(
  [ParagraphNode, TextNode],
  {
    $exportDOM(_node, $next) {
      const output = $next();

      if (isHTMLElement(output.element)) {
        // TextNode may wrap its text in nested formatting elements.
        for (const el of [
          output.element,
          ...Array.from(output.element.querySelectorAll('[style],[class]')),
        ]) {
          el.removeAttribute('class');
          el.removeAttribute('style');
        }
      }

      return output;
    },
  },
);

const getExtraStyles = (element: HTMLElement): string => {
  // Keep only supported font sizes and colors from pasted input.
  let extraStyles = '';
  const fontSize = parseAllowedFontSize(element.style.fontSize);
  const backgroundColor = parseAllowedColor(element.style.backgroundColor);
  const color = parseAllowedColor(element.style.color);

  if (fontSize !== '' && fontSize !== '15px')
    extraStyles += `font-size: ${fontSize};`;
  if (backgroundColor !== '' && backgroundColor !== 'rgb(255, 255, 255)')
    extraStyles += `background-color: ${backgroundColor};`;
  if (color !== '' && color !== 'rgb(0, 0, 0)')
    extraStyles += `color: ${color};`;

  return extraStyles;
};

const AllowedStylesRule = defineImportRule({
  $import(_context, element, $next) {
    const nodes = $next();
    const extraStyles = getExtraStyles(element);

    if (extraStyles) {
      for (const node of nodes) {
        if ($isTextNode(node)) node.setStyle(node.getStyle() + extraStyles);
      }
    }

    return nodes;
  },
  match: sel.tag(
    'span',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'sub',
    'sup',
    'code',
    'mark',
  ),
  name: '@lexical/examples/allowed-styles',
});

const StyleImportExportExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    configExtension(DOMImportExtension, { rules: [AllowedStylesRule] }),
    configExtension(DOMRenderExtension, { overrides: [RemoveStylesOverride] }),
  ],
  name: '@lexical/examples/StyleImportExport',
});

/**
 * Lexical seeds a fresh editor with an empty paragraph. The editor's own block
 * here is the prompt — the reader's input, and the conversation's tail, with the
 * reader's author line trailing it — so it takes that place, and the transcript
 * is inserted above it rather than below a blank line.
 */
const PromptInitialState = defineExtension({
  $initialEditorState: () => {
    $getRoot().append($createUserPromptNode());
  },
  name: '@org/source/ConversationPromptInitialState',
});

/**
 * The editor the example mounts. Only the HMR hook differs: webpack hands a
 * module `module.hot` and not the Vite-shaped `import.meta.hot` the extension
 * reads, so the editor keeps none of its own.
 */
const defineConversationExtension = (
  added: ReturnType<ChatLexicalRegistry['freeze']>,
) =>
  defineExtension({
    dependencies: [
      configExtension(HMRExtension, { hot: null }),
      RichTextExtension,
      ClipboardDOMImportExtension,
      StyleImportExportExtension,
      EditorStateExtension,
      configExtension(HistoryExtension, { maxDepth: 50 }),
      TreeViewExtension,
      PromptInitialState,
      ...added.extensions,
    ],
    name: '@lexical/examples/react-rich',
    namespace: 'react-rich',
    theme: conversationTheme,
    nodes: [
      UserTurnNode,
      DelegatedTurnNode,
      AgentTurnNode,
      ThinkingTurnNode,
      ToolTurnNode,
      TurnAuthorNode,
      ActivityTurnNode,
      LifecycleTurnNode,
      CompactionTurnNode,
      QueueNode,
      PromptEditNode,
      QueuedTurnNode,
      FailureTurnNode,
      UserPromptNode,
      // The blocks the agent's markdown becomes; a heading, a quote, a list, a
      // fence and a table are nodes the editor has to know to hold the answer's
      // own text — a table's cells are the editor's nodes, so the caret crosses
      // them and the read-only rule still holds.
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      LinkNode,
      TableNode,
      TableRowNode,
      TableCellNode,
      // A block another bundle's projector made, drawn by its element.
      ChatBlockNode,
      // Nodes other bundles add through `chat.lexical/v1`.
      ...added.nodes,
    ],
  });

const noAdditions: ReturnType<ChatLexicalRegistry['freeze']> = {
  nodes: [],
  extensions: [],
};

let built:
  | {
      readonly registry: ChatLexicalRegistry | undefined;
      readonly extension: ReturnType<typeof defineConversationExtension>;
    }
  | undefined;

/**
 * The editor's extension, built when the window's first conversation editor
 * is: that freezes `chat.lexical/v1`, so every editor of the window holds the
 * same node list.
 */
const conversationExtension = () => {
  const registry = chatLexicalRegistry();
  if (built === undefined || built.registry !== registry) {
    built = {
      registry,
      extension: defineConversationExtension(registry?.freeze() ?? noAdditions),
    };
  }
  return built.extension;
};

/** External blocks are kept like every turn: a deletion never removes one. */
const isUndeletableNode = (nodeType: string): boolean =>
  nodeType === CHAT_BLOCK_NODE || isUndeletableBlock(nodeType);

/**
 * The element-creating side of `ui/v1` the conversation's blocks use: the
 * services of the `<chat-view>` the conversation is mounted in.
 */
export const ChatUiContext = createContext<Pick<
  Ui,
  'create' | 'dispose'
> | null>(null);

/**
 * The conversation surface: one Lexical editor holding the Thread's projected
 * turns and the reader's prompt. `useThreadChat` owns the subscription, the
 * projection and the sending; this surface renders them in a centred column.
 */
/**
 * The conversation's own send and stop, which the shell's control drives.
 *
 * The shell counts its requests and passes the count down: a value travelling
 * one way only. Nothing here writes state in the shell, because a child that
 * does that writes it during the shell's commit — which is what a render loop is
 * made of — and the shell has no way to read the editor anyway.
 */
export function Conversation({
  thread,
  promptSignal,
  sendRequest,
  autoFocus = true,
}: {
  readonly thread: Thread;
  /** Where the editor writes whether the prompt holds words. */
  readonly promptSignal?: PromptSignal;
  /** The shell's send requests, counted; each new count sends the prompt once. */
  readonly sendRequest?: number;
  readonly autoFocus?: boolean;
}) {
  const chat = useThreadChat(thread);
  const queue = useThreadQueue(thread.id);
  const extension = useMemo(conversationExtension, []);
  const external = useExternalBlocks(chat.events);
  useEffect(() => {
    if (chat.sendError !== undefined)
      toast.error(chat.sendError, { id: `thread-send-${thread.id}` });
  }, [chat.sendError, thread.id]);
  /**
   * The element the editor edits, built once and kept.
   *
   * The composer builds the editor from this element — its `useMemo` depends on
   * it — so a new element per render is a new editor per render: the transcript
   * is rebuilt under the reader's caret, and the scroll falls back to the top of
   * the conversation. A render of this surface must cost a render, nothing more.
   */
  const contentEditable = useMemo(
    () => <ContentEditable className="min-w-0 flex-1 outline-none" />,
    [],
  );
  // The scroll area whose viewport holds the transcript, for the nav rail beside it.
  const scrollRoot = useRef<HTMLDivElement>(null);
  const navigating = useRef(false);
  const following = useRef(true);
  // What the editor draws: the log's turns, and the two things the surface is
  // waiting for — the reader's words before the host accepts them, and the
  // agent's first step while it has produced nothing.
  const turns = useMemo(
    () => withPendingTurns(chat.turns, chat.pending),
    [chat.turns, chat.pending],
  );
  // The prompt the Thread is running. The shell reads the same Thread for its
  // own control; the keyboard needs it here, where the editor is.
  const activePromptId = chat.thread.activePromptId;
  const running =
    chat.thread.state === 'running' && activePromptId !== undefined;
  const stop = useThreadStop(chat.thread);
  const ui = useContext(ChatUiContext);
  const blocksSource = useMemo(
    () => ({ blocks: external.drawn, ui }),
    [external.drawn, ui],
  );

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1">
      <ScrollArea
        ref={scrollRoot}
        className="conversation-scroll min-h-0 min-w-0 w-full flex-1"
      >
        {/* The top padding keeps the first block off the header, since the
          transcript grows from the top of the scroll view. */}
        <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-80 text-sm font-light">
          <ChatBlocksContext.Provider value={blocksSource}>
            <LexicalExtensionComposer
              extension={extension}
              contentEditable={contentEditable}
            >
              <UndeletableBlocksPlugin
                isReadOnly={isReadOnlyBlock}
                isUndeletable={isUndeletableNode}
              />
              <ReadOnlyBlocksPlugin isReadOnly={isReadOnlyBlock} />
              <CaretNavigation />
              <TableBlocksPlugin />
              <MarkdownPromptPlugin />
              <PromptLineBreaks />
              <InsertThreadTurnNodes
                autoFocus={autoFocus}
                threadId={thread.id}
                turns={turns}
                blocks={external.placed}
                onResume={chat.resume}
                navigating={navigating}
                following={following}
              />
              <SendPrompt
                canStop={running}
                promptSignal={promptSignal}
                send={chat.prompt}
                sendRequest={sendRequest}
                onStop={stop}
                onResumeQueue={
                  !queue.resuming &&
                  !queue.isError &&
                  composerAction(running, queue.data) === 'resume'
                    ? queue.resume
                    : undefined
                }
              />
              <EditQueuePrompt threadId={thread.id} />
            </LexicalExtensionComposer>
          </ChatBlocksContext.Provider>
        </div>
        {/* Inside the scroll view, pinned to it: the rail is absolutely
          positioned against the scroll area's root, so the transcript scrolls
          beneath it and the rail holds the viewport's right edge. */}
        <ThreadNavRail
          scrollRoot={scrollRoot}
          turns={turns}
          navigating={navigating}
          following={following}
        />
      </ScrollArea>
    </div>
  );
}

import { ClipboardDOMImportExtension } from '@lexical/clipboard';
import { CodeNode } from '@lexical/code';
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
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
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
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import type { ChatFenceView } from '../../../../contracts/index.js';
import {
  isReadOnlyBlock,
  isUndeletableBlock,
} from '../../../domain/conversation-nodes.js';
import { turnKey } from '../../../domain/conversation-sync.js';
import { threadFences } from '../../../domain/fences.js';
import {
  withPendingTurns,
  withSentThreads,
} from '../../../domain/pending-turns.js';
import type { AgentTurn, Turn } from '../../../domain/projector.js';
import { composerAction } from '../../../domain/queue.js';
import type { Thread } from '../../../domain/workspace.js';
import { useAgentIcons } from '../../../hooks/use-agent-icons.js';
import { CommentThreadsContext } from '../../../hooks/use-comment-threads.js';
import { useExternalBlocks } from '../../../hooks/use-external-blocks.js';
import { ConversationThreadContext } from '../../../hooks/use-live-terminal.js';
import { useThreadChat } from '../../../hooks/use-thread-chat.js';
import { useThreadQueue } from '../../../hooks/use-thread-queue.js';
import { useThreadStop } from '../../../hooks/use-thread-stop.js';
import {
  type ChatLexicalRegistry,
  chatLexicalRegistry,
} from '../../../services/lexical.js';
import { chatViewsRegistry } from '../../../services/views.js';
import { retainProjectTerminals } from '../../../stores/live-terminals.js';
import type { PromptSignal } from '../../../utility/prompt-signal.js';
import { ThreadNavRail } from '../../molecules/thread-nav-rail.js';
import { ActivityTurnNode } from './nodes/activity-turn-node.js';
import { $agentTurns, AgentTurnNode } from './nodes/agent-turn-node.js';
import { AttachmentImageNode } from './nodes/attachment-image-node.js';
import {
  CHAT_BLOCK_NODE,
  ChatBlockNode,
  ChatBlocksContext,
} from './nodes/chat-block-node.js';
import { CommentLinesNode } from './nodes/comment-lines-node.js';
import { CommentSeatNode } from './nodes/comment-seat-node.js';
import { CompactionTurnNode } from './nodes/compaction-turn-node.js';
import { ComposerStackNode } from './nodes/composer-stack-node.js';
import { DelegatedTurnNode } from './nodes/delegated-turn-node.js';
import { FailureTurnNode } from './nodes/failure-turn-node.js';
import {
  ChatFencesContext,
  FenceElements,
  FenceNode,
  fenceElementKey,
} from './nodes/fence-node.js';
import { LifecycleTurnNode } from './nodes/lifecycle-turn-node.js';
import { PromptEditNode } from './nodes/prompt-edit-node.js';
import { QueueNode } from './nodes/queue-node.js';
import { QueuedTurnNode } from './nodes/queued-turn-node.js';
import { RepliesTurnNode } from './nodes/replies-turn-node.js';
import { TerminalResultNode } from './nodes/terminal-result-node.js';
import { ThinkingTurnNode } from './nodes/thinking-turn-node.js';
import { ThreadSpawnNode } from './nodes/thread-spawn-node.js';
import { ToolTurnNode } from './nodes/tool-turn-node.js';
import { TurnAuthorNode } from './nodes/turn-author-node.js';
import {
  $createUserPromptNode,
  UserPromptNode,
} from './nodes/user-prompt-node.js';
import { UserTurnNode } from './nodes/user-turn-node.js';
import { AttachImages } from './plugins/attach-images.js';
import { CaretNavigation } from './plugins/caret-navigation.js';
import { CommentHighlights } from './plugins/comment-highlights.js';
import { CommentSeats } from './plugins/comment-seats.js';
import { CommentSelection } from './plugins/comment-selection.js';
import { ComposerDraft } from './plugins/composer-draft.js';
import { EditQueuePrompt } from './plugins/edit-queue-prompt.js';
import { InsertThreadTurnNodes } from './plugins/insert-thread-turn-nodes.js';
import { MarkdownPromptPlugin } from './plugins/markdown-prompt.js';
import { PasteIntoPrompt } from './plugins/paste-into-prompt.js';
import { PromptLineBreaks } from './plugins/prompt-line-breaks.js';
import { ReadOnlyBlocksPlugin } from './plugins/read-only-blocks.js';
import { SendPrompt } from './plugins/send-prompt.js';
import { StackCaret } from './plugins/stack-caret.js';
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
 * The conversation's editor: rich text, the clipboard's DOM import with the
 * style rules above, a bounded undo history, the prompt as the first block,
 * and what other bundles add through `chat.lexical/v1`. Nothing a window
 * never uses rides along — no HMR, no editor-state signal, no debug tree view
 * — so no listener runs per update for a reader who cannot see its result.
 */
const defineConversationExtension = (
  added: ReturnType<ChatLexicalRegistry['freeze']>,
) =>
  defineExtension({
    dependencies: [
      RichTextExtension,
      ClipboardDOMImportExtension,
      StyleImportExportExtension,
      configExtension(HistoryExtension, { maxDepth: 50 }),
      PromptInitialState,
      ...added.extensions,
    ],
    name: '@lexical/examples/react-rich',
    namespace: 'react-rich',
    theme: conversationTheme,
    nodes: [
      UserTurnNode,
      DelegatedTurnNode,
      TerminalResultNode,
      AgentTurnNode,
      ThinkingTurnNode,
      ToolTurnNode,
      ThreadSpawnNode,
      TurnAuthorNode,
      ActivityTurnNode,
      LifecycleTurnNode,
      CompactionTurnNode,
      QueueNode,
      ComposerStackNode,
      CommentLinesNode,
      CommentSeatNode,
      PromptEditNode,
      QueuedTurnNode,
      FailureTurnNode,
      RepliesTurnNode,
      UserPromptNode,
      AttachmentImageNode,
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
      // A fence of a tag another bundle draws (openui.md D1).
      FenceNode,
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

const noTags: ReadonlySet<string> = new Set();
const noRegistry = () => () => {};

/** The window's fence tags, read again on every registration or its end (D1). */
const useFenceTags = (): ReadonlySet<string> => {
  const registry = chatViewsRegistry();
  return useSyncExternalStore(
    registry?.subscribe ?? noRegistry,
    () => registry?.fenceTags() ?? noTags,
  );
};

/**
 * Builds every agent turn the conversation shows again when the fence tags
 * change, so a registration that starts or ends turns code blocks into
 * fences or back (D1).
 */
function FenceSync({
  tags,
  turns,
}: {
  readonly tags: ReadonlySet<string>;
  readonly turns: readonly Turn[];
}) {
  const [editor] = useLexicalComposerContext();
  const seen = useRef(tags);
  const latest = useRef(turns);
  latest.current = turns;

  useEffect(() => {
    if (seen.current === tags) return;
    seen.current = tags;
    const agents = new Map<string, AgentTurn>();
    for (const turn of latest.current)
      if (turn.type === 'agent') agents.set(turnKey(turn), turn);
    editor.update(() => {
      for (const node of $agentTurns()) {
        const turn = agents.get(node.__turnKey);
        if (turn !== undefined) node.setTurn(turn, { rebuild: true });
      }
    });
  }, [editor, tags]);
  return null;
}

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
 *
 * The shell's control drives the conversation's own send and stop. The shell
 * counts its requests and passes the count down: a value travelling one way
 * only. Nothing here writes state in the shell, because a child that does that
 * writes it during the shell's commit — which is what a render loop is made of
 * — and the shell has no way to read the editor anyway.
 *
 * Memoised on its props: the view around it re-renders on every change of the
 * window's workspace tree (another Thread's state, a rename), and the surface
 * has nothing to draw for those — its own changes reach it through the stores
 * it reads.
 */
export const Conversation = memo(function Conversation({
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
    () => withPendingTurns(chat.turns, chat.pending, chat.outbox),
    [chat.turns, chat.pending, chat.outbox],
  );
  const agentIcons = useAgentIcons(turns);
  // The comment threads, with the comments sent that the log does not hold
  // yet: a sent comment stays in the answer from the send on.
  const threads = useMemo(
    () => withSentThreads(chat.threads, chat.outbox),
    [chat.threads, chat.outbox],
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
  const threadInfo = useMemo(
    () => ({ threadId: thread.id, projectId: thread.projectId }),
    [thread.id, thread.projectId],
  );
  // The Thread as the transcript's plugins key their work: its id and its
  // Project's, which never change, rather than the record, which changes with
  // every state the Thread passes through — a sync pass or a re-registered
  // transform per lifecycle change would draw nothing new.
  const threadScope = useMemo(
    () => ({ id: thread.id, projectId: thread.projectId }),
    [thread.id, thread.projectId],
  );
  useEffect(() => retainProjectTerminals(thread.projectId), [thread.projectId]);
  // The Thread's fences of every registered tag (D1, D2), and the view each
  // fence element receives.
  const tags = useFenceTags();
  const fences = useMemo(
    () =>
      threadFences(turns, tags, {
        projectId: thread.projectId,
        threadId: thread.id,
      }),
    [turns, tags, thread.projectId, thread.id],
  );
  const origin = chat.thread.origin ?? 'user';
  const fenceViews = useMemo(() => {
    const tagOf = (fence: ChatFenceView['fence']) =>
      fence.info.split(/\s+/)[0] ?? '';
    const byTag = new Map<string, ChatFenceView['fence'][]>();
    for (const fence of fences) {
      const tag = tagOf(fence);
      byTag.set(tag, [...(byTag.get(tag) ?? []), fence]);
    }
    return new Map<string, ChatFenceView>(
      fences.map((fence) => [
        fenceElementKey(tagOf(fence), fence.key),
        { fence, origin, fences: byTag.get(tagOf(fence)) ?? [] },
      ]),
    );
  }, [fences, origin]);
  const fenceElements = useMemo(
    () =>
      ui === null
        ? null
        : // A new Thread is a new set of elements; the old one is disposed below.
          new FenceElements(ui, thread.id, (tag) =>
            chatViewsRegistry()?.fenceRendererFor(tag),
          ),
    [ui, thread.id],
  );
  // Set before the decorators of this render take their elements.
  fenceElements?.update(fenceViews);
  useEffect(() => () => fenceElements?.dispose(), [fenceElements]);

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1">
      <ScrollArea
        ref={scrollRoot}
        className="conversation-scroll min-h-0 min-w-0 w-full flex-1"
      >
        {/* The column holds the gutter mark inside its own left padding (the
          mark's 1.875rem), so the text is 722 px wide in the 768 px column,
          and its first line sits 2 px under the top (Figma `99:8035`
          `171:52891`). A pane narrower than the column widens both
          (`styles.css`). */}
        <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-1 flex-col pl-[1.875rem] pr-4 pt-0.5 pb-80 text-sm font-light">
          <ConversationThreadContext.Provider value={threadInfo}>
            <CommentThreadsContext.Provider value={threads}>
              <ChatBlocksContext.Provider value={blocksSource}>
                <ChatFencesContext.Provider value={fenceElements}>
                  <LexicalExtensionComposer
                    extension={extension}
                    contentEditable={contentEditable}
                  >
                    <FenceSync tags={tags} turns={turns} />
                    <UndeletableBlocksPlugin
                      isReadOnly={isReadOnlyBlock}
                      isUndeletable={isUndeletableNode}
                    />
                    <ReadOnlyBlocksPlugin isReadOnly={isReadOnlyBlock} />
                    <CaretNavigation />
                    <TableBlocksPlugin />
                    <MarkdownPromptPlugin />
                    <PromptLineBreaks />
                    <AttachImages threadId={thread.id} />
                    <PasteIntoPrompt />
                    <InsertThreadTurnNodes
                      autoFocus={autoFocus}
                      thread={threadScope}
                      turns={turns}
                      agentIcons={agentIcons}
                      blocks={external.placed}
                      onResume={chat.resume}
                      navigating={navigating}
                      following={following}
                    />
                    <ComposerDraft thread={thread} />
                    <SendPrompt
                      canStop={running}
                      promptSignal={promptSignal}
                      send={chat.prompt}
                      steer={chat.steer}
                      sendRequest={sendRequest}
                      threadId={thread.id}
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
                    <CommentSelection />
                    <CommentSeats />
                    <CommentHighlights />
                    <StackCaret />
                  </LexicalExtensionComposer>
                </ChatFencesContext.Provider>
              </ChatBlocksContext.Provider>
            </CommentThreadsContext.Provider>
          </ConversationThreadContext.Provider>
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
});

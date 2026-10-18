// The conversation editor a node story draws in: the same Lexical node set,
// theme and read-only rules the conversation registers
// (`src/client/components/organisms/conversation/index.tsx`), seeded with an
// initial editor state that holds only the blocks a story needs, inside the
// window state those blocks read (`stories/support/conversation.ts`).
//
// The conversation's own editor extension is private to its module, and it
// freezes `chat.lexical/v1` when it is built, so the node list is repeated
// here; stories register no `chat.lexical/v1` additions. Turns become blocks
// the way `InsertThreadTurnNodes` builds them on a fresh editor: one block
// per turn, the comment lines above a user turn that carries them, and the
// author line the sync plan names after the block.

import { CodeNode } from '@lexical/code';
import { HistoryExtension } from '@lexical/history';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { HeadingNode, QuoteNode, RichTextExtension } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from 'desktop/ui/tooltip';
import {
  $createNodeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import { type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { GenericBlock } from '../../src/client/components/molecules/generic-block.js';
import { ChatUiContext } from '../../src/client/components/organisms/conversation/index.js';
import {
  $createActivityTurnNode,
  ActivityTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/activity-turn-node.js';
import {
  $createAgentTurnNode,
  AgentTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/agent-turn-node.js';
import {
  CHAT_BLOCK_NODE,
  ChatBlockNode,
  ChatBlocksContext,
  type DrawnBlock,
} from '../../src/client/components/organisms/conversation/nodes/chat-block-node.js';
import {
  $createCommentLinesNode,
  CommentLinesNode,
} from '../../src/client/components/organisms/conversation/nodes/comment-lines-node.js';
import {
  $createCompactionTurnNode,
  CompactionTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/compaction-turn-node.js';
import {
  $createComposerStackNode,
  ComposerStackNode,
} from '../../src/client/components/organisms/conversation/nodes/composer-stack-node.js';
import {
  $createDelegatedTurnNode,
  DelegatedTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/delegated-turn-node.js';
import {
  $createFailureTurnNode,
  FailureTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/failure-turn-node.js';
import {
  $createLifecycleTurnNode,
  LifecycleTurnNode,
  type ResumePrompt,
} from '../../src/client/components/organisms/conversation/nodes/lifecycle-turn-node.js';
import { PromptEditNode } from '../../src/client/components/organisms/conversation/nodes/prompt-edit-node.js';
import { QueueNode } from '../../src/client/components/organisms/conversation/nodes/queue-node.js';
import { QueuedTurnNode } from '../../src/client/components/organisms/conversation/nodes/queued-turn-node.js';
import {
  $createRepliesTurnNode,
  RepliesTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/replies-turn-node.js';
import {
  $createTerminalResultNode,
  TerminalResultNode,
} from '../../src/client/components/organisms/conversation/nodes/terminal-result-node.js';
import {
  $createThinkingTurnNode,
  ThinkingTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/thinking-turn-node.js';
import {
  $createToolTurnNode,
  ToolTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/tool-turn-node.js';
import {
  $createTurnAuthorNode,
  TurnAuthorNode,
} from '../../src/client/components/organisms/conversation/nodes/turn-author-node.js';
import {
  $createUserPromptNode,
  UserPromptNode,
} from '../../src/client/components/organisms/conversation/nodes/user-prompt-node.js';
import {
  $createUserTurnNode,
  UserTurnNode,
} from '../../src/client/components/organisms/conversation/nodes/user-turn-node.js';
import { CaretNavigation } from '../../src/client/components/organisms/conversation/plugins/caret-navigation.js';
import { MarkdownPromptPlugin } from '../../src/client/components/organisms/conversation/plugins/markdown-prompt.js';
import { PasteIntoPrompt } from '../../src/client/components/organisms/conversation/plugins/paste-into-prompt.js';
import { PromptLineBreaks } from '../../src/client/components/organisms/conversation/plugins/prompt-line-breaks.js';
import { ReadOnlyBlocksPlugin } from '../../src/client/components/organisms/conversation/plugins/read-only-blocks.js';
import { TableBlocksPlugin } from '../../src/client/components/organisms/conversation/plugins/table-blocks.js';
import { UndeletableBlocksPlugin } from '../../src/client/components/organisms/conversation/plugins/undeletable-blocks.js';
import { conversationTheme } from '../../src/client/components/organisms/conversation/theme.js';
import type { CommentThreads } from '../../src/client/domain/comment-threads.js';
import { READER_NAME } from '../../src/client/domain/conversation-authors.js';
import {
  isReadOnlyBlock,
  isUndeletableBlock,
} from '../../src/client/domain/conversation-nodes.js';
import { syncPlan } from '../../src/client/domain/conversation-sync.js';
import type { Turn } from '../../src/client/domain/projector.js';
import type { Thread, ThreadEvent } from '../../src/client/domain/workspace.js';
import { CommentThreadsContext } from '../../src/client/hooks/use-comment-threads.js';
import { ConversationThreadContext } from '../../src/client/hooks/use-live-terminal.js';
import type { QueueEdit } from '../../src/client/stores/queue-edit.js';
import { queueEditStore } from '../../src/client/stores/queue-edit.js';
import type { RenderBlock } from '../../src/contracts/index.js';
import {
  installStoryHost,
  nodesThread,
  openThreads,
  type StoryHost,
  storyQueryClient,
} from './conversation.js';

// The window ------------------------------------------------------------------

/** The `ui/v1` element factory a story's blocks are created through. */
const roots = new WeakMap<object, Root>();

/**
 * Creates the element a block's tag names the way `ui/v1` creates the
 * bundle's own `<chat-block>`: a node whose `block` property draws the
 * generic block, re-rendered whenever the conversation sets it.
 */
export const storyUi = {
  create: (tag: string, props?: Readonly<Record<string, unknown>>): object => {
    const element = document.createElement(tag);
    const root = createRoot(element);
    let block = props?.block as RenderBlock | undefined;
    const draw = () => root.render(<GenericBlock block={block} />);
    Object.defineProperty(element, 'block', {
      get: () => block,
      set: (next: RenderBlock | undefined) => {
        block = next;
        draw();
      },
    });
    draw();
    roots.set(element, root);
    return element;
  },
  dispose: (element: object): void => {
    const root = roots.get(element);
    roots.delete(element);
    if (root !== undefined) queueMicrotask(() => root.unmount());
  },
};

const noThreads: CommentThreads = new Map();
const noBlocks: ReadonlyMap<string, DrawnBlock> = new Map();

/** What a story's window holds before anything in it renders. */
export interface StoryWindowProps {
  /** The Thread the blocks stand in. */
  readonly thread?: Thread;
  /** The fake host's answers: queues, composer drafts, live terminals. */
  readonly host?: StoryHost;
  /** The Threads the opened-Thread store holds, each from its log. */
  readonly opened?: readonly {
    readonly thread: Thread;
    readonly events: readonly ThreadEvent[];
  }[];
  /** The queued prompts the composer is editing, by Thread. */
  readonly edits?: Readonly<Record<string, QueueEdit | undefined>>;
  /** The conversation's comment threads, by root id. */
  readonly threads?: CommentThreads;
  /** Other bundles' blocks the conversation draws, by id. */
  readonly blocks?: ReadonlyMap<string, DrawnBlock>;
  readonly children: ReactNode;
}

/**
 * The providers and the stores a conversation block reads, prepared once
 * before the story's first render: the elements' query client and tooltips,
 * the Thread the blocks stand in, its comment threads, the external blocks
 * and the element factory.
 */
export function StoryWindow({
  thread = nodesThread,
  host,
  opened,
  edits,
  threads = noThreads,
  blocks = noBlocks,
  children,
}: StoryWindowProps) {
  const [client] = useState(() => {
    installStoryHost(host);
    openThreads(opened ?? []);
    queueEditStore.setState({ edits: edits ?? {} });
    return storyQueryClient(host);
  });
  const [threadInfo] = useState(() => ({
    threadId: thread.id,
    projectId: thread.projectId,
  }));
  const [blocksSource] = useState(() => ({ blocks, ui: storyUi }));

  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ChatUiContext.Provider value={storyUi}>
          <ConversationThreadContext.Provider value={threadInfo}>
            <CommentThreadsContext.Provider value={threads}>
              <ChatBlocksContext.Provider value={blocksSource}>
                {children}
              </ChatBlocksContext.Provider>
            </CommentThreadsContext.Provider>
          </ConversationThreadContext.Provider>
        </ChatUiContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

// The editor ------------------------------------------------------------------

/** The conversation's node list, in the order its extension declares it. */
const conversationNodes = [
  UserTurnNode,
  DelegatedTurnNode,
  TerminalResultNode,
  AgentTurnNode,
  ThinkingTurnNode,
  ToolTurnNode,
  TurnAuthorNode,
  ActivityTurnNode,
  LifecycleTurnNode,
  CompactionTurnNode,
  QueueNode,
  ComposerStackNode,
  CommentLinesNode,
  PromptEditNode,
  QueuedTurnNode,
  FailureTurnNode,
  RepliesTurnNode,
  UserPromptNode,
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  LinkNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  ChatBlockNode,
];

const storyExtension = (seed: () => void) =>
  defineExtension({
    dependencies: [
      RichTextExtension,
      configExtension(HistoryExtension, { maxDepth: 50 }),
      defineExtension({
        $initialEditorState: seed,
        name: '@org/source/ConversationStoryInitialState',
      }),
    ],
    name: '@org/source/ConversationStory',
    namespace: 'react-rich',
    theme: conversationTheme,
    nodes: conversationNodes,
  });

const isUndeletableNode = (nodeType: string): boolean =>
  nodeType === CHAT_BLOCK_NODE || isUndeletableBlock(nodeType);

/** A story's conversation editor: the window, then the seeded editor in it. */
export function ConversationEditor({
  seed,
  children,
  ...window
}: Omit<StoryWindowProps, 'children'> & {
  /** Builds the root's blocks; runs once, as the editor's initial state. */
  readonly seed: () => void;
  /** Plugins beside the conversation's read-only and prompt rules. */
  readonly children?: ReactNode;
}) {
  const [extension] = useState(() => storyExtension(seed));
  const [contentEditable] = useState(() => (
    <ContentEditable className="min-w-0 flex-1 outline-none" />
  ));

  return (
    <StoryWindow {...window}>
      <div className="flex min-w-0 w-full flex-col text-sm font-light">
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
          <PasteIntoPrompt />
          {children}
        </LexicalExtensionComposer>
      </div>
    </StoryWindow>
  );
}

/** A story editor holding the blocks of the given turns, and nothing else. */
export function TurnsEditor({
  turns,
  after,
  ...rest
}: Omit<Parameters<typeof ConversationEditor>[0], 'seed'> & {
  readonly turns: readonly Turn[];
  /** Runs on the created blocks, in transcript order, before the first paint. */
  readonly after?: (blocks: readonly LexicalNode[]) => void;
}) {
  return (
    <ConversationEditor
      {...rest}
      seed={() => {
        const blocks = $appendTurns(turns);
        after?.(blocks);
      }}
    />
  );
}

// Seeding -----------------------------------------------------------------------

const noResume: ResumePrompt = () => undefined;

/** The block a turn becomes: the switch `InsertThreadTurnNodes` creates with. */
const $createTurnBlock = (
  turn: Turn,
  key: string,
  onResume: ResumePrompt,
): LexicalNode => {
  switch (turn.type) {
    case 'queued':
      return new QueuedTurnNode(key, turn.promptId, turn.items);
    case 'user':
      if (turn.terminal !== undefined)
        return $createTerminalResultNode({
          turnKey: key,
          promptId: turn.promptId,
          result: turn.terminal,
        });
      if (turn.delegated !== undefined)
        return $createDelegatedTurnNode({
          turnKey: key,
          promptId: turn.promptId,
          input: turn.delegated,
        });
      return $createUserTurnNode(
        key,
        turn.promptId,
        turn.delegated,
        turn.text,
        turn.accepted,
      );
    case 'agent':
      return $createAgentTurnNode(key, turn.promptId, turn.status, turn.text);
    case 'thinking':
      return $createThinkingTurnNode(
        key,
        turn.promptId,
        turn.text,
        turn.streaming,
      );
    case 'activity':
      return $createActivityTurnNode(
        key,
        turn.promptId,
        turn.thoughts,
        turn.tools,
        turn.items,
      );
    case 'tool_call':
      return $createToolTurnNode(
        key,
        turn.promptId,
        turn.callId,
        turn.name,
        turn.args,
        turn.status,
        turn.result,
        turn.error,
      );
    case 'lifecycle':
      return $createLifecycleTurnNode(
        key,
        turn.promptId,
        turn.lifecycle,
        onResume,
      );
    case 'failure':
      return $createFailureTurnNode(key, turn.promptId, turn.failure);
    case 'replies':
      return $createRepliesTurnNode(key, turn.promptId, turn.replies);
    case 'compaction':
      return $createCompactionTurnNode(
        key,
        turn.promptId,
        turn.trigger,
        turn.status,
        turn.condensedMessages,
        turn.tokensFreed,
        turn.code,
        turn.summary,
      );
  }
};

/**
 * Appends the blocks of the turns to the root as a fresh conversation builds
 * them, and returns the turn blocks in transcript order.
 */
export const $appendTurns = (
  turns: readonly Turn[],
  onResume: ResumePrompt = noResume,
): readonly LexicalNode[] => {
  const root = $getRoot();
  const blocks: LexicalNode[] = [];
  for (const step of syncPlan([], turns, turns.length).steps) {
    if (step.kind !== 'create') continue;
    const { turn } = step;
    if (
      turn.type === 'user' &&
      turn.delegated === undefined &&
      turn.terminal === undefined &&
      turn.comments.length > 0
    )
      root.append($createCommentLinesNode(turn.promptId, turn.comments));
    const block = $createTurnBlock(turn, step.key, onResume);
    root.append(block);
    if (step.author !== null)
      root.append(
        $createTurnAuthorNode(
          step.author.role,
          step.author.name,
          step.author.at,
        ),
      );
    blocks.push(block);
  }
  return blocks;
};

/**
 * Appends the conversation's tail: the queue, the comment stack, the edit
 * heading, the prompt (with the words given) and the reader's author line.
 */
export const $appendPromptTail = (
  thread: { readonly id: string; readonly projectId: string },
  words = '',
): { readonly queue: QueueNode; readonly prompt: UserPromptNode } => {
  const root = $getRoot();
  const queue = new QueueNode(thread.id);
  const prompt = $createUserPromptNode();
  if (words.length > 0) prompt.append($createTextNode(words));
  root.append(
    queue,
    $createComposerStackNode(thread),
    new PromptEditNode(thread.id),
    prompt,
    $createTurnAuthorNode('user', READER_NAME, undefined),
  );
  return { queue, prompt };
};

/** Gives the nodes the editor's focus, as a click on their widget does. */
export const $focusNodes = (...nodes: readonly LexicalNode[]): void => {
  const selection = $createNodeSelection();
  for (const node of nodes) selection.add(node.getKey());
  $setSelection(selection);
};

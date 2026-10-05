import { ThreadNavRail } from '@/components/molecules/thread-nav-rail';
import { ActivityTurnNode } from '@/components/organisms/conversation/nodes/activity-turn-node';
import { AgentTurnNode } from '@/components/organisms/conversation/nodes/agent-turn-node';
import { DelegatedTurnNode } from '@/components/organisms/conversation/nodes/delegated-turn-node';
import { FailureTurnNode } from '@/components/organisms/conversation/nodes/failure-turn-node';
import { LifecycleTurnNode } from '@/components/organisms/conversation/nodes/lifecycle-turn-node';
import { ThinkingTurnNode } from '@/components/organisms/conversation/nodes/thinking-turn-node';
import { ToolTurnNode } from '@/components/organisms/conversation/nodes/tool-turn-node';
import { TurnAuthorNode } from '@/components/organisms/conversation/nodes/turn-author-node';
import {
  $createUserPromptNode,
  UserPromptNode,
} from '@/components/organisms/conversation/nodes/user-prompt-node';
import { UserTurnNode } from '@/components/organisms/conversation/nodes/user-turn-node';
import { CaretNavigation } from '@/components/organisms/conversation/plugins/caret-navigation';
import { InsertThreadTurnNodes } from '@/components/organisms/conversation/plugins/insert-thread-turn-nodes';
import { MarkdownPromptPlugin } from '@/components/organisms/conversation/plugins/markdown-prompt';
import { PromptLineBreaks } from '@/components/organisms/conversation/plugins/prompt-line-breaks';
import { ReadOnlyBlocksPlugin } from '@/components/organisms/conversation/plugins/read-only-blocks';
import { SendPrompt } from '@/components/organisms/conversation/plugins/send-prompt';
import { TableBlocksPlugin } from '@/components/organisms/conversation/plugins/table-blocks';
import { UndeletableBlocksPlugin } from '@/components/organisms/conversation/plugins/undeletable-blocks';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  isReadOnlyBlock,
  isUndeletableBlock,
} from '@/domain/conversation-nodes';
import { withPendingTurns } from '@/domain/pending-turns';
import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import type { PromptSignal } from '@/utility/prompt-signal';
import { ClipboardDOMImportExtension } from '@lexical/clipboard';
import { CodeNode } from '@lexical/code';
import { EditorStateExtension, HMRExtension } from '@lexical/extension';
import { HistoryExtension } from '@lexical/history';
import {
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { TreeViewExtension } from '@lexical/react/TreeViewExtension';
import { HeadingNode, QuoteNode, RichTextExtension } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import {
  $getRoot,
  $isTextNode,
  configExtension,
  defineExtension,
  type EditorThemeClasses,
  isHTMLElement,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';

/** The theme the example names; its classes wait for a stylesheet of their own. */
const exampleTheme: EditorThemeClasses = {
  code: 'editor-code',
  heading: {
    h1: 'editor-heading-h1',
    h2: 'editor-heading-h2',
    h3: 'editor-heading-h3',
    h4: 'editor-heading-h4',
    h5: 'editor-heading-h5',
    h6: 'editor-heading-h6',
  },
  image: 'editor-image',
  link: 'editor-link',
  list: {
    listitem: 'editor-listitem',
    nested: { listitem: 'editor-nested-listitem' },
    ol: 'editor-list-ol',
    ul: 'editor-list-ul',
  },
  paragraph: 'editor-paragraph',
  quote: 'editor-quote',
  table: 'editor-table',
  tableCell: 'editor-table-cell',
  tableCellHeader: 'editor-table-cell-header',
  tableRow: 'editor-table-row',
  text: {
    bold: 'editor-text-bold',
    code: 'editor-text-code',
    italic: 'editor-text-italic',
    overflowed: 'editor-text-overflowed',
    strikethrough: 'editor-text-strikethrough',
    underline: 'editor-text-underline',
    underlineStrikethrough: 'editor-text-underlineStrikethrough',
  },
};

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
const conversationExtension = defineExtension({
  dependencies: [
    configExtension(HMRExtension, { hot: null }),
    RichTextExtension,
    ClipboardDOMImportExtension,
    StyleImportExportExtension,
    EditorStateExtension,
    HistoryExtension,
    TreeViewExtension,
    PromptInitialState,
  ],
  name: '@lexical/examples/react-rich',
  namespace: 'react-rich',
  theme: exampleTheme,
  nodes: [
    UserTurnNode,
    DelegatedTurnNode,
    AgentTurnNode,
    ThinkingTurnNode,
    ToolTurnNode,
    TurnAuthorNode,
    ActivityTurnNode,
    LifecycleTurnNode,
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
  ],
});

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
}: {
  readonly thread: Thread;
  /** Where the editor writes whether the prompt holds words. */
  readonly promptSignal?: PromptSignal;
  /** The shell's send requests, counted; each new count sends the prompt once. */
  readonly sendRequest?: number;
}) {
  const chat = useThreadChat(thread);
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
    () => <ContentEditable className="flex-1 outline-none" />,
    [],
  );
  // The scroll area whose viewport holds the transcript, for the nav rail beside it.
  const scrollRoot = useRef<HTMLDivElement>(null);
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
  const stop = useCallback((): void => {
    if (activePromptId === undefined) return;
    // A refusal is the run having settled first, which is the same outcome the
    // reader asked for; there is nothing left to report.
    void window.doric.threads
      .interrupt(chat.thread.id, activePromptId)
      .catch(() => undefined);
  }, [activePromptId, chat.thread.id]);

  return (
    <div className="flex min-h-0 w-full flex-1">
      <ScrollArea
        ref={scrollRoot}
        className="conversation-scroll min-h-0 w-full flex-1"
      >
        {/* The top padding keeps the first block off the header, since the
          transcript grows from the top of the scroll view. */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-6 pb-80 text-sm font-light">
          <LexicalExtensionComposer
            extension={conversationExtension}
            contentEditable={contentEditable}
          >
            <UndeletableBlocksPlugin
              isReadOnly={isReadOnlyBlock}
              isUndeletable={isUndeletableBlock}
            />
            <ReadOnlyBlocksPlugin isReadOnly={isReadOnlyBlock} />
            <CaretNavigation />
            <TableBlocksPlugin />
            <MarkdownPromptPlugin />
            <PromptLineBreaks />
            <InsertThreadTurnNodes turns={turns} onResume={chat.resume} />
            <SendPrompt
              canStop={running}
              promptSignal={promptSignal}
              send={chat.prompt}
              sendRequest={sendRequest}
              onStop={stop}
            />
          </LexicalExtensionComposer>
        </div>
        {/* Inside the scroll view, pinned to it: the rail is absolutely
          positioned against the scroll area's root, so the transcript scrolls
          beneath it and the rail holds the viewport's right edge. */}
        <ThreadNavRail scrollRoot={scrollRoot} turns={turns} />
      </ScrollArea>
    </div>
  );
}

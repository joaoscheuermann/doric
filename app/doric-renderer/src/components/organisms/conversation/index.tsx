import { AgentTurnNode } from '@/components/organisms/conversation/nodes/agent-turn-node';
import { ThinkingTurnNode } from '@/components/organisms/conversation/nodes/thinking-turn-node';
import { ToolTurnNode } from '@/components/organisms/conversation/nodes/tool-turn-node';
import { TurnAuthorNode } from '@/components/organisms/conversation/nodes/turn-author-node';
import {
  $createUserPromptNode,
  UserPromptNode,
} from '@/components/organisms/conversation/nodes/user-prompt-node';
import { UserTurnNode } from '@/components/organisms/conversation/nodes/user-turn-node';
import { InsertThreadTurnNodes } from '@/components/organisms/conversation/plugins/insert-thread-turn-nodes';
import { ReadOnlyBlocksPlugin } from '@/components/organisms/conversation/plugins/read-only-blocks';
import { UndeletableBlocksPlugin } from '@/components/organisms/conversation/plugins/undeletable-blocks';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  isReadOnlyBlock,
  isUndeletableBlock,
} from '@/domain/conversation-nodes';
import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import { ClipboardDOMImportExtension } from '@lexical/clipboard';
import {
  AutoFocusExtension,
  EditorStateExtension,
  HMRExtension,
} from '@lexical/extension';
import { HistoryExtension } from '@lexical/history';
import {
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { TreeViewExtension } from '@lexical/react/TreeViewExtension';
import { RichTextExtension } from '@lexical/rich-text';
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

/** The theme the example names; its classes wait for a stylesheet of their own. */
const exampleTheme: EditorThemeClasses = {
  code: 'editor-code',
  heading: {
    h1: 'editor-heading-h1',
    h2: 'editor-heading-h2',
    h3: 'editor-heading-h3',
    h4: 'editor-heading-h4',
    h5: 'editor-heading-h5',
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
 * here is the prompt — the reader's input, and the last block of the
 * conversation — so it takes that place, and the transcript is inserted above
 * it rather than below a blank line.
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
    AutoFocusExtension,
    TreeViewExtension,
    PromptInitialState,
  ],
  name: '@lexical/examples/react-rich',
  namespace: 'react-rich',
  theme: exampleTheme,
  nodes: [
    UserTurnNode,
    AgentTurnNode,
    ThinkingTurnNode,
    ToolTurnNode,
    TurnAuthorNode,
    UserPromptNode,
  ],
});

/**
 * The conversation surface: one Lexical editor holding the Thread's projected
 * turns and the reader's prompt. `useThreadChat` owns the subscription, the
 * projection and the sending; this surface renders them in a centred column.
 *
 * `onSandboxWrite` is additive: this surface takes it and ignores it, and the
 * caller may use it when the log grows a write to the sandbox the Project's
 * Threads share.
 */
export function Conversation({
  thread,
}: {
  readonly thread: Thread;
  readonly onSandboxWrite?: () => void;
}) {
  const chat = useThreadChat(thread);

  return (
    <ScrollArea className="conversation-scroll min-h-0 w-full flex-1">
      {/* The top padding keeps the first block off the header, since the
          transcript grows from the top of the scroll view. */}
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-4 text-sm font-light">
        <LexicalExtensionComposer
          extension={conversationExtension}
          contentEditable={<ContentEditable className="flex-1 outline-none" />}
        >
          <UndeletableBlocksPlugin
            isReadOnly={isReadOnlyBlock}
            isUndeletable={isUndeletableBlock}
          />
          <ReadOnlyBlocksPlugin isReadOnly={isReadOnlyBlock} />
          <InsertThreadTurnNodes turns={chat.turns} />
        </LexicalExtensionComposer>
      </div>
    </ScrollArea>
  );
}

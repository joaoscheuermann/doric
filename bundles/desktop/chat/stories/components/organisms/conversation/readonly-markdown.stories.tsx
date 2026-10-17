import {
  ReadonlyMarkdown,
  ReadonlyMarkdownView,
} from '../../../../src/client/components/organisms/conversation/readonly-markdown.js';
import { conversationTheme } from '../../../../src/client/components/organisms/conversation/theme.js';
import { redesignAnswer } from '../../../support/conversation.js';
import { ConversationEditor } from '../../../support/editor.js';

/** Inside a widget of the conversation, reading the editor's theme. */
const inConversation = (text: string) => (
  <ConversationEditor seed={() => undefined}>
    <div className="rounded-md border border-border p-3">
      <ReadonlyMarkdown text={text} />
    </div>
  </ConversationEditor>
);

export default {
  title: 'Chat/Organisms/Readonly markdown',
  component: ReadonlyMarkdown,
};

/** A widget's detail: a delegated result, a summary, a reply. */
export const InConversation = {
  render: () => inConversation(redesignAnswer),
};

/** A short detail. */
export const Short = {
  render: () =>
    inConversation('Fixed: the button now uses the `primary` token.'),
};

/** A detail with no words. */
export const Empty = {
  render: () => inConversation(''),
};

/** The same detail outside a conversation, with the theme handed to it. */
export const ThemedView = {
  render: () => (
    <ReadonlyMarkdownView text={redesignAnswer} theme={conversationTheme} />
  ),
};

/** Outside a conversation without a theme: the markdown unstyled. */
export const UnthemedView = {
  render: () => <ReadonlyMarkdownView text={redesignAnswer} />,
};

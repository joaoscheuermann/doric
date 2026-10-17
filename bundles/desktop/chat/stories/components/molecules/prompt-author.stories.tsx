import type { ComponentType } from 'react';

import { PromptAuthor } from '../../../src/client/components/molecules/prompt-author.js';
import { threadIds } from '../../support/fixtures.js';

export default {
  title: 'Chat/Molecules/Prompt author',
  component: PromptAuthor,
  decorators: [
    // The row a queued receipt and the input queue draw the identity in.
    (Story: ComponentType) => (
      <div className="flex items-center gap-2 font-conversation text-sm font-light">
        <Story />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Fix the two suites that still use jest.mock hoisting.
        </span>
      </div>
    ),
  ],
};

export const Reader = {
  render: () => <PromptAuthor source={{ kind: 'user' }} />,
};

export const Terminal = {
  render: () => (
    <PromptAuthor
      source={{ kind: 'terminal', terminalId: 'term-7f3a' }}
      label="npm run dev"
    />
  ),
};

export const TerminalUnnamed = {
  render: () => <PromptAuthor source={{ kind: 'terminal' }} />,
};

export const ParentThread = {
  render: () => (
    <PromptAuthor source={{ kind: 'parent', threadId: threadIds.delegated }} />
  ),
};

export const SubthreadResult = {
  render: () => (
    <PromptAuthor source={{ kind: 'result', threadId: threadIds.child }} />
  ),
};

export const LongLabel = {
  render: () => (
    <PromptAuthor
      source={{ kind: 'result', threadId: threadIds.child }}
      label="Subthread · Check color contrast across every storefront page"
    />
  ),
};

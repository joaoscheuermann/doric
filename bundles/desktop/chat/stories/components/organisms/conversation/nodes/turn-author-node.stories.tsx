import { $getRoot } from 'lexical';

import { $createAgentTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/agent-turn-node.js';
import { $createTurnAuthorNode } from '../../../../../src/client/components/organisms/conversation/nodes/turn-author-node.js';
import { $createUserTurnNode } from '../../../../../src/client/components/organisms/conversation/nodes/user-turn-node.js';
import {
  AGENT_NAME,
  type AuthorRole,
  READER_NAME,
} from '../../../../../src/client/domain/conversation-authors.js';
import { ConversationEditor } from '../../../../support/editor.js';

/**
 * The footer a turn trails: the time it was last written, under the turn. Each
 * story seeds the turn block with the mark it wears in its gutter and the
 * time-only footer below it, the way the sync builds them.
 */

/** A minute ago, so the footer's time reads the way a fresh turn's does. */
const recently = () => new Date(Date.now() - 60_000).toISOString();

const line = (role: AuthorRole, name: string, at: () => string | undefined) => (
  <ConversationEditor
    seed={() => {
      const block =
        role === 'agent'
          ? $createAgentTurnNode(
              'story-turn',
              'story-prompt',
              'completed',
              'The button used a hard-coded `bg-white`, so it now uses the `primary` token.',
            )
          : $createUserTurnNode(
              'story-turn',
              'story-prompt',
              undefined,
              'Fix the Pay button in dark mode.',
              true,
            );
      block.setAvatar({ role, name });
      $getRoot().append(block, $createTurnAuthorNode(role, name, at()));
    }}
  />
);

export default {
  title: 'Chat/Nodes/Turn author',
};

/** The agent's footer under the last turn of its run, its mark in the gutter. */
export const Agent = {
  render: () => line('agent', AGENT_NAME, recently),
};

/** The reader's footer under a prompt the host accepted. */
export const Reader = {
  render: () => line('user', READER_NAME, recently),
};

/** The reader's footer under the prompt being written: no time yet. */
export const ReaderWriting = {
  render: () => line('user', READER_NAME, () => undefined),
};

/** A turn written days ago. */
export const DaysAgo = {
  render: () =>
    line('agent', AGENT_NAME, () =>
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
    ),
};

/** A long handle: the gutter mark reads its first two parts, the footer its time. */
export const LongName = {
  render: () => (
    <div className="w-64">
      {line('user', 'joao.vitor.scheuermann.with.a.very.long.handle', recently)}
    </div>
  ),
};

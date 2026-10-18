import { $getRoot } from 'lexical';

import { $createTurnAuthorNode } from '../../../../../src/client/components/organisms/conversation/nodes/turn-author-node.js';
import {
  AGENT_NAME,
  type AuthorRole,
  READER_NAME,
} from '../../../../../src/client/domain/conversation-authors.js';
import { ConversationEditor } from '../../../../support/editor.js';

/** A minute ago, so the line's time reads the way a fresh turn's does. */
const recently = () => new Date(Date.now() - 60_000).toISOString();

const line = (role: AuthorRole, name: string, at: () => string | undefined) => (
  <ConversationEditor
    seed={() => $getRoot().append($createTurnAuthorNode(role, name, at()))}
  />
);

export default {
  title: 'Chat/Nodes/Turn author',
};

/** The agent's line under the last turn of its run. */
export const Agent = {
  render: () => line('agent', AGENT_NAME, recently),
};

/** The reader's line under a prompt the host accepted. */
export const Reader = {
  render: () => line('user', READER_NAME, recently),
};

/** The reader's line under the prompt being written: no time yet. */
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

/** A long name, truncated in the line. */
export const LongName = {
  render: () => (
    <div className="w-64">
      {line('user', 'joao.vitor.scheuermann.with.a.very.long.handle', recently)}
    </div>
  ),
};

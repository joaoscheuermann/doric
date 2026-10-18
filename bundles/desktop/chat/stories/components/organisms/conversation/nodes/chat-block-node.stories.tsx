import { $getRoot } from 'lexical';

import {
  $createChatBlockNode,
  type DrawnBlock,
} from '../../../../../src/client/components/organisms/conversation/nodes/chat-block-node.js';
import { GENERIC_BLOCK_TYPE } from '../../../../../src/client/domain/external-blocks.js';
import { GENERIC_BLOCK_TAG } from '../../../../../src/client/services/views.js';
import {
  answer,
  promptIdOf,
  turnsOfLog,
} from '../../../../support/conversation.js';
import {
  $appendTurns,
  $focusNodes,
  ConversationEditor,
} from '../../../../support/editor.js';

const prompt = promptIdOf(3201);

/** A block another bundle's projector made, drawn by `<chat-block>`. */
const deployBlock: DrawnBlock = {
  tag: GENERIC_BLOCK_TAG,
  block: {
    id: 'block-deploy-1',
    type: GENERIC_BLOCK_TYPE,
    promptId: prompt,
    sequence: 3,
    data: {
      eventType: 'deploy.preview/v1',
      createdAt: '2026-10-16T08:44:12.000Z',
      payload: {
        environment: 'staging',
        url: 'https://storefront-pr-212.preview.example.dev',
        commit: '9c1e4b7',
        status: 'ready',
      },
    },
    actions: [],
  },
};

/** A block whose type no renderer claims, with its own data shape. */
const unknownBlock: DrawnBlock = {
  tag: GENERIC_BLOCK_TAG,
  block: {
    id: 'block-lint-1',
    type: 'lint.report',
    promptId: prompt,
    sequence: 4,
    data: { errors: 0, warnings: 3, files: ['src/stores/cart.ts'] },
    actions: [],
  },
};

const blocksOf = (...drawn: readonly DrawnBlock[]) =>
  new Map(drawn.map((block) => [block.block.id, block]));

export default {
  title: 'Chat/Nodes/Chat block',
};

/** The generic block: the event's type, id, time and payload. */
export const GenericEvent = {
  render: () => (
    <ConversationEditor
      blocks={blocksOf(deployBlock)}
      seed={() => $getRoot().append($createChatBlockNode(deployBlock.block.id))}
    />
  ),
};

/** A block type nobody draws, shown with its data. */
export const UnknownType = {
  render: () => (
    <ConversationEditor
      blocks={blocksOf(unknownBlock)}
      seed={() =>
        $getRoot().append($createChatBlockNode(unknownBlock.block.id))
      }
    />
  ),
};

/** Blocks seated among the turns, where their events fall in the log. */
export const AmongTurns = {
  render: () => (
    <ConversationEditor
      blocks={blocksOf(deployBlock, unknownBlock)}
      seed={() => {
        const [user, agent] = $appendTurns(
          turnsOfLog((log) => {
            log.prompt(prompt, 'Deploy the preview to staging.');
            answer(log, prompt, 'The preview is live on staging.');
          }),
        );
        user
          ?.getNextSibling()
          ?.insertAfter($createChatBlockNode(deployBlock.block.id));
        agent?.insertBefore($createChatBlockNode(unknownBlock.block.id));
      }}
    />
  ),
};

/** The block holding the editor's focus. */
export const Focused = {
  render: () => (
    <ConversationEditor
      blocks={blocksOf(deployBlock)}
      seed={() => {
        const node = $createChatBlockNode(deployBlock.block.id);
        $getRoot().append(node);
        $focusNodes(node);
      }}
    />
  ),
};

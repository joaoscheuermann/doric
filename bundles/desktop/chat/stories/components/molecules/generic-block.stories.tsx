import { GenericBlock } from '../../../src/client/components/molecules/generic-block.js';
import { GENERIC_BLOCK_TYPE } from '../../../src/client/domain/external-blocks.js';

const promptId = 'a0000000-0000-4000-8000-000000000101';

export default {
  title: 'Chat/Molecules/Generic block',
  component: GenericBlock,
};

/** An event no projector claims, drawn as what it is. */
export const UnclaimedEvent = {
  render: () => (
    <GenericBlock
      block={{
        id: 'event-42',
        type: GENERIC_BLOCK_TYPE,
        promptId,
        sequence: 42,
        data: {
          eventType: 'deploy.preview-ready/v1',
          createdAt: '2026-10-16T08:42:10.000Z',
          payload: {
            url: 'https://storefront-pr-118.preview.example.com',
            commit: '5b0265d1',
            durationMs: 48_200,
          },
        },
        actions: [],
      }}
    />
  ),
};

/** A block of another type whose renderer is missing: its data as JSON. */
export const UnrenderedBlock = {
  render: () => (
    <GenericBlock
      block={{
        id: 'artifact-checkout-1',
        type: 'artifacts.revision',
        promptId,
        sequence: 17,
        data: { artifactId: 'checkout-1', revision: 3, title: 'Checkout' },
        actions: [{ id: 'open', label: 'Open' }],
      }}
    />
  ),
};

export const LargePayload = {
  render: () => (
    <GenericBlock
      block={{
        id: 'event-77',
        type: GENERIC_BLOCK_TYPE,
        promptId,
        sequence: 77,
        data: {
          eventType: 'lint.report/v1',
          createdAt: '2026-10-16T08:44:00.000Z',
          payload: {
            files: Array.from({ length: 6 }, (_, index) => ({
              path: `src/components/Card${index}.tsx`,
              warnings: index,
              rule: 'a11y/useButtonType',
            })),
          },
        },
        actions: [],
      }}
    />
  ),
};

export const NoBlock = {
  render: () => <GenericBlock />,
};

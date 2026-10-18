import type { ComponentProps } from 'react';

import { EditToolItem } from '../../../src/client/components/molecules/edit-tool-item.js';
import { WithChosen } from '../../support/chosen.js';
import {
  editArgs,
  editResult,
  longEditResult,
  writeArgs,
} from '../../support/fixtures.js';

type Props = Omit<
  ComponentProps<typeof EditToolItem>,
  'chosen' | 'onChosenChange'
>;

function Edit(props: Props) {
  return (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <EditToolItem
          {...props}
          chosen={chosen}
          onChosenChange={onChosenChange}
        />
      )}
    </WithChosen>
  );
}

export default {
  title: 'Chat/Molecules/Edit tool item',
  component: EditToolItem,
};

export const Edited = {
  render: () => <Edit args={editArgs} result={editResult} status="finished" />,
};

export const Editing = {
  render: () => <Edit args={editArgs} status="running" />,
};

export const WritingNewFile = {
  render: () => <Edit args={writeArgs} status="running" />,
};

export const LongDiff = {
  render: () => (
    <Edit
      args={JSON.stringify({ path: 'src/stores/cart.ts', edits: [] })}
      result={longEditResult}
      status="finished"
    />
  ),
};

export const Failed = {
  render: () => (
    <Edit
      args={editArgs}
      error="oldText was not found in src/components/Checkout.tsx"
      status="failed"
    />
  ),
};

export const FailedInOutput = {
  render: () => (
    <Edit
      args={editArgs}
      result={JSON.stringify({
        success: false,
        error: 'The file changed on disk since it was read. Read it again.',
      })}
      status="finished"
    />
  ),
};

export const RawOutput = {
  render: () => (
    <Edit
      args={editArgs}
      result="Edited src/components/Checkout.tsx"
      status="finished"
    />
  ),
};

export const Focused = {
  render: () => (
    <Edit args={editArgs} result={editResult} status="finished" focused />
  ),
};

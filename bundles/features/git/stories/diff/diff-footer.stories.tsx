import { useState } from 'react';

import { DiffFooter } from '../../src/client/diff/diff-footer.js';
import { controls, tabDecorators } from '../support/diff.js';

const path = 'src/components/Checkout.tsx';

function Interactive({ initial }: { readonly initial: string }) {
  const [layout, setLayout] = useState(initial);
  return (
    <DiffFooter
      path={path}
      controls={controls({ layout, onLayout: setLayout })}
    />
  );
}

export default {
  title: 'Git/Diff/Diff footer',
  component: DiffFooter,
  decorators: tabDecorators,
};

export const Unified = {
  render: () => <Interactive initial="unified" />,
};

export const SideBySide = {
  render: () => <Interactive initial="split" />,
};

/** No change to step through: the navigation is disabled. */
export const NothingToNavigate = {
  render: () => (
    <DiffFooter
      path={path}
      controls={controls({ counts: { added: 0, removed: 0 } })}
    />
  ),
};

/** Still comparing: the counts have not arrived. */
export const Comparing = {
  render: () => (
    <DiffFooter path={path} controls={controls({ counts: undefined })} />
  ),
};

/** Binary files, unavailable comparisons and reads in flight show the path only. */
export const PathOnly = {
  render: () => <DiffFooter path="public/images/checkout-hero.png" />,
};

export const LongPath = {
  render: () => (
    <div className="w-96">
      <DiffFooter
        path="packages/design-tokens/src/themes/high-contrast/generated/semantic-color-tokens.dark.json"
        controls={controls()}
      />
    </div>
  ),
};

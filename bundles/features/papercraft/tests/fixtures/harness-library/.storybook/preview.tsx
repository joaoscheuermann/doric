// The fixture's harness: one decorator, and the global sheet the library's
// Tailwind step compiles from (D15).
import type { ReactNode } from 'react';

import '../src/index.css';

export const decorators = [
  (Story: () => ReactNode) => (
    <div data-fixture-harness="wrap">
      <Story />
    </div>
  ),
];

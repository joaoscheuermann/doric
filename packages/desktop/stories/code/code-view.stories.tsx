import { CodeView, fileLanguage } from 'desktop/ui/code';
import type { ReactNode } from 'react';

import { chromeBarSource } from '../support/doric.js';

export default {
  title: 'desktop/ui/Code/Code view',
  component: CodeView,
};

/*
 * The editor fills a flex column (`min-h-0 flex-1`), as it does in a file tab,
 * so the story gives it one with a fixed height.
 */
const Tab = ({
  path,
  children,
}: {
  readonly path: string;
  readonly children: ReactNode;
}) => (
  <div className="flex h-[28rem] flex-col overflow-hidden rounded-lg border">
    <div className="border-b px-3 py-1.5 font-mono text-xs text-muted-foreground">
      {path}
    </div>
    {children}
  </div>
);

const tsPath = 'packages/desktop/src/chrome-bar.tsx';

export const TypeScript = {
  render: () => (
    <Tab path={tsPath}>
      <CodeView language={fileLanguage(tsPath)} value={chromeBarSource} />
    </Tab>
  ),
};

const markdown = `# Agent Instructions

\`GROUNDING.md\` is the repository validity contract. Read it before
non-trivial planning, reviewing, artifact generation, architecture discussion,
code editing, or workflow execution.

## Working Rules

- Inspect the real local files before making architecture claims.
- Keep edits scoped to the request and the relevant ownership boundary.
- Preserve unrelated dirty worktree changes.
`;

export const Markdown = {
  render: () => (
    <Tab path="AGENTS.md">
      <CodeView language={fileLanguage('AGENTS.md')} value={markdown} />
    </Tab>
  ),
};

const shell = `#!/usr/bin/env zsh
set -euo pipefail

npx nx show projects
npx tsc -p packages/desktop/tsconfig.spec.json --noEmit
npm run format:check && npm run lint
`;

export const Shell = {
  render: () => (
    <Tab path="scripts/check.sh">
      <CodeView language={fileLanguage('scripts/check.sh')} value={shell} />
    </Tab>
  ),
};

export const PlainText = {
  render: () => (
    <Tab path="LICENSE">
      <CodeView
        language={fileLanguage('LICENSE')}
        value={'MIT License\n\nCopyright (c) 2026 João Vitor Scheuermann\n'}
      />
    </Tab>
  ),
};

export const Empty = {
  render: () => (
    <Tab path="packages/desktop/src/empty.ts">
      <CodeView language="typescript" value="" />
    </Tab>
  ),
};

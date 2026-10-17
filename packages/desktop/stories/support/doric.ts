// Doric-shaped fixture data the desktop/ui stories share: the Projects,
// Threads and files the app's sidebars, tables and pickers show. Plain data
// only, so every story stays a pure render.

import type { TreeNode } from 'desktop/ui/panels';

export type ProjectFixture = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly branch: string;
};

export type ThreadFixture = {
  readonly id: string;
  readonly title: string;
  readonly updated: string;
  readonly status: 'idle' | 'running' | 'awaiting' | 'failed';
  readonly model: string;
  readonly tokens: number;
};

export const projects: readonly ProjectFixture[] = [
  {
    id: 'doric',
    name: 'doric',
    path: '~/Documents/personal/doric/doric',
    branch: 'feat/app',
  },
  {
    id: 'papermache',
    name: 'papermache',
    path: '~/Code/papermache',
    branch: 'main',
  },
  {
    id: 'website',
    name: 'doric-website',
    path: '~/Code/doric-website',
    branch: 'fix/hero-copy',
  },
  {
    id: 'infra',
    name: 'infra',
    path: '~/Code/infra',
    branch: 'main',
  },
];

export const threads: readonly ThreadFixture[] = [
  {
    id: 'thread-1',
    title: 'Add comment threads to papercraft previews',
    updated: '2 min ago',
    status: 'running',
    model: 'claude-opus-4',
    tokens: 48_210,
  },
  {
    id: 'thread-2',
    title: 'Stop conversation blocks jittering on scroll',
    updated: '1 h ago',
    status: 'awaiting',
    model: 'claude-sonnet-4',
    tokens: 12_904,
  },
  {
    id: 'thread-3',
    title: 'Rebuild only the tail a streamed delta changed',
    updated: 'Yesterday',
    status: 'idle',
    model: 'claude-sonnet-4',
    tokens: 31_377,
  },
  {
    id: 'thread-4',
    title: 'Migrate storage backend to Prisma 7',
    updated: 'Mon',
    status: 'failed',
    model: 'gpt-5',
    tokens: 7_120,
  },
  {
    id: 'thread-5',
    title: 'Write Storybook stories for desktop/ui',
    updated: 'Oct 2',
    status: 'idle',
    model: 'claude-opus-4',
    tokens: 22_045,
  },
];

export const models = [
  { id: 'claude-opus-4', label: 'Claude Opus 4', provider: 'Anthropic' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'claude-haiku-4', label: 'Claude Haiku 4', provider: 'Anthropic' },
  { id: 'gpt-5', label: 'GPT-5', provider: 'OpenAI' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'OpenAI' },
] as const;

const file = (path: string): TreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
});

const directory = (path: string, children: readonly TreeNode[]): TreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'directory',
  children,
});

/** A slice of the Doric repository, as the Files panel lists it. */
export const fileTree: readonly TreeNode[] = [
  directory('bundles', [
    directory('bundles/desktop', [
      directory('bundles/desktop/chat', [
        directory('bundles/desktop/chat/src', [
          file('bundles/desktop/chat/src/index.ts'),
          file('bundles/desktop/chat/src/styles.css'),
        ]),
        file('bundles/desktop/chat/package.json'),
      ]),
      directory('bundles/desktop/layout', []),
    ]),
  ]),
  directory('packages', [
    directory('packages/desktop', [
      directory('packages/desktop/src', [
        directory('packages/desktop/src/components', [
          file('packages/desktop/src/components/button.tsx'),
          file('packages/desktop/src/components/sidebar.tsx'),
          file('packages/desktop/src/components/tabs.tsx'),
        ]),
        file('packages/desktop/src/chrome-bar.tsx'),
        file('packages/desktop/src/index.ts'),
      ]),
      file('packages/desktop/package.json'),
    ]),
  ]),
  file('AGENTS.md'),
  file('GROUNDING.md'),
  file('package.json'),
  file('tsconfig.base.json'),
];

/** A TypeScript file the code view stories open. */
export const chromeBarSource = `import type * as React from 'react';
import { cn } from './lib/utils.js';

export interface ChromeBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Keeps the window's safe area clear at the bar's leading edge. */
  readonly inset?: boolean;
}

/** A window's chrome bar: the draggable strip the title area is made of. */
export function ChromeBar({
  inset = true,
  className,
  ...props
}: ChromeBarProps): React.JSX.Element {
  return (
    <div
      data-slot="chrome-bar"
      className={cn(
        'chrome-bar flex items-center [app-region:drag]',
        inset && 'ps-(--doric-safe-left)',
        className,
      )}
      {...props}
    />
  );
}
`;

/** The same file after an edit, for the diff editor stories. */
export const chromeBarEdited = `import type * as React from 'react';
import { cn } from './lib/utils.js';

export interface ChromeBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Keeps the window's safe area clear at the bar's leading edge. */
  readonly inset?: boolean;
  /** Draws the hairline under the bar. */
  readonly bordered?: boolean;
}

/** A window's chrome bar: the draggable strip the title area is made of. */
export function ChromeBar({
  inset = true,
  bordered = false,
  className,
  ...props
}: ChromeBarProps): React.JSX.Element {
  return (
    <div
      data-slot="chrome-bar"
      className={cn(
        'chrome-bar flex items-center gap-2 [app-region:drag]',
        inset && 'ps-(--doric-safe-left)',
        bordered && 'border-b',
        className,
      )}
      {...props}
    />
  );
}
`;

import type { ReactElementInstance } from 'desktop/ui/react-element';
import { createElement, type ReactNode } from 'react';

import { createGitStore } from '../src/client/changes/store.js';
import { defineGitElements } from '../src/client/elements.js';
import {
  checkoutDiff,
  credentials,
  onBranch,
  project,
} from './support/fixtures.js';
import { footerDecorators } from './support/footer.js';
import {
  bindStore,
  fakeGitApi,
  readyTree,
  windowServices,
} from './support/git-harness.js';

// The bundle's five custom elements, defined under story tags over one store
// whose API answers fixtures, and mounted as the layout and the settings
// window mount them: an element with the window's services set on it.

const api = fakeGitApi({
  git: async () => onBranch,
  fileDiff: async () => ({ status: 'ready', diff: checkoutDiff }),
});
const store = createGitStore(() => api);
const elements = defineGitElements(store);

const services = windowServices({
  tree: readyTree,
  comparing: { repository: '', path: 'src/components/Checkout.tsx' },
  settings: {
    draft: { gitCredentialId: 'cred-git-work' },
    credentials,
  },
});

const tags = {
  changes: 'story-git-changes',
  badge: 'story-git-changes-badge',
  fileDiff: 'story-git-file-diff',
  cwd: 'story-git-workspace-cwd',
  versioning: 'story-git-settings-versioning',
} as const;

/** One element: defined once per window, then given its props and services. */
function Element({
  name,
  props = {},
}: {
  readonly name: keyof typeof tags;
  readonly props?: Readonly<Record<string, unknown>>;
}): ReactNode {
  bindStore(store);
  const tag = tags[name];
  if (customElements.get(tag) === undefined)
    customElements.define(tag, elements[name]);
  return createElement(tag, {
    ref: (node: ReactElementInstance | null) => {
      if (node === null) return;
      Object.assign(node, props);
      node.services = services;
    },
  });
}

export default {
  title: 'Git/Elements/Git elements',
};

export const Changes = {
  render: () => (
    <div className="flex h-[32rem] w-80 flex-col overflow-hidden rounded-md border bg-sidebar text-sidebar-foreground">
      <Element name="changes" />
    </div>
  ),
};

export const Badge = {
  render: () => (
    <div className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
      <span>Changes</span>
      <Element name="badge" />
    </div>
  ),
};

export const FileDiff = {
  render: () => (
    <div className="flex h-[36rem] max-w-5xl flex-col overflow-hidden rounded-md border">
      <Element
        name="fileDiff"
        props={{
          projectId: project.id,
          repository: checkoutDiff.repository,
          path: checkoutDiff.path,
        }}
      />
    </div>
  ),
};

export const WorkspaceCwd = {
  decorators: footerDecorators,
  render: () => <Element name="cwd" />,
};

export const Versioning = {
  render: () => (
    <div className="max-w-2xl">
      <Element name="versioning" />
    </div>
  ),
};

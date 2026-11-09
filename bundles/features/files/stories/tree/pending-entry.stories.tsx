import { FileTree } from 'desktop/ui/panels';
import { SidebarMenu, SidebarScope } from 'desktop/ui/sidebar';

import {
  type EntryKind,
  PendingEntry,
} from '../../src/client/tree/pending-entry.js';
import type { CreateOutcome, LeaseOutcome } from '../../src/contracts/index.js';
import { workspaceTree } from '../support/fixtures.js';

const open = new Set(['apps', 'apps/web', 'apps/web/src', 'docs']);

/**
 * The inline name row of New file and New folder (§4.4 A9, A10) where
 * `FileTree.pending` draws it: the first child of the folder. Type a name and
 * press Enter: `answer` decides what the row shows; Escape or a blur closes
 * nothing here, since the story keeps the row.
 */
function NameRowStory({
  kind,
  directory,
  answer,
}: {
  readonly kind: EntryKind;
  readonly directory: string;
  readonly answer: LeaseOutcome<CreateOutcome>;
}) {
  return (
    <div
      className="flex flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
      style={{ width: 320, height: 420 }}
    >
      <SidebarScope>
        <SidebarMenu role="tree" className="w-full gap-0 px-1 py-1">
          <FileTree
            actions={{ open: () => undefined, toggle: () => undefined }}
            depth={0}
            entries={workspaceTree}
            expanded={open}
            pending={{
              directory,
              row: (
                <PendingEntry
                  kind={kind}
                  create={async () => answer}
                  onCreated={() => undefined}
                  onCancel={() => undefined}
                />
              ),
            }}
          />
        </SidebarMenu>
      </SidebarScope>
    </div>
  );
}

export default {
  title: 'Files/Tree/Name row',
  component: PendingEntry,
};

export const NewFile = {
  render: () => (
    <NameRowStory
      kind="file"
      directory="apps/web/src"
      answer={{
        status: 'ready',
        value: { status: 'refused', reason: 'exists' },
      }}
    />
  ),
};

/** The name row replaces an empty folder's notice. */
export const NewFolderInEmptyFolder = {
  render: () => (
    <NameRowStory
      kind="directory"
      directory="docs"
      answer={{
        status: 'ready',
        value: { status: 'refused', reason: 'invalid-name' },
      }}
    />
  ),
};

export const ProjectStarting = {
  render: () => (
    <NameRowStory
      kind="file"
      directory="apps/web/src"
      answer={{ status: 'pending' }}
    />
  ),
};

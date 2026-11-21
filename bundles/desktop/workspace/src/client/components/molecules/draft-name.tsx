import { indentation, TreeGuides } from 'desktop/ui/panels';
import { cn } from 'desktop/ui/utils';
import { MessageSquareIcon } from 'lucide-react';

import { rowFill, textboxRing } from '../../domain/sidebar.js';
import { EditableName } from './editable-name.js';
import { ProjectAvatar } from './project-avatar.js';

type DraftNameProps = {
  readonly depth?: number;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
};

/**
 * The row of an entity that is being created: its place in the tree (indentation
 * and guides), the mark for what it will be, and its name. A Project wears the
 * same color mark its row will wear — empty until the host marks it on creation —
 * and a Thread wears the message icon its row wears.
 *
 * The name is the same component a rename uses — `EditableName` — opened with an
 * empty value, which is exactly what "this does not exist yet" means to it. The row
 * is what differs: a draft is not a row of the sidebar list yet, but it takes the list
 * rows' unselected fill and textbox ring.
 */
export function DraftName({
  depth,
  label,
  onCancel,
  onSubmit,
}: DraftNameProps) {
  const draft = depth === undefined;

  return (
    <div
      className={cn(
        'relative flex min-h-7 w-full items-center gap-2 pr-8 text-xs',
        rowFill(false),
        textboxRing,
      )}
      style={{
        paddingLeft: depth === undefined ? '0.75rem' : indentation(depth),
      }}
    >
      <TreeGuides depth={depth ?? 0} />
      {draft ? (
        <ProjectAvatar />
      ) : (
        <MessageSquareIcon className="size-4 shrink-0" />
      )}
      <EditableName
        creating
        editing
        label={label}
        onCancel={onCancel}
        onSubmit={onSubmit}
        value=""
      />
    </div>
  );
}

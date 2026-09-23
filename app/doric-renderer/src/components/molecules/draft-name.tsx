import { EditableName } from '@/components/molecules/editable-name';
import { indentation, TreeGuides } from '@/components/molecules/tree-guides';
import { FolderIcon, MessageSquareIcon } from 'lucide-react';

type DraftNameProps = {
  readonly depth?: number;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
};

/**
 * The row of an entity that is being created: its place in the tree (indentation
 * and guides), the icon for what it will be, and its name.
 *
 * The name is the same component a rename uses — `EditableName` — opened with an
 * empty value, which is exactly what "this does not exist yet" means to it. The row
 * is what differs: a draft is not a row of the sidebar list yet, so it wears its own
 * chrome instead of the list's.
 */
export function DraftName({
  depth,
  label,
  onCancel,
  onSubmit,
}: DraftNameProps) {
  const DraftIcon = depth === undefined ? FolderIcon : MessageSquareIcon;

  return (
    <div
      className="relative flex min-h-7 w-full items-center gap-2 pr-3 text-xs [&>svg]:size-3.5!"
      style={{
        paddingLeft: depth === undefined ? '0.75rem' : indentation(depth),
      }}
    >
      <TreeGuides depth={depth ?? 0} />
      <DraftIcon />
      <EditableName
        editing
        label={label}
        onCancel={onCancel}
        onSubmit={onSubmit}
        value=""
      />
    </div>
  );
}

import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from 'lucide-react';
import { type ReactNode, type Ref, useMemo, useRef, useState } from 'react';

import { Badge } from '../components/badge.js';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '../components/context-menu.js';
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSubItem,
} from '../components/sidebar.js';
import { cn } from '../lib/utils.js';
import { indentation, rowInteraction, TreeGuides } from './tree-guides.js';
import {
  flattenTree,
  lineOffsets,
  type TreeLine,
  useLineRange,
} from './tree-window.js';

/** One tree node: a file, or a directory that carries its own children. */
export type TreeNode = {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  /** Present for directories; empty when every child is hidden or ignored. */
  readonly children?: readonly TreeNode[];
};

/**
 * What a decorated row shows beside its name, stated by the bundle that knows
 * what the marks mean. A row with no `tone` shows no change.
 */
export type TreeDecoration = {
  /** The row's accessible label and tooltip suffix. */
  readonly description: string;
  /** The badge a directory row carries: how many changes lie below it. */
  readonly count: number;
  /** Class names of the decorated name and badge (the change's colour). */
  readonly tone?: string;
  /** The letter a changed file's badge carries. */
  readonly letter?: string;
  /** Whether a file's name is struck through (a deleted file). */
  readonly struck?: boolean;
};

/** The sentence an empty directory shows instead of nothing at all. */
export const emptyDirectoryNotice = 'This directory is empty.';

/** The line an open directory shows while its children are being read. */
export const loadingDirectoryNotice = 'Loading…';

export type FileTreeActions = {
  readonly open: (path: string) => void;
  readonly toggle: (path: string) => void;
};

type FileTreeProps = {
  readonly actions: FileTreeActions;
  readonly depth: number;
  readonly entries: readonly TreeNode[];
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath?: string;
  readonly decorations?: ReadonlyMap<string, TreeDecoration>;
  /**
   * The context menu of a row: the content of a `ContextMenu` whose trigger is
   * the row. `null` draws the row with no context menu, as does leaving this
   * out. Called only for the rows that are drawn.
   */
  readonly rowMenu?: (node: TreeNode) => ReactNode | null;
  /**
   * A row drawn as the first child of the open directory whose `path` is
   * `directory`, one step deeper, before its children; in an empty directory
   * it replaces the empty-directory notice. It stays mounted while it is
   * scrolled out of view.
   */
  readonly pending?: {
    readonly directory: string;
    readonly row: ReactNode;
  };
  /**
   * The directories whose children are being read. An open directory in this
   * set draws one muted `loadingDirectoryNotice` line in place of its children
   * (after its pending row, if it has one) and marks its row busy; a closed one
   * draws nothing. Absent or empty, every open directory draws its children.
   */
  readonly loading?: ReadonlySet<string>;
};

/**
 * The rows of a tree, flattened under the open directories and windowed: only
 * the rows that intersect the viewport of the nearest scrolling ancestor (plus
 * a few beyond each edge, the focused row and the pending row) are drawn, with
 * spacers holding the height of the rest. It renders `<li>` items, so it hangs
 * from a `SidebarMenu` (`role="tree"`) or a `SidebarMenuSub` (`role="group"`),
 * starting at `depth`. The whole tree arrives through `entries`, so this reads
 * nothing and asks for nothing: expanding a directory only decides what is
 * drawn.
 *
 * A directory is a row that expands — on click, Enter, Space or ArrowRight —
 * and collapses on ArrowLeft; a file is a row that selects. A directory that is
 * not expanded renders no children at all.
 */
export function FileTree({
  actions,
  depth,
  entries,
  expanded,
  selectedPath,
  decorations,
  rowMenu,
  pending,
  loading,
}: FileTreeProps) {
  const pendingDirectory = pending?.directory;
  const lines = useMemo(
    () => flattenTree(entries, depth, expanded, pendingDirectory, loading),
    [entries, depth, expanded, pendingDirectory, loading],
  );
  const offsets = useMemo(() => lineOffsets(lines), [lines]);
  const marker = useRef<HTMLLIElement>(null);
  const range = useLineRange(marker, offsets);
  // The focused row stays drawn while it is scrolled away, so the keyboard
  // focus is not lost with it.
  const [focused, setFocused] = useState<string>();

  const drawn = new Set<number>();
  for (let index = range.first; index < range.last; index += 1) {
    drawn.add(index);
  }
  lines.forEach((line, index) => {
    if (line.kind === 'pending' || line.key === focused) drawn.add(index);
  });
  const indices = [...drawn].sort((a, b) => a - b);

  const height = (from: number, to: number): string =>
    `${(offsets[to] ?? 0) - (offsets[from] ?? 0)}rem`;
  // The marker only marks where the tree starts, so it holds no height: the
  // gap spacer below holds the lines above the first drawn one. Giving it that
  // height too counted those lines twice and pushed every row down.
  const items: ReactNode[] = [
    <Spacer key={'\0top'} ref={marker} height="0rem" />,
  ];
  let next = 0;
  for (const index of indices) {
    const line = lines[index] as TreeLine;
    if (index > next) {
      items.push(
        <Spacer key={`\0gap:${line.key}`} height={height(next, index)} />,
      );
    }
    next = index + 1;
    items.push(
      line.kind === 'row' ? (
        <TreeRow
          key={line.key}
          line={line}
          actions={actions}
          selectedPath={selectedPath}
          decoration={decorations?.get(line.node.path)}
          rowMenu={rowMenu}
          busy={line.open && loading?.has(line.node.path) === true}
          onFocusChange={setFocused}
        />
      ) : line.kind === 'pending' ? (
        <SidebarMenuSubItem
          key={line.key}
          role="presentation"
          className="w-full min-w-0 shrink-0"
          style={{ paddingLeft: indentation(line.depth) }}
        >
          {pending?.row}
        </SidebarMenuSubItem>
      ) : (
        <SidebarMenuSubItem
          key={line.key}
          role="presentation"
          className="h-6 w-full shrink-0 truncate py-1 text-xs text-muted-foreground"
          style={{ paddingLeft: indentation(line.depth) }}
        >
          {line.kind === 'loading'
            ? loadingDirectoryNotice
            : emptyDirectoryNotice}
        </SidebarMenuSubItem>
      ),
    );
  }
  if (next < lines.length) {
    items.push(<Spacer key={'\0bottom'} height={height(next, lines.length)} />);
  }
  return <>{items}</>;
}

/** The height of the lines that are not drawn. */
function Spacer({
  height,
  ref,
}: {
  readonly height: string;
  readonly ref?: Ref<HTMLLIElement>;
}) {
  return (
    <li
      ref={ref}
      aria-hidden
      role="presentation"
      className="pointer-events-none w-full shrink-0"
      style={{ height }}
    />
  );
}

function TreeRow({
  line,
  actions,
  selectedPath,
  decoration,
  rowMenu,
  busy,
  onFocusChange,
}: {
  readonly line: Extract<TreeLine, { readonly kind: 'row' }>;
  readonly actions: FileTreeActions;
  readonly selectedPath?: string;
  readonly decoration?: TreeDecoration;
  readonly rowMenu?: (node: TreeNode) => ReactNode | null;
  readonly busy: boolean;
  readonly onFocusChange: (
    update: (current: string | undefined) => string | undefined,
  ) => void;
}) {
  const { node: entry, depth, open } = line;
  const directory = entry.type === 'directory';
  const selected = !directory && selectedPath === entry.path;
  const activate = (): void => {
    if (directory) actions.toggle(entry.path);
    else actions.open(entry.path);
  };
  const menu = rowMenu?.(entry) ?? null;
  const button = (
    <SidebarMenuButton
      isActive={selected}
      size="sm"
      className={cn(
        'h-7 w-full min-w-0 gap-1.5 rounded-[4px]',
        decoration === undefined ? 'pr-1.5' : 'pr-8',
        rowInteraction(selected),
      )}
      style={{ paddingLeft: indentation(depth) }}
      render={
        <div
          role="treeitem"
          tabIndex={0}
          aria-level={depth + 1}
          aria-posinset={line.position}
          aria-setsize={line.siblings}
          aria-expanded={directory ? open : undefined}
          aria-selected={selected}
          aria-busy={busy ? true : undefined}
          aria-label={
            decoration === undefined
              ? entry.name
              : `${entry.name}, ${decoration.description}`
          }
          title={
            decoration === undefined
              ? entry.path
              : `${entry.path}\n${decoration.description}`
          }
          onClick={activate}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              activate();
            } else if (event.key === 'ArrowRight' && directory && !open) {
              event.preventDefault();
              actions.toggle(entry.path);
            } else if (event.key === 'ArrowLeft' && open) {
              event.preventDefault();
              actions.toggle(entry.path);
            }
          }}
        />
      }
    >
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5!"
      >
        {!directory ? (
          <FileIcon />
        ) : (
          <>
            {open ? (
              <FolderOpenIcon className="group-hover/tree-row:hidden group-focus-within/tree-row:hidden" />
            ) : (
              <FolderIcon className="group-hover/tree-row:hidden group-focus-within/tree-row:hidden" />
            )}
            <ChevronRightIcon
              className={cn(
                'hidden group-hover/tree-row:block group-focus-within/tree-row:block',
                open && 'rotate-90',
              )}
            />
          </>
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          decoration?.tone !== undefined && decoration.tone,
          'font-normal',
          !directory && decoration?.struck && 'line-through',
        )}
      >
        {entry.name}
      </span>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem
      role="presentation"
      className="w-full min-w-0 shrink-0"
      onFocus={() => onFocusChange(() => line.key)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        onFocusChange((current) =>
          current === line.key ? undefined : current,
        );
      }}
    >
      <div className="group/tree-row relative w-full min-w-0 overflow-hidden">
        <TreeGuides depth={depth} />
        {menu === null ? (
          button
        ) : (
          <ContextMenu>
            <ContextMenuTrigger render={button} />
            <ContextMenuContent>{menu}</ContextMenuContent>
          </ContextMenu>
        )}
        {decoration !== undefined && (
          <SidebarMenuBadge className="z-10 bg-sidebar/90">
            <Badge variant="ghost" className="px-1" aria-hidden>
              <span className={decoration.tone}>
                {directory ? decoration.count : (decoration.letter ?? '')}
              </span>
            </Badge>
          </SidebarMenuBadge>
        )}
      </div>
    </SidebarMenuItem>
  );
}

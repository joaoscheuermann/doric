import { FolderIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/empty.js';

/** A state with nothing to show, said in one sentence. */
export function PanelState({
  description,
  icon,
  title,
}: {
  readonly description: string;
  readonly icon?: ReactNode;
  readonly title: string;
}) {
  return (
    <Empty className="p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <FolderIcon />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

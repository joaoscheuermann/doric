import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'desktop/ui/alert-dialog';

import type { Entity } from '../../domain/workspace.js';

type DeleteDialogProps = {
  readonly entity?: Entity;
  /**
   * U16: how many descendants of the Thread are still in Chat
   * (`descendantsInChat`). Above 0, the description adds "1 child thread is
   * still in Chat and will be deleted too." or "{n} child threads are still
   * in Chat and will be deleted too."; absent or 0 adds nothing.
   */
  readonly inChat?: number;
  readonly pending: boolean;
  readonly onDelete: () => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
};

export function DeleteDialog({
  entity,
  inChat = 0,
  pending,
  onDelete,
  onOpenChange,
}: DeleteDialogProps) {
  const label = entity?.kind === 'project' ? 'project' : 'thread';

  return (
    <AlertDialog open={entity !== undefined} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {entity?.kind === 'project'
              ? 'This permanently deletes the project and all of its threads.'
              : 'This permanently deletes the thread and its child threads.'}
            {inChat === 1 &&
              ' 1 child thread is still in Chat and will be deleted too.'}
            {inChat > 1 &&
              ` ${inChat} child threads are still in Chat and will be deleted too.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() => void onDelete()}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

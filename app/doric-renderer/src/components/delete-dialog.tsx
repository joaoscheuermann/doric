import type { Entity } from '@/app/workspace';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type DeleteDialogProps = {
  readonly entity?: Entity;
  readonly pending: boolean;
  readonly onDelete: () => Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
};

export function DeleteDialog({
  entity,
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
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              void onDelete();
            }}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

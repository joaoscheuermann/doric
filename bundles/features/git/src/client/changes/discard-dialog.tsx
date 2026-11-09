// The Discard confirmation (ui-redesign §4.4 A11, A12, S18): composed from
// `desktop/ui/alert-dialog` as the mcp bundle composes its confirmation. It
// names the target and says the change cannot be undone; a Discard that did
// not complete shows its sentence here and keeps the dialog open until Cancel.

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
import { useRef } from 'react';

/** What a Discard confirmation names: one file, or a whole repository. */
export interface DiscardTarget {
  /** The file's name (A11) or the repository's label (A12). */
  readonly name: string;
  /** The repository root relative to the sandbox root (`''`: the root). */
  readonly repository: string;
  /** The paths to discard, relative to the repository; absent: every change. */
  readonly paths?: readonly string[];
}

export interface DiscardDialogProps {
  readonly target: DiscardTarget | null;
  /** The call is running: the dialog cannot be confirmed or dismissed. */
  readonly pending: boolean;
  /** Why the last Discard did not complete; the dialog stays open. */
  readonly message?: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}

export function DiscardDialog({
  target,
  pending,
  message,
  onConfirm,
  onOpenChange,
}: DiscardDialogProps) {
  // The closing dialog keeps naming its target while it fades out.
  const shown = useRef(target);
  if (target !== null) shown.current = target;
  const named = shown.current;
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {named?.paths === undefined
              ? `Discard all changes in ${named?.name ?? ''}?`
              : `Discard changes to ${named.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {message !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? 'Discarding…' : 'Discard'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

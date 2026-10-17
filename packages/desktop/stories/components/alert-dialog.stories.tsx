import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from 'desktop/ui/alert-dialog';
import { Button } from 'desktop/ui/button';
import { Trash2Icon } from 'lucide-react';
import { useState } from 'react';

export default {
  title: 'desktop/ui/Alert dialog',
  component: AlertDialog,
};

/*
 * The action is a plain button: confirming closes the dialog through its open
 * state, as the action that deletes or discards would.
 */
const DeleteThread = ({
  open: initial,
  size,
}: {
  readonly open: boolean;
  readonly size?: 'default' | 'sm';
}) => {
  const [open, setOpen] = useState(initial);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="destructive" />}>
        Delete thread
      </AlertDialogTrigger>
      <AlertDialogContent size={size}>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete this Thread?</AlertDialogTitle>
          <AlertDialogDescription>
            “Add comment threads to papercraft previews” and its 48 messages
            will be removed. Artifacts it published stay in the Project.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => setOpen(false)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export const Open = {
  render: () => <DeleteThread open />,
};

export const Small = {
  render: () => <DeleteThread open size="sm" />,
};

const DiscardChanges = () => {
  const [open, setOpen] = useState(true);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard uncommitted changes?</AlertDialogTitle>
          <AlertDialogDescription>
            3 files on feat/app go back to the last commit. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep changes</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => setOpen(false)}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export const WithoutMedia = {
  render: () => <DiscardChanges />,
};

export const Closed = {
  render: () => <DeleteThread open={false} />,
};

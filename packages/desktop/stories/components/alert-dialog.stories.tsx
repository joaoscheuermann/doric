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

export default {
  title: 'desktop/ui/Alert dialog',
  component: AlertDialog,
};

const DeleteThread = ({
  open,
  size,
}: {
  readonly open: boolean;
  readonly size?: 'default' | 'sm';
}) => (
  <AlertDialog defaultOpen={open}>
    <AlertDialogTrigger asChild>
      <Button variant="destructive">Delete thread</Button>
    </AlertDialogTrigger>
    <AlertDialogContent size={size}>
      <AlertDialogHeader>
        <AlertDialogMedia>
          <Trash2Icon />
        </AlertDialogMedia>
        <AlertDialogTitle>Delete this Thread?</AlertDialogTitle>
        <AlertDialogDescription>
          “Add comment threads to papercraft previews” and its 48 messages will
          be removed. Artifacts it published stay in the Project.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

export const Open = {
  render: () => <DeleteThread open />,
};

export const Small = {
  render: () => <DeleteThread open size="sm" />,
};

export const WithoutMedia = {
  render: () => (
    <AlertDialog defaultOpen>
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
          <AlertDialogAction variant="destructive">Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
};

export const Closed = {
  render: () => <DeleteThread open={false} />,
};

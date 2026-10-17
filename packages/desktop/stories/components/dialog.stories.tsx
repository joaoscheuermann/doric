import { Button } from 'desktop/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from 'desktop/ui/dialog';
import { Field, FieldGroup, FieldLabel } from 'desktop/ui/field';
import { Input } from 'desktop/ui/input';

export default {
  title: 'desktop/ui/Dialog',
  component: Dialog,
};

const RenameThread = ({ open }: { readonly open: boolean }) => (
  <Dialog defaultOpen={open}>
    <DialogTrigger render={<Button variant="outline" />}>
      Rename thread
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Rename thread</DialogTitle>
        <DialogDescription>
          The new title shows in the sidebar and the window title.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="thread-title">Title</FieldLabel>
          <Input
            id="thread-title"
            defaultValue="Add comment threads to papercraft previews"
          />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button>Save</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const Open = {
  render: () => <RenameThread open />,
};

export const FooterCloseButton = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            ⌘N new thread · ⌘B toggle sidebar · ⌘K command palette
          </DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  ),
};

export const LongContent = {
  render: () => (
    <Dialog defaultOpen>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Release notes</DialogTitle>
          <DialogDescription>
            What changed in Doric this week.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          {Array.from(
            { length: 16 },
            (_, index) => `revision-${index + 1}`,
          ).map((revision, index) => (
            <li key={revision}>
              Papercraft previews now keep comment threads across revision{' '}
              {index + 1}, re-placing each pin through its anchor.
            </li>
          ))}
        </ul>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  ),
};

export const Closed = {
  render: () => <RenameThread open={false} />,
};

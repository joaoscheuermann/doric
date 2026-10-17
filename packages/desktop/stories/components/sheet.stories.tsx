import { Button } from 'desktop/ui/button';
import { Field, FieldGroup, FieldLabel } from 'desktop/ui/field';
import { Input } from 'desktop/ui/input';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from 'desktop/ui/sheet';

export default {
  title: 'desktop/ui/Sheet',
  component: Sheet,
};

const ProjectSettings = ({
  side,
  open = true,
}: {
  readonly side: 'top' | 'right' | 'bottom' | 'left';
  readonly open?: boolean;
}) => (
  <Sheet defaultOpen={open}>
    <SheetTrigger render={<Button variant="outline" />}>
      Project settings
    </SheetTrigger>
    <SheetContent side={side}>
      <SheetHeader>
        <SheetTitle>doric</SheetTitle>
        <SheetDescription>~/Documents/personal/doric/doric</SheetDescription>
      </SheetHeader>
      <FieldGroup className="px-4">
        <Field>
          <FieldLabel htmlFor="sheet-name">Name</FieldLabel>
          <Input id="sheet-name" defaultValue="doric" />
        </Field>
        <Field>
          <FieldLabel htmlFor="sheet-branch">Default branch</FieldLabel>
          <Input id="sheet-branch" defaultValue="main" />
        </Field>
      </FieldGroup>
      <SheetFooter>
        <Button>Save</Button>
        <SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

export const Right = {
  render: () => <ProjectSettings side="right" />,
};

export const Left = {
  render: () => <ProjectSettings side="left" />,
};

export const Top = {
  render: () => <ProjectSettings side="top" />,
};

export const Bottom = {
  render: () => <ProjectSettings side="bottom" />,
};

export const Closed = {
  render: () => <ProjectSettings side="right" open={false} />,
};

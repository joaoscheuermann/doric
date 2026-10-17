import { Separator } from 'desktop/ui/separator';

export default {
  title: 'desktop/ui/Separator',
  component: Separator,
};

export const Horizontal = {
  render: () => (
    <div className="max-w-sm text-sm">
      <div className="font-medium">doric</div>
      <div className="text-muted-foreground">feat/app · 3 changes</div>
      <Separator className="my-3" />
      <div className="text-muted-foreground">5 Threads</div>
    </div>
  ),
};

export const Vertical = {
  render: () => (
    <div className="flex h-5 items-center gap-3 text-sm">
      <span>Files</span>
      <Separator orientation="vertical" />
      <span>Changes</span>
      <Separator orientation="vertical" />
      <span>Terminal</span>
    </div>
  ),
};

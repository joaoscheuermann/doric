import { Button } from 'desktop/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from 'desktop/ui/empty';
import { FolderOpenIcon, MessageSquarePlusIcon, PlusIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Empty',
  component: Empty,
};

export const Default = {
  render: () => (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquarePlusIcon />
        </EmptyMedia>
        <EmptyTitle>No Threads yet</EmptyTitle>
        <EmptyDescription>
          Start a Thread to ask Doric about this Project.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          New thread
        </Button>
      </EmptyContent>
    </Empty>
  ),
};

export const WithoutIcon = {
  render: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Binary file changed</EmptyTitle>
        <EmptyDescription>
          A text comparison is not available for this file.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
};

export const WithLink = {
  render: () => (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpenIcon />
        </EmptyMedia>
        <EmptyTitle>No Project open</EmptyTitle>
        <EmptyDescription>
          Open a folder to start, or read <a href="#docs">how Projects work</a>.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button size="sm">Open folder</Button>
          <Button size="sm" variant="outline">
            Clone repository
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  ),
};

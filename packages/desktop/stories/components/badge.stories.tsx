import { Badge } from 'desktop/ui/badge';
import { CheckIcon, GitBranchIcon, LoaderIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Badge',
  component: Badge,
};

export const Default = {
  render: () => <Badge>Running</Badge>,
};

export const Variants = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="default">Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Failed</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="ghost">Ghost</Badge>
      <Badge variant="link">Link</Badge>
    </div>
  ),
};

export const WithIcons = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">
        <GitBranchIcon data-icon="inline-start" />
        feat/app
      </Badge>
      <Badge variant="secondary">
        <LoaderIcon data-icon="inline-start" className="animate-spin" />
        Streaming
      </Badge>
      <Badge>
        Done
        <CheckIcon data-icon="inline-end" />
      </Badge>
    </div>
  ),
};

export const Counts = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">3</Badge>
      <Badge variant="destructive">12</Badge>
      <Badge variant="outline">99+</Badge>
    </div>
  ),
};

export const AsLink = {
  render: () => (
    <Badge variant="outline" render={<a href="#thread-1" />}>
      #thread-1
    </Badge>
  ),
};

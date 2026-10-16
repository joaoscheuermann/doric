import { Skeleton } from 'desktop/ui/skeleton';

export default {
  title: 'desktop/ui/Skeleton',
  component: Skeleton,
};

export const Default = {
  render: () => <Skeleton className="h-4 w-48" />,
};

export const ThreadRow = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3">
      {['w-40', 'w-56', 'w-32', 'w-48'].map((width) => (
        <div key={width} className="flex items-center gap-2">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className={`h-3 ${width}`} />
        </div>
      ))}
    </div>
  ),
};

export const Message = {
  render: () => (
    <div className="flex max-w-lg flex-col gap-2">
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-2 h-24 w-full rounded-lg" />
    </div>
  ),
};

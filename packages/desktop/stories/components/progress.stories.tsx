import { Progress } from 'desktop/ui/progress';

export default {
  title: 'desktop/ui/Progress',
  component: Progress,
};

export const Default = {
  render: () => <Progress className="max-w-sm" value={62} />,
};

export const Values = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-4 text-xs text-muted-foreground">
      {[0, 25, 62, 100].map((value) => (
        <div key={value} className="flex flex-col gap-1.5">
          <span>Context window · {value}%</span>
          <Progress value={value} />
        </div>
      ))}
    </div>
  ),
};

export const Indeterminate = {
  render: () => <Progress className="max-w-sm" value={null} />,
};

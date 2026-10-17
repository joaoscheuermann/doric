import { Input } from 'desktop/ui/input';

export default {
  title: 'desktop/ui/Input',
  component: Input,
};

export const Default = {
  render: () => <Input className="max-w-xs" placeholder="Search threads" />,
};

export const States = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3">
      <Input placeholder="Empty" />
      <Input defaultValue="feat/papercraft" />
      <Input disabled defaultValue="~/Documents/personal/doric/doric" />
      <Input aria-invalid defaultValue="not a url" />
      <Input type="password" defaultValue="sk-ant-api03-secret" />
      <Input type="file" />
    </div>
  ),
};

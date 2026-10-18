import { Checkbox } from 'desktop/ui/checkbox';
import { Input } from 'desktop/ui/input';
import { Label } from 'desktop/ui/label';

export default {
  title: 'desktop/ui/Label',
  component: Label,
};

export const Default = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-2">
      <Label htmlFor="project-name">Project name</Label>
      <Input id="project-name" defaultValue="doric" />
    </div>
  ),
};

export const WithCheckbox = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="telemetry" defaultChecked />
      <Label htmlFor="telemetry">Share anonymous usage</Label>
    </div>
  ),
};

export const Disabled = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="locked" disabled />
      <Label htmlFor="locked">Managed by your organisation</Label>
    </div>
  ),
};

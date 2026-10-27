import { Label } from 'desktop/ui/label';
import { Switch } from 'desktop/ui/switch';

export default {
  title: 'desktop/ui/Switch',
  component: Switch,
};

export const Default = {
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="server-enabled" defaultChecked />
      <Label htmlFor="server-enabled">Enabled</Label>
    </div>
  ),
};

export const States = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Switch id="unchecked" />
        <Label htmlFor="unchecked">Unchecked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="checked" defaultChecked />
        <Label htmlFor="checked">Checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="small" size="sm" defaultChecked />
        <Label htmlFor="small">Small</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="disabled" disabled />
        <Label htmlFor="disabled">Disabled</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="disabled-checked" disabled defaultChecked />
        <Label htmlFor="disabled-checked">Disabled and checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="invalid" aria-invalid />
        <Label htmlFor="invalid">Invalid</Label>
      </div>
    </div>
  ),
};

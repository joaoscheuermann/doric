import { Checkbox } from 'desktop/ui/checkbox';
import { Label } from 'desktop/ui/label';

export default {
  title: 'desktop/ui/Checkbox',
  component: Checkbox,
};

export const Default = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="auto-approve" />
      <Label htmlFor="auto-approve">Auto-approve read-only tools</Label>
    </div>
  ),
};

export const States = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Checkbox id="unchecked" />
        <Label htmlFor="unchecked">Unchecked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="checked" defaultChecked />
        <Label htmlFor="checked">Checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="indeterminate" indeterminate />
        <Label htmlFor="indeterminate">Indeterminate</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="disabled" disabled />
        <Label htmlFor="disabled">Disabled</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="disabled-checked" disabled defaultChecked />
        <Label htmlFor="disabled-checked">Disabled and checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="invalid" aria-invalid />
        <Label htmlFor="invalid">Invalid</Label>
      </div>
    </div>
  ),
};

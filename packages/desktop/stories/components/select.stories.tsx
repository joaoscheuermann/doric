import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from 'desktop/ui/select';

import { models } from '../support/doric.js';

export default {
  title: 'desktop/ui/Select',
  component: Select,
};

/** The labels the trigger shows for each model id. */
const modelItems = models.map((model) => ({
  value: model.id,
  label: model.label,
}));

const effortItems = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const ModelItems = () => (
  <>
    <SelectGroup>
      <SelectLabel>Anthropic</SelectLabel>
      {models
        .filter((model) => model.provider === 'Anthropic')
        .map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
    </SelectGroup>
    <SelectSeparator />
    <SelectGroup>
      <SelectLabel>OpenAI</SelectLabel>
      {models
        .filter((model) => model.provider === 'OpenAI')
        .map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
    </SelectGroup>
  </>
);

export const Open = {
  render: () => (
    <div className="h-80 pt-24">
      <Select items={modelItems} defaultOpen defaultValue="claude-sonnet-4">
        <SelectTrigger className="w-56" aria-label="Model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <ModelItems />
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Popper = {
  render: () => (
    <div className="h-80">
      <Select items={modelItems} defaultOpen defaultValue="gpt-5">
        <SelectTrigger className="w-56" aria-label="Model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <ModelItems />
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Select items={modelItems} defaultValue="claude-opus-4">
        <SelectTrigger className="w-56" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <ModelItems />
        </SelectContent>
      </Select>
      <Select items={effortItems}>
        <SelectTrigger size="sm" className="w-56" aria-label="Reasoning effort">
          <SelectValue placeholder="Reasoning effort" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="low">Low</SelectItem>
          <SelectItem value="medium">Medium</SelectItem>
          <SelectItem value="high">High</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Disabled = {
  render: () => (
    <Select items={modelItems} disabled defaultValue="claude-opus-4">
      <SelectTrigger className="w-56" aria-label="Model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <ModelItems />
      </SelectContent>
    </Select>
  ),
};

export const Invalid = {
  render: () => (
    <Select items={modelItems}>
      <SelectTrigger className="w-56" aria-invalid aria-label="Model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        <ModelItems />
      </SelectContent>
    </Select>
  ),
};

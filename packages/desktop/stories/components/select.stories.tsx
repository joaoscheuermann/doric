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
      <Select defaultOpen defaultValue="claude-sonnet-4">
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
      <Select defaultOpen defaultValue="gpt-5">
        <SelectTrigger className="w-56" aria-label="Model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent position="popper">
          <ModelItems />
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Select defaultValue="claude-opus-4">
        <SelectTrigger className="w-56" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <ModelItems />
        </SelectContent>
      </Select>
      <Select>
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
    <Select disabled defaultValue="claude-opus-4">
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
    <Select>
      <SelectTrigger className="w-56" aria-invalid aria-label="Model">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        <ModelItems />
      </SelectContent>
    </Select>
  ),
};

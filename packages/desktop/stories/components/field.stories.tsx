import { Button } from 'desktop/ui/button';
import { Checkbox } from 'desktop/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from 'desktop/ui/field';
import { Input } from 'desktop/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'desktop/ui/select';
import { Textarea } from 'desktop/ui/textarea';

import { models } from '../support/doric.js';

export default {
  title: 'desktop/ui/Field',
  component: Field,
};

export const ProviderForm = {
  render: () => (
    <form className="max-w-md">
      <FieldSet>
        <FieldLegend>Anthropic</FieldLegend>
        <FieldDescription>
          Doric sends requests to this provider with the key below.
        </FieldDescription>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="provider-name">Name</FieldLabel>
            <Input id="provider-name" defaultValue="Anthropic (work)" />
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-key">API key</FieldLabel>
            <Input
              id="provider-key"
              type="password"
              defaultValue="sk-ant-api03-secret"
            />
            <FieldDescription>
              Stored in the system keychain, never in the Project.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-model">Default model</FieldLabel>
            <Select defaultValue="claude-sonnet-4">
              <SelectTrigger id="provider-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <Button type="button">Save</Button>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </Field>
        </FieldGroup>
      </FieldSet>
    </form>
  ),
};

export const Invalid = {
  render: () => (
    <FieldGroup className="max-w-md">
      <Field data-invalid="true">
        <FieldLabel htmlFor="base-url">Base URL</FieldLabel>
        <Input id="base-url" aria-invalid defaultValue="localhost:11434" />
        <FieldError
          errors={[
            { message: 'Enter a URL starting with http:// or https://.' },
          ]}
        />
      </Field>
      <Field data-invalid="true">
        <FieldLabel htmlFor="system-prompt">System prompt</FieldLabel>
        <Textarea id="system-prompt" aria-invalid defaultValue="" />
        <FieldError
          errors={[
            { message: 'A system prompt is required.' },
            { message: 'Use at most 8,000 characters.' },
          ]}
        />
      </Field>
    </FieldGroup>
  ),
};

export const Horizontal = {
  render: () => (
    <FieldGroup className="max-w-md">
      <Field orientation="horizontal">
        <Checkbox id="approve-reads" defaultChecked />
        <FieldContent>
          <FieldLabel htmlFor="approve-reads">Auto-approve reads</FieldLabel>
          <FieldDescription>
            Tools that only read files run without asking.
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="approve-shell" />
        <FieldContent>
          <FieldLabel htmlFor="approve-shell">Auto-approve shell</FieldLabel>
          <FieldDescription>
            Commands still run inside the Project's sandbox.
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal" data-disabled="true">
        <Checkbox id="approve-network" disabled />
        <FieldContent>
          <FieldLabel htmlFor="approve-network">Allow network</FieldLabel>
          <FieldDescription>Managed by your organisation.</FieldDescription>
        </FieldContent>
      </Field>
    </FieldGroup>
  ),
};

export const ChoiceCards = {
  render: () => (
    <FieldSet className="max-w-md">
      <FieldLegend variant="label">Sandbox</FieldLegend>
      <FieldGroup>
        <FieldLabel htmlFor="sandbox-container">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Container</FieldTitle>
              <FieldDescription>
                Isolated, starts in a few seconds.
              </FieldDescription>
            </FieldContent>
            <Checkbox id="sandbox-container" defaultChecked />
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="sandbox-host">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Host</FieldTitle>
              <FieldDescription>
                Runs directly on this machine.
              </FieldDescription>
            </FieldContent>
            <Checkbox id="sandbox-host" />
          </Field>
        </FieldLabel>
      </FieldGroup>
    </FieldSet>
  ),
};

export const WithSeparator = {
  render: () => (
    <FieldGroup className="max-w-sm">
      <Field>
        <Button variant="outline">Sign in with Anthropic</Button>
      </Field>
      <FieldSeparator>or use an API key</FieldSeparator>
      <Field>
        <FieldLabel htmlFor="separator-key">API key</FieldLabel>
        <Input id="separator-key" placeholder="sk-ant-…" />
      </Field>
    </FieldGroup>
  ),
};

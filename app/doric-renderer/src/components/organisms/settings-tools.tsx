import { ChoicePicker } from '@/components/molecules/choice-picker';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Configuration, ToolConfigField } from '@/domain/config';
import { useToolCatalog } from '@/hooks/use-tool-catalog';

type SettingsToolsProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

/** The value one field shows: what the draft holds, else the field's default. */
const fieldValue = (
  draft: Configuration,
  tool: string,
  field: ToolConfigField,
): string => draft.tools?.[tool]?.[field.key] ?? field.default ?? '';

/**
 * The configuration with one tool's field set. Every value is a string on the
 * wire, so a `number` field still carries the text the operator typed and the
 * host parses it.
 */
const withToolValue = (
  draft: Configuration,
  tool: string,
  key: string,
  value: string,
): Configuration => {
  const tools = draft.tools ?? {};
  const current = tools[tool] ?? {};

  return {
    ...draft,
    tools: { ...tools, [tool]: { ...current, [key]: value } },
  };
};

/**
 * Every tool the loaded bundles expose, each drawn as its own section from the
 * fields the tool itself declares. The catalog is the host's, so this screen
 * renders the tools it is answered with — a tool that declares no fields has no
 * section, and a tool that declares them describes exactly how each is drawn.
 */
export function SettingsTools({ draft, onChange }: SettingsToolsProps) {
  const catalog = useToolCatalog();
  const tools = catalog.list.filter((tool) => tool.settings.length > 0);

  if (catalog.error !== undefined) {
    return (
      <p className="text-destructive text-sm">{catalog.error}</p>
    );
  }

  if (catalog.loading && catalog.list.length === 0) {
    return <p className="text-muted-foreground text-sm">Loading tools…</p>;
  }

  if (tools.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No tool declares configuration yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {tools.map((tool) => (
        <FieldGroup key={tool.name}>
          <FieldLabel>{tool.name}</FieldLabel>
          {tool.description !== undefined && (
            <FieldDescription>{tool.description}</FieldDescription>
          )}
          {tool.settings.map((field) =>
            field.kind === 'enum' ? (
              <Field key={field.key}>
                <FieldLabel>{field.label}</FieldLabel>
                <ChoicePicker
                  ariaLabel={`${tool.name} ${field.label}`}
                  choices={(field.options ?? []).map((value) => ({
                    label: value,
                    value,
                  }))}
                  value={fieldValue(draft, tool.name, field)}
                  onSelect={(next) =>
                    onChange(withToolValue(draft, tool.name, field.key, next))
                  }
                />
                {field.description !== undefined && (
                  <FieldDescription>{field.description}</FieldDescription>
                )}
              </Field>
            ) : (
              <Field key={field.key}>
                <FieldLabel htmlFor={`tool-${tool.name}-${field.key}`}>
                  {field.label}
                </FieldLabel>
                <Input
                  id={`tool-${tool.name}-${field.key}`}
                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                  placeholder={field.placeholder}
                  value={fieldValue(draft, tool.name, field)}
                  onChange={(event) =>
                    onChange(
                      withToolValue(draft, tool.name, field.key, event.target.value),
                    )
                  }
                />
                {field.description !== undefined && (
                  <FieldDescription>{field.description}</FieldDescription>
                )}
              </Field>
            ),
          )}
        </FieldGroup>
      ))}
    </div>
  );
}

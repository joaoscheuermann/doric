import type { BoundTool, ToolConfig } from 'tool';

import type { ConfigInput } from './schema.js';

/**
 * The values one tool reads: its declared fields, each taken from the persisted
 * configuration or else from the field's own default, and a required field with
 * neither failing the resolution. Keys that no declared field names are dropped,
 * so a field a newer bundle removed never reaches a tool.
 */
export const resolveToolConfig = (
  factory: BoundTool,
  values: Readonly<Record<string, string>> | undefined,
): ToolConfig => {
  const resolved: Record<string, string> = {};

  for (const field of factory.settings) {
    const value = values?.[field.key] ?? field.default;

    if (value === undefined || value.trim() === '') {
      if (field.required)
        throw new Error(`Tool ${factory.name} requires a ${field.key} value.`);
      continue;
    }

    resolved[field.key] = value;
  }

  return resolved;
};

/**
 * Every tool's configuration, keyed by tool name, resolved at the moment a
 * prompt runs. A tool with no declared settings resolves to an empty object.
 */
export const resolveToolConfigs = (
  tools: readonly BoundTool[],
  configuration: ConfigInput,
): ReadonlyMap<string, ToolConfig> =>
  new Map(
    tools.map((factory) => [
      factory.name,
      resolveToolConfig(factory, configuration.tools?.[factory.name]),
    ]),
  );

/**
 * Phase one of tool-config validation: before a configuration is stored, every
 * bundled tool's declared fields must be satisfiable. Phase two — applying the
 * defaults and dropping unknown keys — happens when a tool is bound to a prompt.
 */
export const requireToolConfigs = (
  configuration: ConfigInput,
  tools: readonly BoundTool[],
): void => {
  for (const factory of tools)
    resolveToolConfig(factory, configuration.tools?.[factory.name]);
};

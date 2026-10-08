import type { Bundle } from 'bundle';
import type { ToolConfig, ToolFactory } from 'tool';

import type { ConfigInput } from './schema.js';

/**
 * The values one tool reads: its declared fields, each taken from the persisted
 * configuration or else from the field's own default, and a required field with
 * neither failing the resolution. Keys that no declared field names are dropped,
 * so a field a newer bundle removed never reaches a tool.
 */
export const resolveToolConfig = (
  factory: ToolFactory,
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

/** The catalog's tool factories, flattened out of the loaded bundles. */
const catalogTools = (bundles: readonly Bundle[]): readonly ToolFactory[] =>
  bundles.flatMap(({ tools }) => tools.map(({ factory }) => factory));

/**
 * Every tool's configuration, keyed by tool name, ready to bind at the moment a
 * prompt runs. A tool with no declared settings resolves to an empty object.
 */
export const resolveToolConfigs = (
  tools: readonly ToolFactory[],
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
  bundles: readonly Bundle[],
): void => {
  for (const factory of catalogTools(bundles))
    resolveToolConfig(factory, configuration.tools?.[factory.name]);
};

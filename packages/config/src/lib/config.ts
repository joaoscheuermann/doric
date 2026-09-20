import { ConfigParseError } from './classes/parse-error.js';
import type {
  AgentConfig,
  GithubConfig,
  ModelConfig,
  ProviderConfig,
  ReasoningEffort,
  TaskConfig,
} from './types/config.js';
import type { ConfigParseErrorCode } from './types/error.js';
import { at, isRecord } from './utils/object.js';

export { ConfigParseError } from './classes/parse-error.js';

export type {
  AgentConfig,
  GithubConfig,
  ModelConfig,
  ProviderConfig,
  ReasoningEffort,
  TaskConfig,
} from './types/config.js';

export type { ConfigParseErrorCode, ConfigParseIssue } from './types/error.js';

const MESSAGE_METADATA_PATH = 'message.metadata';
const MESSAGE_CONFIGURATION_PATH = 'message.metadata.configuration';

/** Parses the required config from an initial agent message's metadata. */
export function parseInitialMessageConfig(message: unknown): AgentConfig {
  const metadata = messageMetadata(message);
  const configuration = metadata['configuration'];

  if (configuration === undefined) {
    throw invalid(
      'missing_configuration',
      MESSAGE_CONFIGURATION_PATH,
      'Initial message metadata must include configuration',
    );
  }

  return parseConfig(configuration, MESSAGE_CONFIGURATION_PATH);
}

/** Parses a later message config update when metadata includes configuration. */
export function parseMessageConfigUpdate(
  message: unknown,
): AgentConfig | undefined {
  const metadata = optionalMessageMetadata(message);

  if (metadata === undefined || metadata['configuration'] === undefined) {
    return undefined;
  }

  return parseConfig(metadata['configuration'], MESSAGE_CONFIGURATION_PATH);
}

/** Parses an agent config payload and validates every supported config field. */
export function parseConfig(value: unknown, path = 'config'): AgentConfig {
  const input = object(value, path);

  return {
    github: parseGithub(input['github'], at(path, 'github')),
    providers: array(input['providers'], at(path, 'providers')).map(
      (provider, index) =>
        parseProvider(provider, at(at(path, 'providers'), index)),
    ),
    models: array(input['models'], at(path, 'models')).map((model, index) =>
      parseModel(model, at(at(path, 'models'), index)),
    ),
    tasks: array(input['tasks'], at(path, 'tasks')).map((task, index) =>
      parseTask(task, at(at(path, 'tasks'), index)),
    ),
  };
}

function parseGithub(value: unknown, path: string): GithubConfig {
  const input = object(value, path);
  const repo = object(input['repo'], at(path, 'repo'));
  const branch = optionalString(repo['branch'], at(at(path, 'repo'), 'branch'));

  return {
    repo: {
      url: string(repo['url'], at(at(path, 'repo'), 'url')),
      ...(branch === undefined ? {} : { branch }),
    },
    token: string(input['token'], at(path, 'token')),
  };
}

function parseProvider(value: unknown, path: string): ProviderConfig {
  const input = object(value, path);
  const token = optionalString(input['token'], at(path, 'token'));
  const baseUrl = optionalString(input['baseUrl'], at(path, 'baseUrl'));

  return {
    id: string(input['id'], at(path, 'id')),
    type: string(input['type'], at(path, 'type')),
    ...(token === undefined ? {} : { token }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

function parseModel(value: unknown, path: string): ModelConfig {
  const input = object(value, path);
  const effort = optionalReasoningEffort(input['effort'], at(path, 'effort'));

  const reasoning = optionalReasoningEffort(
    input['reasoning'],
    at(path, 'reasoning'),
  );

  const internalKey = optionalString(
    input['internal_key'],
    at(path, 'internal_key'),
  );

  if (effort !== undefined && reasoning !== undefined && effort !== reasoning) {
    throw invalid(
      'invalid_config_field',
      at(path, 'effort'),
      'Model effort must match legacy reasoning when both are provided',
    );
  }

  return {
    id: string(input['id'], at(path, 'id')),
    provider: string(input['provider'], at(path, 'provider')),
    model: string(input['model'], at(path, 'model')),
    ...(effort === undefined ? {} : { effort }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(internalKey === undefined ? {} : { internal_key: internalKey }),
  };
}

function parseTask(value: unknown, path: string): TaskConfig {
  const input = object(value, path);

  return {
    id: string(input['id'], at(path, 'id')),
    model: string(input['model'], at(path, 'model')),
  };
}

function messageMetadata(message: unknown): Record<string, unknown> {
  const metadata = optionalMessageMetadata(message);

  if (metadata === undefined) {
    throw invalid(
      'missing_configuration',
      MESSAGE_CONFIGURATION_PATH,
      'Initial message metadata must include configuration',
    );
  }

  return metadata;
}

function optionalMessageMetadata(
  message: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    throw invalid('invalid_message', 'message', 'Message must be an object');
  }

  if (message['metadata'] === undefined) {
    return undefined;
  }

  return object(message['metadata'], MESSAGE_METADATA_PATH);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalid('invalid_config_field', path, 'Expected an object');
  }

  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid('invalid_config_field', path, 'Expected an array');
  }

  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw invalid('invalid_config_field', path, 'Expected a string');
  }

  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return string(value, path);
}

function optionalReasoningEffort(
  value: unknown,
  path: string,
): ReasoningEffort | undefined {
  const effort = optionalString(value, path);

  if (effort === undefined) {
    return undefined;
  }

  if (
    effort === 'none' ||
    effort === 'minimal' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh'
  ) {
    return effort;
  }

  throw invalid(
    'invalid_config_field',
    path,
    'Expected reasoning effort none, minimal, low, medium, high, or xhigh',
  );
}

function invalid(
  code: ConfigParseErrorCode,
  path: string,
  message: string,
): ConfigParseError {
  return new ConfigParseError(code, path, message);
}

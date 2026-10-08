export type ConfigParseErrorCode =
  | 'invalid_message'
  | 'missing_configuration'
  | 'invalid_config_field';

export interface ConfigParseIssue {
  readonly code: ConfigParseErrorCode;
  readonly path: string;
  readonly message: string;
}

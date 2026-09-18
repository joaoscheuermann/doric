export type OkfErrorCode =
  | 'OKF_ROOT_INVALID'
  | 'OKF_OUTPUT_INVALID'
  | 'OKF_OUTPUT_PREPARE_FAILED'
  | 'OKF_PROMPT_LOAD_FAILED'
  | 'OKF_DISCOVERY_FAILED'
  | 'OKF_SOURCE_PARSE_FAILED'
  | 'OKF_SOURCE_SYNTAX_INVALID'
  | 'OKF_CACHE_READ_FAILED'
  | 'OKF_SUMMARY_FAILED'
  | 'OKF_DESCRIPTION_FAILED'
  | 'OKF_TAGS_FAILED'
  | 'OKF_CONCEPT_WRITE_FAILED'
  | 'OKF_INDEX_FAILED';

export type OkfErrorStage =
  | 'setup'
  | 'prompt'
  | 'discovery'
  | 'parse'
  | 'syntax'
  | 'cache'
  | 'summary'
  | 'description'
  | 'tags'
  | 'write'
  | 'index';

type Definition = {
  readonly stage: OkfErrorStage;
  readonly message: string;
  readonly hint: string;
  readonly source?: true;
};

const DEFINITIONS: Readonly<Record<OkfErrorCode, Definition>> = {
  OKF_ROOT_INVALID: {
    stage: 'setup',
    message: 'The OKF repository root is unavailable or is not a directory.',
    hint: 'Check that the repository path exists and is readable.',
  },
  OKF_OUTPUT_INVALID: {
    stage: 'setup',
    message: 'The OKF output directory must stay inside .agents/bundles.',
    hint: 'Use the default output or choose a child of .agents/bundles.',
  },
  OKF_OUTPUT_PREPARE_FAILED: {
    stage: 'setup',
    message: 'Could not prepare the OKF output directory.',
    hint: 'Check directory permissions and conflicting files.',
  },
  OKF_PROMPT_LOAD_FAILED: {
    stage: 'prompt',
    message: 'Could not load the OKF prompts for the selected target.',
    hint: 'Check promptTarget and the summarize/describe/tags prompt files.',
  },
  OKF_DISCOVERY_FAILED: {
    stage: 'discovery',
    message: 'Could not discover readable repository files.',
    hint: 'Check repository permissions and filesystem entries.',
  },
  OKF_SOURCE_PARSE_FAILED: {
    stage: 'parse',
    message: 'Could not parse supported source <source>.',
    hint: 'Retry with a smaller file or more available memory.',
    source: true,
  },
  OKF_SOURCE_SYNTAX_INVALID: {
    stage: 'syntax',
    message: 'Supported source syntax is invalid for <source>.',
    hint: 'Fix the syntax error or exclude the file.',
    source: true,
  },
  OKF_CACHE_READ_FAILED: {
    stage: 'cache',
    message: 'Could not read the cached concept for <source>.',
    hint: 'Check the generated bundle file and its permissions.',
    source: true,
  },
  OKF_SUMMARY_FAILED: {
    stage: 'summary',
    message: 'The model could not produce a valid source summary for <source>.',
    hint: 'Confirm LM Studio is running, the model is loaded, and it can return non-empty text.',
    source: true,
  },
  OKF_DESCRIPTION_FAILED: {
    stage: 'description',
    message:
      'The model could not produce a non-empty description for <source>.',
    hint: 'Confirm the model is available and can return non-empty text.',
    source: true,
  },
  OKF_TAGS_FAILED: {
    stage: 'tags',
    message: 'The model could not produce non-empty tags for <source>.',
    hint: 'Confirm the model is available and can return non-empty text.',
    source: true,
  },
  OKF_CONCEPT_WRITE_FAILED: {
    stage: 'write',
    message: 'Could not write the generated concept for <source>.',
    hint: 'Check bundle permissions and available disk space.',
    source: true,
  },
  OKF_INDEX_FAILED: {
    stage: 'index',
    message: 'Could not build or write the OKF project index.',
    hint: 'Check generated concepts and bundle permissions.',
  },
};

const SOURCE_CODES: ReadonlySet<OkfErrorCode> = new Set([
  'OKF_SOURCE_PARSE_FAILED',
  'OKF_SOURCE_SYNTAX_INVALID',
  'OKF_CACHE_READ_FAILED',
  'OKF_SUMMARY_FAILED',
  'OKF_DESCRIPTION_FAILED',
  'OKF_TAGS_FAILED',
  'OKF_CONCEPT_WRITE_FAILED',
]);
const CONSTRUCTION_TOKEN = Symbol('OkfError construction');
const AUTHENTIC = new WeakSet<OkfError>();
let construct: (token: symbol, code: OkfErrorCode, source?: string) => OkfError;

/** A curated, privacy-safe failure raised at a known OKF operation boundary. */
export class OkfError extends Error {
  readonly code: OkfErrorCode;
  readonly stage: OkfErrorStage;
  readonly source?: string;
  readonly hint: string;

  private constructor(token: symbol, code: OkfErrorCode, source?: string) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new Error(
        'OkfError cannot be constructed outside the OKF package.',
      );
    }

    const definition = DEFINITIONS[code];

    super(
      definition.source === true && source !== undefined
        ? definition.message.replace('<source>', source)
        : definition.message,
    );

    this.name = 'OkfError';

    this.code = code;

    this.stage = definition.stage;

    this.hint = definition.hint;

    if (definition.source === true && source !== undefined) {
      this.source = source;
    }
  }

  static {
    construct = (token, code, source) => new OkfError(token, code, source);
  }
}

export const createOkfError = (
  code: OkfErrorCode,
  source?: string,
): OkfError => {
  if (
    (source !== undefined && !isNormalizedSource(source)) ||
    (SOURCE_CODES.has(code) && source === undefined)
  ) {
    throw new Error('OKF source identity is invalid.');
  }

  const error = construct(CONSTRUCTION_TOKEN, code, source);

  AUTHENTIC.add(error);

  return error;
};

/** Returns whether a value is an authentic package-created OKF error. */
export const isOkfError = (value: unknown): value is OkfError =>
  typeof value === 'object' &&
  value !== null &&
  AUTHENTIC.has(value as OkfError);

const isNormalizedSource = (source: string | undefined): source is string => {
  if (source === undefined || source.length === 0 || source.includes('\\')) {
    return false;
  }

  if (source.startsWith('/') || /^[A-Za-z]:/u.test(source)) {
    return false;
  }

  return source
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
};

export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  error.name === 'AbortError';

// What the server dialog edits, as plain values: the draft a form holds while
// the reader types, how a stored server becomes one, and how a draft becomes
// the `mcp/v1` input — checked by the contract's own schema, so the dialog and
// the host cannot disagree about what a server may be.

import type {
  McpClientInfo,
  McpEntry,
  McpServerInput,
} from '../contracts/index.js';
import { mcpServerInputSchema } from '../contracts/index.js';

/**
 * One header or environment variable as the form holds it: a literal `value`,
 * or the stored credential `credentialId` names (the value is then unused).
 * `key` identifies the row while entries are added and removed.
 */
export interface EntryDraft {
  readonly key: string;
  readonly name: string;
  readonly value: string;
  readonly credentialId?: string;
}

export type TransportKind = 'http' | 'stdio';

/** Both transports' fields at once, so switching the kind loses nothing typed. */
export interface ServerDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly kind: TransportKind;
  readonly url: string;
  readonly headers: readonly EntryDraft[];
  /** The OAuth client name; blank for MCP_DEFAULT_CLIENT_NAME. */
  readonly clientName: string;
  /** The OAuth scopes, separated by whitespace; blank for the server's. */
  readonly scopes: string;
  /** The whole command line, as parseCommandLine reads it. */
  readonly command: string;
  readonly cwd: string;
  readonly env: readonly EntryDraft[];
  /** The MCP client info, either transport's; blank for MCP_DEFAULT_CLIENT_INFO's. */
  readonly clientInfoName: string;
  readonly clientInfoVersion: string;
}

/** The fields a refusal points at; an entry's is its name, by row key. */
export interface DraftErrors {
  readonly name?: string;
  readonly url?: string;
  readonly clientName?: string;
  readonly scopes?: string;
  readonly clientInfoName?: string;
  readonly clientInfoVersion?: string;
  readonly command?: string;
  readonly entries?: Readonly<Record<string, string>>;
}

type DraftCheck =
  | { readonly ok: true; readonly input: McpServerInput }
  | { readonly ok: false; readonly errors: DraftErrors };

const draftMessages = {
  name: 'Enter a name of up to 64 characters with a letter, a digit or "-".',
  url: 'Enter an http:// or https:// URL.',
  clientName: 'Enter a client name of up to 128 characters.',
  scopes:
    'Separate scopes with spaces; a scope is printable ASCII other than " and \\.',
  clientInfoName: 'Enter a client name of up to 128 characters.',
  clientInfoVersion: 'Enter a client version of up to 64 characters.',
  command: 'Enter the command to run.',
  commandQuote:
    'Close the open quote, or end the line with a character after "\\".',
  header: "A header name is letters, digits and !#$%&'*+-.^_`|~ only.",
  variable:
    'A variable name starts with a letter or "_", then letters, digits or "_".',
} as const;

/**
 * Splits a command line into words the way a POSIX shell quotes them, without
 * any expansion: unquoted whitespace separates words; '…' is literal; inside
 * "…" a backslash escapes only `"` and `\`; outside quotes `\x` is `x`;
 * adjacent parts join; '' or "" is an empty word; `$ | ; * ~` stay literal.
 * Returns the words (`[]` for a blank line), or `undefined` when a quote is
 * left open or the line ends in a lone backslash. Never throws.
 */
export const parseCommandLine = (
  line: string,
): readonly string[] | undefined => {
  const words: string[] = [];
  /** The word being read, or `undefined` between words. */
  let word: string | undefined;

  // Whitespace, '…', "…", \x, a bare run — or a lone quote or backslash.
  for (const [, space, single, double, escaped, bare] of line.matchAll(
    /(\s+)|'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|([^\s'"\\]+)|[\s\S]/g,
  )) {
    if (space !== undefined) {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    const part =
      single ?? double?.replace(/\\(["\\])/g, '$1') ?? escaped ?? bare;
    if (part === undefined) return undefined;
    word = (word ?? '') + part;
  }

  if (word !== undefined) words.push(word);
  return words;
};

const bareWord = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Writes `words` as one line: bare when a word holds only
 * [A-Za-z0-9_@%+=:,./-], `''` when empty, otherwise single-quoted with each
 * `'` written as `'\''`. For every `words`, parseCommandLine(result) deep-equals `words`.
 */
export const formatCommandLine = (words: readonly string[]): string =>
  words
    .map((word) =>
      bareWord.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`,
    )
    .join(' ');

let nextKey = 0;

/** A new, empty entry row. */
export const emptyEntry = (): EntryDraft => {
  nextKey += 1;
  return { key: `entry-${nextKey}`, name: '', value: '' };
};

const entryDraftOf = (entry: McpEntry): EntryDraft => ({
  ...emptyEntry(),
  name: entry.name,
  ...('credentialId' in entry
    ? { credentialId: entry.credentialId }
    : { value: entry.value }),
});

export const emptyDraft: ServerDraft = {
  name: '',
  enabled: true,
  kind: 'http',
  url: '',
  headers: [],
  clientName: '',
  scopes: '',
  command: '',
  cwd: '',
  env: [],
  clientInfoName: '',
  clientInfoVersion: '',
};

/** The draft a stored server's dialog opens on. */
export const draftOf = ({
  name,
  enabled,
  transport,
}: McpServerInput): ServerDraft => {
  const common = {
    ...emptyDraft,
    name,
    enabled,
    clientInfoName: transport.clientInfo?.name ?? '',
    clientInfoVersion: transport.clientInfo?.version ?? '',
  };

  return transport.kind === 'http'
    ? {
        ...common,
        kind: 'http',
        url: transport.url,
        headers: transport.headers.map(entryDraftOf),
        clientName: transport.clientName ?? '',
        scopes: transport.scopes?.join(' ') ?? '',
      }
    : {
        ...common,
        kind: 'stdio',
        command: formatCommandLine([transport.command, ...transport.args]),
        cwd: transport.cwd ?? '',
        env: transport.env.map(entryDraftOf),
      };
};

const entryOf = ({ name, value, credentialId }: EntryDraft): McpEntry =>
  credentialId === undefined ? { name, value } : { name, credentialId };

/** The draft's client info, without its blank fields; absent when both are. */
const clientInfoOf = (
  draft: ServerDraft,
): { readonly clientInfo?: McpClientInfo } => {
  const name = draft.clientInfoName.trim();
  const version = draft.clientInfoVersion.trim();

  return name === '' && version === ''
    ? {}
    : {
        clientInfo: {
          ...(name === '' ? {} : { name }),
          ...(version === '' ? {} : { version }),
        },
      };
};

/** The input a draft stands for, before the schema checks it. */
const inputOf = (draft: ServerDraft): McpServerInput => {
  const cwd = draft.cwd.trim();
  const clientName = draft.clientName.trim();
  const scopes = draft.scopes.split(/\s+/).filter((scope) => scope !== '');
  const words = parseCommandLine(draft.command);

  return {
    name: draft.name,
    enabled: draft.enabled,
    transport:
      draft.kind === 'http'
        ? {
            kind: 'http',
            url: draft.url.trim(),
            headers: draft.headers.map(entryOf),
            ...(clientName === '' ? {} : { clientName }),
            ...(scopes.length === 0 ? {} : { scopes }),
            ...clientInfoOf(draft),
          }
        : {
            kind: 'stdio',
            command: words?.[0] ?? '',
            args: words?.slice(1) ?? [],
            ...(cwd === '' ? {} : { cwd }),
            env: draft.env.map(entryOf),
            ...clientInfoOf(draft),
          },
  };
};

/** The field an issue's path points at, with the message the form shows. */
const errorsOf = (
  draft: ServerDraft,
  paths: readonly (readonly PropertyKey[])[],
): DraftErrors => {
  const entries = draft.kind === 'http' ? draft.headers : draft.env;
  const entryMessage =
    draft.kind === 'http' ? draftMessages.header : draftMessages.variable;

  const invalidEntries = paths.flatMap(
    ([, list, index]): [string, string][] => {
      const entry =
        (list === 'headers' || list === 'env') && typeof index === 'number'
          ? entries[index]
          : undefined;
      return entry === undefined ? [] : [[entry.key, entryMessage]];
    },
  );

  return {
    ...(paths.some(([first]) => first === 'name')
      ? { name: draftMessages.name }
      : {}),
    ...(paths.some(([, second]) => second === 'url')
      ? { url: draftMessages.url }
      : {}),
    ...(paths.some(([, second]) => second === 'clientName')
      ? { clientName: draftMessages.clientName }
      : {}),
    ...(paths.some(([, second]) => second === 'scopes')
      ? { scopes: draftMessages.scopes }
      : {}),
    ...(paths.some(
      ([, second, third]) => second === 'clientInfo' && third === 'name',
    )
      ? { clientInfoName: draftMessages.clientInfoName }
      : {}),
    ...(paths.some(
      ([, second, third]) => second === 'clientInfo' && third === 'version',
    )
      ? { clientInfoVersion: draftMessages.clientInfoVersion }
      : {}),
    ...(paths.some(([, second]) => second === 'command')
      ? {
          command:
            parseCommandLine(draft.command) === undefined
              ? draftMessages.commandQuote
              : draftMessages.command,
        }
      : {}),
    ...(invalidEntries.length === 0
      ? {}
      : { entries: Object.fromEntries(invalidEntries) }),
  };
};

/** The checked input of a draft, or the fields it must correct first. */
export const checkDraft = (draft: ServerDraft): DraftCheck => {
  const parsed = mcpServerInputSchema.safeParse(inputOf(draft));

  return parsed.success
    ? { ok: true, input: parsed.data }
    : {
        ok: false,
        errors: errorsOf(
          draft,
          parsed.error.issues.map((issue) => issue.path),
        ),
      };
};

// What the server dialog edits, as plain values: the draft a form holds while
// the reader types, how a stored server becomes one, and how a draft becomes
// the `mcp/v1` input — checked by the contract's own schema, so the dialog and
// the host cannot disagree about what a server may be.

import type { McpEntry, McpServerInput } from '../contracts/index.js';
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
  readonly command: string;
  /** One argument per line. */
  readonly args: string;
  readonly cwd: string;
  readonly env: readonly EntryDraft[];
}

/** The fields a refusal points at; an entry's is its name, by row key. */
export interface DraftErrors {
  readonly name?: string;
  readonly url?: string;
  readonly command?: string;
  readonly entries?: Readonly<Record<string, string>>;
}

type DraftCheck =
  | { readonly ok: true; readonly input: McpServerInput }
  | { readonly ok: false; readonly errors: DraftErrors };

const draftMessages = {
  name: 'Enter a name of up to 64 characters with a letter, a digit or "-".',
  url: 'Enter an http:// or https:// URL.',
  command: 'Enter the command to run.',
  header: "A header name is letters, digits and !#$%&'*+-.^_`|~ only.",
  variable:
    'A variable name starts with a letter or "_", then letters, digits or "_".',
} as const;

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
  command: '',
  args: '',
  cwd: '',
  env: [],
};

/** The draft a stored server's dialog opens on. */
export const draftOf = ({
  name,
  enabled,
  transport,
}: McpServerInput): ServerDraft =>
  transport.kind === 'http'
    ? {
        ...emptyDraft,
        name,
        enabled,
        kind: 'http',
        url: transport.url,
        headers: transport.headers.map(entryDraftOf),
      }
    : {
        ...emptyDraft,
        name,
        enabled,
        kind: 'stdio',
        command: transport.command,
        args: transport.args.join('\n'),
        cwd: transport.cwd ?? '',
        env: transport.env.map(entryDraftOf),
      };

const entryOf = ({ name, value, credentialId }: EntryDraft): McpEntry =>
  credentialId === undefined ? { name, value } : { name, credentialId };

/** The input a draft stands for, before the schema checks it. */
const inputOf = (draft: ServerDraft): McpServerInput => {
  const cwd = draft.cwd.trim();

  return {
    name: draft.name,
    enabled: draft.enabled,
    transport:
      draft.kind === 'http'
        ? {
            kind: 'http',
            url: draft.url.trim(),
            headers: draft.headers.map(entryOf),
          }
        : {
            kind: 'stdio',
            command: draft.command.trim(),
            args: draft.args.split(/\r?\n/).filter((line) => line !== ''),
            ...(cwd === '' ? {} : { cwd }),
            env: draft.env.map(entryOf),
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

  const invalidEntries = paths.flatMap(([, , index]): [string, string][] => {
    const entry = typeof index === 'number' ? entries[index] : undefined;
    return entry === undefined ? [] : [[entry.key, entryMessage]];
  });

  return {
    ...(paths.some(([first]) => first === 'name')
      ? { name: draftMessages.name }
      : {}),
    ...(paths.some(([, second]) => second === 'url')
      ? { url: draftMessages.url }
      : {}),
    ...(paths.some(([, second]) => second === 'command')
      ? { command: draftMessages.command }
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

import { stringify } from 'yaml';

import { completeText, type CompletionConfig } from './agent.js';
import { SUMMARY_MAX_OUTPUT_TOKENS } from './constants.js';
import type { ModuleInterface } from './types/interface.js';

type Evidence = {
  readonly content: string;
  readonly interface?: ModuleInterface;
  readonly path: string;
  readonly type: string;
};

export type Summary = {
  readonly analysis: string;
  readonly description: string;
  readonly tags: readonly string[];
};

const validAnalysis = (value: string): boolean =>
  value.length > 0 && !/^---(?:\r?\n|$)/u.test(value);
const LIST_PREFIX = /^(?:[-*+]|\d+[.)])\s+/u;
const FENCE = /(?:`{3,}|~{3,})/u;

const unwrapFence = (value: string): string | undefined => {
  const match =
    /^(?<fence>`{3,}|~{3,})[^\n]*\n(?<body>[\s\S]*)\n\k<fence>$/u.exec(value);

  return match?.groups?.['body']?.trim();
};

const jsonTags = (value: string): readonly string[] | undefined => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) {
    return parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return undefined;
  }

  const keys = Object.keys(parsed);

  if (keys.length !== 1 || keys[0] !== 'tags') {
    return undefined;
  }

  const tags = (parsed as { readonly tags?: unknown }).tags;

  return Array.isArray(tags) && tags.every((item) => typeof item === 'string')
    ? tags
    : undefined;
};

const cleanTag = (value: string): string => {
  const unlisted = value.replace(LIST_PREFIX, '').trim();
  const first = unlisted[0];

  const quoted =
    (first === "'" || first === '"' || first === '`') &&
    unlisted.length >= 2 &&
    unlisted.at(-1) === first;

  return (quoted ? unlisted.slice(1, -1) : unlisted).trim();
};

const plainTags = (value: string): readonly string[] => {
  const label = /^tags:[ \t]*/iu.test(value);
  const candidate = value.replace(/^tags:[ \t]*/iu, '');
  const lines = candidate.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length > 1) {
    return lines;
  }

  const single = lines[0] ?? '';
  const commaItems = single.split(',');

  return label || commaItems.every((item) => !/[.?!]/u.test(item))
    ? commaItems
    : [single];
};

const parseTags = (input: string): readonly string[] | undefined => {
  const normalized = input.replace(/\r\n?/gu, '\n').trim();
  const unwrapped = unwrapFence(normalized);

  if (unwrapped === undefined && FENCE.test(normalized)) {
    return undefined;
  }

  const value = unwrapped ?? normalized;
  const first = value.trimStart()[0];
  const items =
    first === '[' || first === '{' ? jsonTags(value) : plainTags(value);

  if (items === undefined) {
    return undefined;
  }

  const tags = items.map(cleanTag).filter((tag) => tag.length > 0);

  return tags.length > 0 ? tags : undefined;
};

/** Produces a transient evidence-grounded summary of exact source evidence. */
export const summarize = async (
  config: CompletionConfig,
  system: string,
  evidence: Evidence,
): Promise<string> => {
  const result = await completeText({
    ...config,
    system,
    input: renderEvidence(evidence),
    stage: `Source summary for ${evidence.path}`,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });

  if (!validAnalysis(result)) {
    throw new Error('Invalid source analysis');
  }

  return result;
};

/** Produces a non-empty plain-text description from source analysis. */
export const describe = async (
  config: CompletionConfig,
  system: string,
  source: string,
  summary: string,
): Promise<string> =>
  completeText({
    ...config,
    system,
    input: renderSummary(summary),
    stage: `OKF description for ${source}`,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });

/** Produces tags from source analysis, preserving unrecognized non-empty output. */
export const selectTags = async (
  config: CompletionConfig,
  system: string,
  source: string,
  summary: string,
): Promise<readonly string[]> => {
  const result = await completeText({
    ...config,
    system,
    input: renderSummary(summary),
    stage: `OKF tags for ${source}`,
    maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
  });
  const original = result.trim();

  return parseTags(original) ?? [original];
};

/** Renders only transient summary text in collision-safe Markdown. */
export const renderSummary = (value: string): string =>
  `# Source Summary\n\n${fenced(value, 'text')}`;

/** Renders exact file evidence as deterministic, collision-safe Markdown. */
export const renderEvidence = (input: Evidence): string =>
  [
    '# File Evidence',
    section('Path', input.path, 'text'),
    section('Type', input.type, 'text'),
    ...(input.interface === undefined
      ? []
      : [
          section(
            'Module Interface',
            stringify(input.interface).trimEnd(),
            'yaml',
          ),
        ]),
    contentSection(input.content, input.type === 'json' ? 'json' : 'text'),
  ].join('\n\n');

const contentSection = (value: string, language: string): string => {
  const fence = selectFence(value);
  const body = value.endsWith('\n') ? value : `${value}\n`;
  const terminalNewline = value.endsWith('\n') ? 'yes' : 'no';

  return [
    '## Content',
    `UTF-8 bytes: ${Buffer.byteLength(value, 'utf8')}`,
    `Terminal newline: ${terminalNewline}`,
    `${fence}${language}\n${body}${fence}`,
  ].join('\n\n');
};

const section = (heading: string, value: string, language: string): string => {
  return `## ${heading}\n\n${fenced(value, language)}`;
};

const fenced = (value: string, language: string): string => {
  const fence = selectFence(value);
  const body = value.endsWith('\n') ? value : `${value}\n`;

  return `${fence}${language}\n${body}${fence}`;
};

const selectFence = (value: string): string => {
  const backticks = longestRun(value, '`');
  const tildes = longestRun(value, '~');
  const marker = backticks <= tildes ? '`' : '~';

  return marker.repeat(Math.max(3, Math.min(backticks, tildes) + 1));
};

const longestRun = (value: string, marker: '`' | '~'): number =>
  (value.match(marker === '`' ? /`+/gu : /~+/gu) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );

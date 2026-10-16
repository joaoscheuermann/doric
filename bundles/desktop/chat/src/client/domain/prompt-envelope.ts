// The prompt envelope: what every send carries to the agent, and how a stored
// prompt is read back as the reader's words. The agent reads only the prompt,
// so the comments of the stack travel in it, grouped by the target they are
// about, above the words the reader wrote:
//
//   <comments>
//   <target kind="artifact" id="art_123" revision="2" title="Checkout">
//   <comment id="comment-…" pin="1" anchor="src/Checkout.tsx:14" element="h2">note</comment>
//   </target>
//   </comments>
//   <message>
//   the reader's words
//   </message>
//
// Either part alone is a whole prompt; the runtime wraps the envelope in
// `<user-request>` for the model, so the chat never adds that element. The
// prompt the log stores is this text, so every place the chat shows a stored
// prompt as the reader's words reads it back through `promptMessage`.

import type { ComposerItem } from '../../contracts/index.js';
import { anchorOf, itemData, targetKey } from './composer-stack.js';

/** The longest selected text a `range` comment quotes. */
const QUOTE_LIMIT = 200;

/** Elements of the envelopes the model reads; a body never closes one. */
const ENVELOPE_ELEMENTS =
  'comments|comment|target|message|user-request|parent-instruction|child-result|terminal-output';

const closing = new RegExp(`</(?=(?:${ENVELOPE_ELEMENTS})\\b)`, 'gi');
const neutralized = new RegExp(`<\\\\/(?=(?:${ENVELOPE_ELEMENTS})\\b)`, 'gi');

/** A body as the envelope carries it: closing tags of its elements defused. */
const bodyText = (value: string): string => value.replace(closing, '<\\/');

/** A body as the reader wrote it. */
const bodyFrom = (value: string): string => value.replace(neutralized, '</');

const attributeText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const attributeFrom = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

type Attributes = readonly (readonly [string, string | undefined])[];

/** The attributes in the order given, leaving out the ones without a value. */
const attributes = (entries: Attributes): string =>
  entries
    .filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined,
    )
    .map(([name, value]) => ` ${name}="${attributeText(value)}"`)
    .join('');

const filled = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Where a comment sits, in the anchor's own words: the stamped `path:line`
 * with its element, the selector, the free position with the nearest element,
 * or the quoted text of a range. An anchor without a form is read by its
 * fields, in that order of strength.
 */
const anchorAttributes = (target: unknown): Attributes => {
  const anchor = anchorOf(target);
  if (anchor === undefined) return [];
  const form = anchor.form;
  const label = filled(anchor.label);
  const path = filled(anchor.path);
  const selector = filled(anchor.selector);
  const pointed = typeof anchor.x === 'number' && typeof anchor.y === 'number';
  const quoted =
    typeof anchor.text === 'string' && anchor.text.trim().length > 0
      ? anchor.text.trim().slice(0, QUOTE_LIMIT)
      : undefined;

  if (form === 'source' || (form === undefined && path !== undefined)) {
    if (path === undefined) return [];
    const at =
      typeof anchor.line === 'number' ? `${path}:${anchor.line}` : path;
    return [
      ['anchor', at],
      ['element', label],
    ];
  }
  if (form === 'selector' || (form === undefined && selector !== undefined)) {
    return selector === undefined
      ? []
      : [
          ['anchor', selector],
          ['element', label],
        ];
  }
  if (form === 'point' || (form === undefined && pointed)) {
    return pointed
      ? [
          ['anchor', `point ${anchor.x},${anchor.y}`],
          ['near', label],
        ]
      : [];
  }
  if (form === 'range' || (form === undefined && quoted !== undefined)) {
    return [
      ['anchor', 'range'],
      ['quote', quoted],
    ];
  }
  return [];
};

/** One `<target>` group: the items about one target revision, in stack order. */
interface Group {
  readonly key: string;
  readonly target: ReturnType<typeof targetKey>;
  title?: string;
  source?: string;
  readonly lines: string[];
}

const commentLine = (item: ComposerItem, note: string): string => {
  const data = itemData(item);
  return `<comment${attributes([
    ['id', item.id],
    ['in-reply-to', data.inReplyTo],
    ['pin', data.pin === undefined ? undefined : String(data.pin)],
    ...anchorAttributes(data.target),
  ])}>${bodyText(note)}</comment>`;
};

/** The `<comments>` part: the items with a note, grouped by target. */
const commentsPart = (items: readonly ComposerItem[]): string => {
  const groups: Group[] = [];

  for (const item of items) {
    const note = item.note.trim();
    if (note.length === 0) continue;
    const data = itemData(item);
    const target = targetKey(data.target);
    const key =
      target === undefined
        ? ''
        : JSON.stringify([target.kind, target.id, target.revision ?? null]);
    let group = groups.find((held) => held.key === key);
    if (group === undefined) {
      group = { key, target, lines: [] };
      groups.push(group);
    }
    group.title ??= data.refs?.title;
    group.source ??= data.refs?.source;
    group.lines.push(commentLine(item, note));
  }

  if (groups.length === 0) return '';

  const lines = ['<comments>'];
  for (const group of groups) {
    // A comment that names no target still travels, outside any target.
    if (group.target === undefined) {
      lines.push(...group.lines);
      continue;
    }
    lines.push(
      `<target${attributes([
        ['kind', group.target.kind],
        ['id', group.target.id],
        [
          'revision',
          group.target.revision === undefined
            ? undefined
            : String(group.target.revision),
        ],
        ['title', group.title],
        ['source', group.source],
      ])}>`,
      ...group.lines,
      '</target>',
    );
  }
  lines.push('</comments>');

  return lines.join('\n');
};

const messagePart = (words: string): string =>
  words.length === 0 ? '' : `<message>\n${bodyText(words)}\n</message>`;

const joined = (comments: string, message: string): string =>
  [comments, message].filter((part) => part.length > 0).join('\n');

/**
 * The prompt a send carries: the stack's comments with a note, grouped by
 * target in first-appearance order, then the reader's words. Either part is
 * left out when it is empty, and an empty string means nothing to send.
 */
export const promptEnvelope = (
  words: string,
  items: readonly ComposerItem[],
): string => joined(commentsPart(items), messagePart(words.trim()));

/* Reading a prompt back ----------------------------------------------------- */

/** The target a parsed comment was grouped under. */
export interface ParsedCommentTarget {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
  readonly title?: string;
  readonly source?: string;
}

/** One comment of a stored envelope, as its attributes and body state it. */
export interface ParsedComment {
  readonly id?: string;
  readonly inReplyTo?: string;
  readonly pin?: number;
  readonly target?: ParsedCommentTarget;
  /** `path:line`, a selector, `point x,y` or `range`. */
  readonly anchor?: string;
  readonly element?: string;
  readonly near?: string;
  readonly quote?: string;
  /** The note, as the reader wrote it. */
  readonly text: string;
}

/** A stored prompt read back: the reader's words and the comments above them. */
export interface ParsedPromptEnvelope {
  /** The `<message>` body; empty for a prompt of comments alone. */
  readonly message: string;
  readonly comments: readonly ParsedComment[];
}

const ATTRIBUTES = String.raw`((?:\s[a-z][a-z-]*="[^"]*")*)`;
const targetOpen = new RegExp(String.raw`<target${ATTRIBUTES}>\n`, 'y');
const targetClose = /<\/target>\n/y;
const commentElement = new RegExp(
  String.raw`<comment${ATTRIBUTES}>([\s\S]*?)<\/comment>\n`,
  'y',
);
const commentsClose = /<\/comments>/y;

const attributesFrom = (source: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/\s([a-z][a-z-]*)="([^"]*)"/g)) {
    found.set(match[1] as string, attributeFrom(match[2] as string));
  }
  return found;
};

const numberFrom = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const parsedTarget = (
  found: ReadonlyMap<string, string>,
): ParsedCommentTarget | undefined => {
  const kind = found.get('kind');
  const id = found.get('id');
  if (kind === undefined || id === undefined) return undefined;
  const revision = numberFrom(found.get('revision'));
  const title = found.get('title');
  const source = found.get('source');
  return {
    kind,
    id,
    ...(revision === undefined ? {} : { revision }),
    ...(title === undefined ? {} : { title }),
    ...(source === undefined ? {} : { source }),
  };
};

const parsedComment = (
  found: ReadonlyMap<string, string>,
  body: string,
  target: ParsedCommentTarget | undefined,
): ParsedComment => {
  const pin = numberFrom(found.get('pin'));
  const id = found.get('id');
  const inReplyTo = found.get('in-reply-to');
  const anchor = found.get('anchor');
  const element = found.get('element');
  const near = found.get('near');
  const quote = found.get('quote');
  return {
    ...(id === undefined ? {} : { id }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(pin === undefined ? {} : { pin }),
    ...(target === undefined ? {} : { target }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(element === undefined ? {} : { element }),
    ...(near === undefined ? {} : { near }),
    ...(quote === undefined ? {} : { quote }),
    text: bodyFrom(body),
  };
};

/** A stored envelope, with the raw `<comments>` part it began with. */
interface ReadEnvelope extends ParsedPromptEnvelope {
  readonly commentsPart: string;
}

/**
 * Reads an envelope the builder wrote, the whole text or nothing: a prompt
 * that is not one exactly (any prompt written before the envelope, or by
 * another sender) answers `undefined`.
 */
const readEnvelope = (stored: string): ReadEnvelope | undefined => {
  let text = stored.trim();
  // The runtime's own wrapper, should a stored prompt ever carry it.
  const wrapped = /^<user-request>\n([\s\S]*)\n<\/user-request>$/.exec(text);
  if (wrapped !== null) text = wrapped[1] as string;

  let at = 0;
  const comments: ParsedComment[] = [];
  let commentsPart = '';

  if (text.startsWith('<comments>\n')) {
    at = '<comments>\n'.length;
    let target: ParsedCommentTarget | undefined;
    let open = false;
    for (;;) {
      commentsClose.lastIndex = at;
      if (!open && commentsClose.test(text)) {
        at = commentsClose.lastIndex;
        break;
      }
      targetOpen.lastIndex = at;
      const opened = open ? null : targetOpen.exec(text);
      if (opened !== null) {
        target = parsedTarget(attributesFrom(opened[1] as string));
        if (target === undefined) return undefined;
        open = true;
        at = targetOpen.lastIndex;
        continue;
      }
      targetClose.lastIndex = at;
      if (open && targetClose.test(text)) {
        at = targetClose.lastIndex;
        open = false;
        target = undefined;
        continue;
      }
      commentElement.lastIndex = at;
      const comment = commentElement.exec(text);
      if (comment === null) return undefined;
      comments.push(
        parsedComment(
          attributesFrom(comment[1] as string),
          comment[2] as string,
          target,
        ),
      );
      at = commentElement.lastIndex;
    }
    commentsPart = text.slice(0, at);
    if (at < text.length) {
      if (text[at] !== '\n') return undefined;
      at += 1;
    }
  }

  let message = '';
  const rest = text.slice(at);
  if (rest.length > 0) {
    const close = '\n</message>';
    if (!rest.startsWith('<message>\n') || !rest.endsWith(close))
      return undefined;
    const body = rest.slice('<message>\n'.length, rest.length - close.length);
    // A body defuses its closing tags, so the only one is the last.
    if (body.includes(close)) return undefined;
    message = bodyFrom(body);
  } else if (commentsPart.length === 0) {
    return undefined;
  }

  return { message, comments, commentsPart };
};

/**
 * Reads a stored prompt back as an envelope, or `undefined` for a plain-text
 * prompt, which every surface shows exactly as it was written.
 */
export const parsePromptEnvelope = (
  text: string,
): ParsedPromptEnvelope | undefined => {
  const read = readEnvelope(text);
  return read === undefined
    ? undefined
    : { message: read.message, comments: read.comments };
};

/** The reader's words of a stored prompt: the `<message>` body, else the text. */
export const promptMessage = (text: string): string =>
  parsePromptEnvelope(text)?.message ?? text;

/**
 * Words that stand for a stored prompt on a one-line surface (a queue row, a
 * rail marker): the reader's words, else — for a prompt of comments alone —
 * the comments' notes, one per line.
 */
export const promptSummary = (text: string): string => {
  const parsed = parsePromptEnvelope(text);
  if (parsed === undefined) return text;
  if (parsed.message.trim().length > 0) return parsed.message;
  return parsed.comments.map((comment) => comment.text).join('\n');
};

/**
 * `promptSummary` for the host's queue preview of a prompt: the stored text
 * with its whitespace collapsed and cut short, so the envelope may be missing
 * its end. The words are read up to where the preview stops; a preview cut
 * before them reads as the notes it holds. Any other preview is kept as is.
 */
export const previewSummary = (preview: string): string => {
  const text = preview.trim();
  if (!/^<(?:comments|message|user-request)>/.test(text)) return preview;
  const message = /<message>\s?([\s\S]*?)(?:\s?<\/message>|$)/.exec(text);
  const words = message?.[1]?.trim() ?? '';
  if (words.length > 0) return bodyFrom(words);
  const notes = [
    ...text.matchAll(/<comment\b[^>]*>([\s\S]*?)(?:<\/comment>|$)/g),
  ]
    .map((match) => bodyFrom((match[1] as string).trim()))
    .filter((note) => note.length > 0);
  return notes.length === 0 ? preview : notes.join(' · ');
};

/**
 * A stored prompt with the reader's words replaced (a queued prompt edited):
 * an envelope keeps its `<comments>` exactly as they were sent and takes the
 * new words as its `<message>`; a plain-text prompt becomes the new words.
 */
export const withPromptMessage = (stored: string, words: string): string => {
  const read = readEnvelope(stored);
  if (read === undefined) return words.trim();
  return joined(read.commentsPart, messagePart(words.trim()));
};

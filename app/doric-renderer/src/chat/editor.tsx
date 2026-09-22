import { MessageColumn } from '@/components/message-scroller';
import { cn } from '@/lib/utils';
import { type KeyboardEvent, useCallback, useRef, useState } from 'react';
import {
  type BaseEditor,
  createEditor,
  type Descendant,
  Editor,
  Node,
  type NodeEntry,
  type Range,
  Text,
  Transforms,
} from 'slate';
import { type HistoryEditor, withHistory } from 'slate-history';
import {
  Editable,
  ReactEditor,
  type RenderElementProps,
  type RenderLeafProps,
  Slate,
  withReact,
} from 'slate-react';

import {
  markdownFromValue,
  type MarkdownLine,
  markdownValue,
} from './markdown-source';
import { shouldSubmit } from './shortcuts';

type MarkdownText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  marker?: boolean;
};

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor;
    Element: MarkdownLine;
    Text: MarkdownText;
  }
}

const addRange = (
  ranges: Range[],
  path: readonly number[],
  start: number,
  end: number,
  mark: Omit<MarkdownText, 'text'>,
) => {
  if (end <= start) return;
  ranges.push({
    anchor: { path: [...path], offset: start },
    focus: { path: [...path], offset: end },
    ...mark,
  });
};

const addMatches = (
  ranges: Range[],
  text: string,
  path: readonly number[],
  expression: RegExp,
  mark: Omit<MarkdownText, 'text'>,
) => {
  for (const match of text.matchAll(expression)) {
    const start = match.index;
    addRange(ranges, path, start, start + match[0].length, mark);
  }
};

export const markdownDecorations = ([node, path]: NodeEntry): Range[] => {
  if (!Text.isText(node)) return [];
  const ranges: Range[] = [];
  const text = node.text;
  addMatches(ranges, text, path, /\*\*[^*\n]+\*\*/g, { bold: true });
  addMatches(ranges, text, path, /(?<!\*)\*[^*\n]+\*(?!\*)/g, {
    italic: true,
  });
  addMatches(ranges, text, path, /~~[^~\n]+~~/g, { strike: true });
  addMatches(ranges, text, path, /`[^`\n]+`/g, { code: true });
  addMatches(ranges, text, path, /\[[^\]\n]+\]\([^)\n]*\)/g, { link: true });
  addMatches(
    ranges,
    text,
    path,
    /^(?:#{1,6}\s|>\s|[-+*]\s|(?:\d+)\.\s|- \[[ xX]\]\s|```.*$)/g,
    { marker: true },
  );
  return ranges;
};

const decorateWithFences = (editor: Editor, entry: NodeEntry): Range[] => {
  const ranges = markdownDecorations(entry);
  const [node, path] = entry;
  if (!Text.isText(node) || path.length !== 2) return ranges;
  const line = path[0];
  const precedingFences = editor.children
    .slice(0, line)
    .filter((child) => /^```/.test(Node.string(child))).length;
  if (precedingFences % 2 === 1) {
    addRange(ranges, path, 0, node.text.length, { code: true });
  }
  return ranges;
};

const Line = ({ attributes, children, element }: RenderElementProps) => {
  const source = Node.string(element);
  const heading = /^(#{1,6})\s/.exec(source)?.[1].length;
  return (
    <div
      {...attributes}
      className={cn(
        'min-h-6',
        heading === 1 && 'text-2xl font-semibold',
        heading === 2 && 'text-xl font-semibold',
        heading !== undefined && heading > 2 && 'text-lg font-semibold',
        /^>\s/.test(source) && 'border-l-2 pl-3 text-muted-foreground',
        /^```/.test(source) && 'font-mono text-sm',
        /^(?:---+|\*\*\*+|___+)$/.test(source.trim()) &&
          'border-b text-transparent',
      )}
    >
      {children}
    </div>
  );
};

const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => (
  <span
    {...attributes}
    className={cn(
      leaf.bold && 'font-bold',
      leaf.italic && 'italic',
      leaf.strike && 'line-through',
      leaf.code && 'font-mono',
      leaf.link && 'underline',
      leaf.marker && 'text-muted-foreground',
    )}
  >
    {children}
  </span>
);

const platform = (): string => navigator.platform;

export function PromptEditor({ threadId }: { readonly threadId: string }) {
  const [editor] = useState(() => withHistory(withReact(createEditor())));
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const markdown = useRef('');

  const submit = async () => {
    const prompt = markdown.current;
    if (submitting || prompt.trim().length === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await window.doric.threads.prompt(threadId, prompt);
      markdown.current = '';
      Transforms.select(editor, Editor.range(editor, []));
      Transforms.delete(editor);
      ReactEditor.focus(editor);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The prompt was not accepted.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!shouldSubmit(event, platform())) return;
    event.preventDefault();
    void submit();
  };

  const change = useCallback((value: Descendant[]) => {
    markdown.current = markdownFromValue(value);
  }, []);
  const decorate = useCallback(
    (entry: NodeEntry) => decorateWithFences(editor, entry),
    [editor],
  );

  return (
    <div
      className="group w-full bg-secondary/25 focus-within:bg-secondary/40"
      data-pending={submitting || undefined}
    >
      <MessageColumn className="py-4">
        <div
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center"
        >
          <span className="font-mono text-xs text-muted-foreground/60 transition-colors group-focus-within:text-muted-foreground">
            ❯
          </span>
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <label className="sr-only" htmlFor={`prompt-${threadId}`}>
            Prompt
          </label>
          <Slate
            editor={editor}
            initialValue={markdownValue('') as Descendant[]}
            onChange={change}
          >
            <Editable
              id={`prompt-${threadId}`}
              aria-describedby={error ? `prompt-error-${threadId}` : undefined}
              aria-label="Prompt"
              className="min-h-7 font-serif text-sm leading-6 outline-none"
              decorate={decorate}
              onKeyDown={keyDown}
              placeholder="Write a prompt…"
              readOnly={submitting}
              renderElement={Line}
              renderLeaf={Leaf}
            />
          </Slate>
          {submitting && (
            <p className="mt-2 text-xs text-muted-foreground">Sending…</p>
          )}
          {error && (
            <p
              id={`prompt-error-${threadId}`}
              className="mt-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </MessageColumn>
    </div>
  );
}

/**
 * One flow of text, with the emphasis its marks ask for.
 *
 * It reads the runs of a single line, so it is what a surface uses when it has
 * text but no layout: the agent's reasoning arrives as one flow whose line breaks
 * are the chunks it was streamed in, not the paragraphs it meant, so blocks would
 * read a structure the source does not have. The marks themselves still say
 * something — reasoning is full of `` `identifiers` ``, and a `**run**` a model
 * emphasises is one — and those are inline, so they survive.
 *
 * The marks stay in the text, like everywhere else in the conversation: the run
 * that wears bold still reads `**run**`. Only the look changes.
 */
import { type MarkdownRun, markdownRuns } from '@/domain/markdown';

/** The look one run wears, in the app's own utilities rather than the editor's. */
const runClasses: Readonly<Record<MarkdownRun['kind'], string>> = {
  text: '',
  marker: '',
  bold: 'font-medium',
  italic: 'italic',
  strike: 'line-through',
  code: 'rounded-sm bg-muted px-0.5 font-mono text-[0.85em]',
};

export function MarkdownText({ source }: { readonly source: string }) {
  return (
    <>
      {markdownRuns(source).map((run, index) => (
        <span key={index} className={runClasses[run.kind]}>
          {run.source}
        </span>
      ))}
    </>
  );
}

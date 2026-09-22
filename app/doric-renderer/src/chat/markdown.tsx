import { Streamdown } from 'streamdown';

const excludedElements = ['table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'];

export function Markdown({
  children,
  streaming = false,
}: {
  readonly children: string;
  readonly streaming?: boolean;
}) {
  return (
    <Streamdown
      className="min-w-0 font-serif text-sm leading-7 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_pre]:overflow-x-auto"
      controls={{ code: false, image: false, table: false }}
      disallowedElements={excludedElements}
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      skipHtml
      unwrapDisallowed
    >
      {children}
    </Streamdown>
  );
}

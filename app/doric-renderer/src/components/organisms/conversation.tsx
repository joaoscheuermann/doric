import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  type PromptSegment,
  type PromptStatus,
  type PromptTurn,
} from '@/domain/projector';
import type { Thread } from '@/domain/workspace';
import { useThreadChat } from '@/hooks/use-thread-chat';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import {
  AlertCircle,
  Check,
  ChevronDown,
  LoaderCircle,
  Send,
  Wrench,
} from 'lucide-react';
import {
  $getRoot,
  DecoratorNode,
  type NodeKey,
  type LexicalEditor,
  type SerializedLexicalNode,
} from 'lexical';
import { type ReactNode, useEffect, useRef, useState } from 'react';

const statusLabel: Record<PromptStatus, string> = {
  queued: 'Queued',
  streaming: 'Working',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const statusClass: Record<PromptStatus, string> = {
  queued: 'text-muted-foreground',
  streaming: 'text-primary',
  completed: 'text-muted-foreground',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

const TurnStatus = ({ status }: { readonly status: PromptStatus }) => (
  <span className={`text-xs ${statusClass[status]}`}>
    {statusLabel[status]}
  </span>
);

const TurnDecorator = ({
  markdown,
  role,
  status,
}: {
  readonly markdown: string;
  readonly role: PromptTurn['inputRole'];
  readonly status: PromptStatus;
}) => (
  <article className="group flex gap-3 py-5" data-turn-role={role}>
    <div className="flex w-20 shrink-0 flex-col items-end gap-1 pt-0.5 text-right">
      <span className="text-xs font-medium text-foreground">
        {role === 'user' ? 'You' : 'Agent'}
      </span>
      <TurnStatus status={status} />
    </div>
    <div className="min-w-0 flex-1 border-l pl-4">
      <div className="font-mono text-sm leading-7 whitespace-pre-wrap break-words">
        {markdown || 'Empty message'}
      </div>
    </div>
  </article>
);

const DraftDecorator = ({
  text,
  thinking,
}: {
  readonly text: string;
  readonly thinking: boolean;
}) => (
  <div
    className="group flex gap-3 py-3"
    data-draft-kind={thinking ? 'thinking' : 'text'}
  >
    <div className="flex w-20 shrink-0 flex-col items-end gap-1 pt-0.5 text-right">
      <span className="text-xs font-medium text-foreground">Agent</span>
      <span className="text-xs text-muted-foreground">
        {thinking ? 'Thinking' : 'Draft'}
      </span>
    </div>
    <div
      className={
        thinking
          ? 'min-w-0 flex-1 border-l border-dashed pl-4 font-mono text-sm leading-7 whitespace-pre-wrap text-muted-foreground italic'
          : 'min-w-0 flex-1 border-l pl-4 font-mono text-sm leading-7 whitespace-pre-wrap'
      }
    >
      {text || 'Waiting for output…'}
    </div>
  </div>
);

const ToolCallDecorator = ({
  segment,
}: {
  readonly segment: Extract<PromptSegment, { kind: 'tool' }>;
}) => {
  const running = segment.status === 'running';
  const failed = segment.status === 'failed';

  return (
    <div className="group flex gap-3 py-2" data-tool-call-id={segment.callId}>
      <div className="flex w-20 shrink-0 justify-end pt-2 text-muted-foreground">
        <Wrench aria-hidden="true" className="size-3.5" />
      </div>
      <details
        className="group/tool min-w-0 flex-1 rounded-lg border bg-card text-card-foreground"
        open={running || failed}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
          {running ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin text-primary"
            />
          ) : failed ? (
            <AlertCircle
              aria-hidden="true"
              className="size-3.5 text-destructive"
            />
          ) : (
            <Check
              aria-hidden="true"
              className="size-3.5 text-muted-foreground"
            />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">
            {segment.name || 'Unnamed tool'}
          </span>
          <span className="text-xs text-muted-foreground">
            {segment.status}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="size-3.5 text-muted-foreground transition-transform group-open/tool:rotate-180"
          />
        </summary>
        <div className="border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          <pre className="overflow-x-auto">{segment.args || '{}'}</pre>
          {segment.result === undefined ? null : (
            <pre className="mt-2 overflow-x-auto">
              {segment.result || '(empty result)'}
            </pre>
          )}
          {segment.error ? (
            <p className="mt-2 text-destructive">{segment.error}</p>
          ) : null}
        </div>
      </details>
    </div>
  );
};

type SerializedTurnNode = SerializedLexicalNode & {
  readonly markdown: string;
  readonly role: PromptTurn['inputRole'];
  readonly status: PromptStatus;
};

type SerializedDraftNode = SerializedLexicalNode & {
  readonly text: string;
  readonly thinking: boolean;
};

type SerializedToolCallNode = SerializedLexicalNode & {
  readonly segment: Extract<PromptSegment, { kind: 'tool' }>;
};

class TurnNode extends DecoratorNode<ReactNode> {
  __role: PromptTurn['inputRole'];
  __markdown: string;
  __status: PromptStatus;

  static override getType(): string {
    return 'conversation-turn';
  }

  static override clone(node: TurnNode): TurnNode {
    return new TurnNode(
      node.__role,
      node.__markdown,
      node.__status,
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedLexicalNode): TurnNode {
    const { markdown, role, status } = serializedNode as SerializedTurnNode;
    return $createTurnNode(role, markdown, status);
  }

  constructor(
    role: PromptTurn['inputRole'],
    markdown: string,
    status: PromptStatus,
    key?: NodeKey,
  ) {
    super(key);
    this.__role = role;
    this.__markdown = markdown;
    this.__status = status;
  }

  override exportJSON(): SerializedTurnNode {
    return {
      ...super.exportJSON(),
      markdown: this.__markdown,
      role: this.__role,
      status: this.__status,
      type: TurnNode.getType(),
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    return document.createElement('div');
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(): ReactNode {
    return (
      <TurnDecorator
        markdown={this.__markdown}
        role={this.__role}
        status={this.__status}
      />
    );
  }
}

const $createTurnNode = (
  role: PromptTurn['inputRole'],
  markdown: string,
  status: PromptStatus,
): TurnNode => new TurnNode(role, markdown, status);

class DraftNode extends DecoratorNode<ReactNode> {
  __text: string;
  __thinking: boolean;

  static override getType(): string {
    return 'conversation-draft';
  }

  static override clone(node: DraftNode): DraftNode {
    return new DraftNode(node.__text, node.__thinking, node.__key);
  }

  static override importJSON(serializedNode: SerializedLexicalNode): DraftNode {
    const { text, thinking } = serializedNode as SerializedDraftNode;
    return $createDraftNode(text, thinking);
  }

  constructor(text: string, thinking: boolean, key?: NodeKey) {
    super(key);
    this.__text = text;
    this.__thinking = thinking;
  }

  override exportJSON(): SerializedDraftNode {
    return {
      ...super.exportJSON(),
      text: this.__text,
      thinking: this.__thinking,
      type: DraftNode.getType(),
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    return document.createElement('div');
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(): ReactNode {
    return <DraftDecorator text={this.__text} thinking={this.__thinking} />;
  }
}

const $createDraftNode = (text: string, thinking = false): DraftNode =>
  new DraftNode(text, thinking);

class ComposerNode extends DecoratorNode<ReactNode> {
  __value: string;
  __onChange: (value: string) => void;
  __onSubmit: () => void;
  __sending: boolean;
  static override getType(): string {
    return 'conversation-composer';
  }
  static override clone(node: ComposerNode): ComposerNode {
    return new ComposerNode(
      node.__value,
      node.__onChange,
      node.__onSubmit,
      node.__sending,
      node.__key,
    );
  }
  static override importJSON(
    serializedNode: SerializedLexicalNode,
  ): ComposerNode {
    return new ComposerNode(
      '',
      () => undefined,
      () => undefined,
      false,
    );
  }
  constructor(
    value: string,
    onChange: (value: string) => void,
    onSubmit: () => void,
    sending: boolean,
    key?: NodeKey,
  ) {
    super(key);
    this.__value = value;
    this.__onChange = onChange;
    this.__onSubmit = onSubmit;
    this.__sending = sending;
  }
  override exportJSON(): SerializedLexicalNode {
    return { ...super.exportJSON(), type: ComposerNode.getType(), version: 1 };
  }
  override createDOM(): HTMLElement {
    return document.createElement('div');
  }
  override updateDOM(): false {
    return false;
  }
  override decorate(): ReactNode {
    return (
      <div className="rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <textarea
          aria-label="Message Agent"
          className="min-h-16 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          disabled={this.__sending}
          onChange={(event) => this.__onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              this.__onSubmit();
            }
          }}
          placeholder="Ask Agent to build, fix, or explain anything…"
          value={this.__value}
        />
        <div className="flex items-center justify-between gap-3 px-1 pt-1">
          <span className="text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </span>
          <Button
            aria-label="Send message"
            disabled={this.__sending || this.__value.trim().length === 0}
            size="sm"
            type="button"
            onClick={this.__onSubmit}
          >
            {this.__sending ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin"
              />
            ) : (
              <Send aria-hidden="true" className="size-3.5" />
            )}
            Send
          </Button>
        </div>
      </div>
    );
  }
}

const $createComposerNode = (
  value: string,
  onChange: (value: string) => void,
  onSubmit: () => void,
  sending: boolean,
): ComposerNode => new ComposerNode(value, onChange, onSubmit, sending);

class ToolCallNode extends DecoratorNode<ReactNode> {
  __segment: Extract<PromptSegment, { kind: 'tool' }>;

  static override getType(): string {
    return 'conversation-tool-call';
  }

  static override clone(node: ToolCallNode): ToolCallNode {
    return new ToolCallNode(node.__segment, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedLexicalNode,
  ): ToolCallNode {
    const { segment } = serializedNode as SerializedToolCallNode;
    return $createToolCallNode(segment);
  }

  constructor(
    segment: Extract<PromptSegment, { kind: 'tool' }>,
    key?: NodeKey,
  ) {
    super(key);
    this.__segment = segment;
  }

  override exportJSON(): SerializedToolCallNode {
    return {
      ...super.exportJSON(),
      segment: this.__segment,
      type: ToolCallNode.getType(),
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    return document.createElement('div');
  }

  override updateDOM(): false {
    return false;
  }

  override decorate(): ReactNode {
    return <ToolCallDecorator segment={this.__segment} />;
  }
}

const $createToolCallNode = (
  segment: Extract<PromptSegment, { kind: 'tool' }>,
): ToolCallNode => new ToolCallNode(segment);

const turnIdentity = (turn: PromptTurn): string =>
  `${turn.promptId}:${turn.sequence}:${turn.status}:${turn.userMarkdown}:${turn.segments
    .map((segment) =>
      segment.kind === 'tool'
        ? `${segment.callId}:${segment.status}:${segment.result ?? ''}:${segment.error ?? ''}`
        : segment.text,
    )
    .join('|')}`;

const turnMarkdown = (turn: PromptTurn): string => {
  if (turn.userMarkdown.length > 0) return turn.userMarkdown;
  if (turn.delegated === undefined) return '';
  const { text } = turn.delegated;
  return text.length > 0 ? text : 'Delegated message';
};

const ReadOnlyConversation = () => {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(false), [editor]);
  return (
    <ContentEditable
      aria-label="Conversation"
      className="min-h-48 outline-none"
    />
  );
};

const TurnDocument = ({
  draft,
  onDraftChange,
  onSubmit,
  sending,
  turns,
}: {
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly sending: boolean;
  readonly turns: readonly PromptTurn[];
}) => {
  const [editor] = useLexicalComposerContext();
  const identity = [...turns.map(turnIdentity), `composer:${draft}:${sending}`];
  const rendered = useRef('');

  useEffect(() => {
    const documentIdentity = identity.join('\u0000');
    if (rendered.current === documentIdentity) return;
    rendered.current = documentIdentity;

    editor.update(() => {
      const root = $getRoot();
      root.clear();

      for (const turn of turns) {
        root.append(
          $createTurnNode(turn.inputRole, turnMarkdown(turn), turn.status),
        );
        for (const segment of turn.segments) {
          if (segment.kind === 'tool') {
            root.append($createToolCallNode(segment));
          } else {
            root.append(
              $createDraftNode(segment.text, segment.kind === 'thinking'),
            );
          }
        }
      }
      root.append($createComposerNode(draft, onDraftChange, onSubmit, sending));
    });
  }, [draft, editor, identity, onDraftChange, onSubmit, sending, turns]);

  return null;
};

const lexicalTheme = {
  paragraph: 'm-0',
  text: {
    base: 'text-foreground',
  },
};

const initialEditorConfig = {
  namespace: 'DoricConversation',
  nodes: [TurnNode, DraftNode, ComposerNode, ToolCallNode],
  onError(error: Error, _editor: LexicalEditor) {
    throw error;
  },
  theme: lexicalTheme,
} as const;

/**
 * The Thread conversation: one read-only Lexical document for the whole log.
 * User and agent turns, thinking/output drafts, tool calls, and the prompt composer
 * are DecoratorNodes in this single document.
 */
export function Conversation({
  onSandboxWrite,
  thread,
}: {
  readonly thread: Thread;
  readonly onSandboxWrite?: () => void;
}) {
  const chat = useThreadChat(thread);
  const [draft, setDraft] = useState('');
  const reported = useRef(chat.writes);

  useEffect(() => {
    if (chat.writes > reported.current) onSandboxWrite?.();
    reported.current = chat.writes;
  }, [chat.writes, onSandboxWrite]);

  const submit = () => {
    void chat.prompt(draft).then((accepted) => {
      if (accepted) setDraft('');
    });
  };

  const error = chat.sendError ?? chat.error;

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl px-5 pb-8">
          <LexicalComposer initialConfig={initialEditorConfig}>
            <RichTextPlugin
              contentEditable={<ReadOnlyConversation />}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <TurnDocument
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submit}
              sending={chat.sending}
              turns={chat.turns}
            />
          </LexicalComposer>
        </div>
      </ScrollArea>

      {error ? (
        <p className="border-t px-5 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

import { DecoratorNode, type LexicalNode, type NodeKey } from 'lexical';
import { XIcon } from 'lucide-react';
import type { JSX } from 'react';

import type { Comment } from './editing';

/** The placeholder a comment node is constructed with when Lexical probes it. */
const emptyComment: Comment = { id: '', nodeId: '', block: 0, text: '' };

/**
 * One pending comment, carried inside the answer document right under the block
 * it is about. It is a decorator node, so it is not answer text: the Markdown
 * export never sees it and the highlight offsets skip it.
 */
export class CommentNode extends DecoratorNode<JSX.Element> {
  // `remove` is a LexicalNode method, so the callback is named apart from it.
  // The first arguments carry defaults because Lexical derives a node's
  // `importJSON` from its constructor arity: a required parameter without one
  // fails editor creation. A comment never round-trips through JSON, so the
  // defaults are only there to satisfy that contract.
  constructor(
    private readonly data: Comment = emptyComment,
    private readonly onRemove: (id: string) => void = () => undefined,
    key?: NodeKey,
  ) {
    super(key);
  }

  static override getType(): string {
    return 'doric-comment';
  }

  static override clone(node: CommentNode): CommentNode {
    return new CommentNode(node.data, node.onRemove, node.__key);
  }

  override createDOM(): HTMLElement {
    const element = document.createElement('div');
    element.dataset.commentBlock = this.data.id;
    return element;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return false;
  }

  override getTextContent(): string {
    return '';
  }

  override decorate(): JSX.Element {
    const { anchor, text, id } = this.data;
    return (
      <div
        className="mt-1 flex items-start gap-2 rounded-sm border-l-2 border-muted-foreground/40 bg-secondary/30 px-3 py-1.5 text-sm leading-6 text-muted-foreground"
        contentEditable={false}
        data-comment-block={id}
      >
        <div className="min-w-0 flex-1">
          {anchor !== undefined && (
            <p className="truncate text-muted-foreground/70">
              “{anchor.quote}”
            </p>
          )}
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
        <button
          aria-label="Remove comment"
          className="shrink-0 text-muted-foreground/60 hover:text-foreground"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            this.onRemove(id);
          }}
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    );
  }
}

export const $createCommentNode = (
  comment: Comment,
  remove: (id: string) => void,
): CommentNode => new CommentNode(comment, remove);

export const $isCommentNode = (node: LexicalNode): node is CommentNode =>
  node instanceof CommentNode;

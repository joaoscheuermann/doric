/**
 * An attachment's image where its reference line stands: in the prompt the
 * reader is writing, and in a turn the transcript draws. The node is the line
 * `![name](doric-attachment:sha256-…)` as text, so `getTextContent` answers the
 * reference and the prompt sends, drafts and edits as the text it always was;
 * only what the reader sees is the image.
 *
 * It is inline, because the prompt holds its words as inline children and a
 * turn's paragraph holds its runs, and it draws as a block of its own, as wide
 * as the column at most.
 */

import {
  $createLineBreakNode,
  $createTextNode,
  DecoratorNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { JSX } from 'react';
import { attachmentLine, attachmentReference } from 'runtime/contracts';

import { ATTACHMENT_IMAGE_NODE } from '../../../../domain/conversation-nodes.js';
import { AttachmentImage } from '../../../molecules/attachment-image.js';

export type SerializedAttachmentImageNode = Spread<
  { name: string; id: string },
  SerializedLexicalNode
>;

export class AttachmentImageNode extends DecoratorNode<JSX.Element> {
  __name: string;
  __id: string;

  constructor(name: string, id: string, key?: NodeKey) {
    super(key);
    this.__name = name;
    this.__id = id;
  }

  static override getType(): string {
    return ATTACHMENT_IMAGE_NODE;
  }

  static override clone(node: AttachmentImageNode): AttachmentImageNode {
    return new AttachmentImageNode(node.__name, node.__id, node.__key);
  }

  static override importJSON(
    serialized: SerializedAttachmentImageNode,
  ): AttachmentImageNode {
    return new AttachmentImageNode(serialized.name, serialized.id);
  }

  override exportJSON(): SerializedAttachmentImageNode {
    return {
      ...super.exportJSON(),
      name: this.__name,
      id: this.__id,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('span');
    dom.className = 'my-3 block';
    return dom;
  }

  override updateDOM(): boolean {
    return false;
  }

  override isInline(): boolean {
    return true;
  }

  override getTextContent(): string {
    return attachmentReference(this.__name, this.__id);
  }

  override decorate(): JSX.Element {
    return <AttachmentImage id={this.__id} name={this.__name} />;
  }
}

export const $createAttachmentImageNode = (
  name: string,
  id: string,
): AttachmentImageNode => new AttachmentImageNode(name, id);

export const $isAttachmentImageNode = (
  node: LexicalNode | null | undefined,
): node is AttachmentImageNode => node instanceof AttachmentImageNode;

/**
 * Writes a prompt's text into the prompt block: its lines as text with line
 * breaks between them, and a line that is only a reference as its image. It is
 * the inverse of the prompt's `getTextContent`.
 */
export const $appendPromptText = (prompt: ElementNode, text: string): void => {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let pending = '';
  lines.forEach((line, index) => {
    const reference = attachmentLine(line);
    if (reference !== undefined && line === line.trim()) {
      if (pending !== '') prompt.append($createTextNode(pending));
      pending = '';
      prompt.append($createAttachmentImageNode(reference.name, reference.id));
    } else {
      pending += line;
    }
    if (index < lines.length - 1) {
      if (pending !== '') prompt.append($createTextNode(pending));
      pending = '';
      prompt.append($createLineBreakNode());
    }
  });
  if (pending !== '') prompt.append($createTextNode(pending));
};

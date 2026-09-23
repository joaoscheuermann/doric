import type { DelegatedInput } from './delegated';
import type { Comment } from './editing';
import type { ThinkingSegment, ToolSegment } from './projector';

/**
 * The conversation document's contract.
 *
 * The conversation is one Lexical document. A pure model says what it should
 * hold — turns of blocks — a pure reconciler turns two models into operations,
 * and the document host applies those operations to the editor. Nothing here
 * touches Lexical or React, so this file is the shared vocabulary of the three
 * modules that do.
 *
 * A block key is the identity a block keeps for its whole life. The keys of
 * prose blocks are the node ids `editing.ts` already uses (`userNodeId`,
 * `textNodeId`, `draftNodeId`), so a pending `Comment.nodeId` still names the
 * block it was written on and no comment has to be migrated.
 */

/** The three prose blocks: what a human reads, edits, or comments on. */
export type ProseKind = 'user' | 'agent' | 'draft';

export type ProseBlock = {
  readonly kind: ProseKind;
  readonly key: string;
  /** The prompt this block belongs to; absent for the draft. */
  readonly promptId?: string;
  /** The Markdown the block shows. A live agent block shows its revealed prefix. */
  readonly markdown: string;
  /** The projection's own text, which an edit is compared against. */
  readonly original: string;
  /** Whether the block accepts edits: the draft, or a prompt opened for editing. */
  readonly mutable: boolean;
  /** Whether a pending comment may attach here: an agent text segment. */
  readonly commentable: boolean;
  readonly dimmed: boolean;
  readonly focused: boolean;
  /** The comments mounted inside this block, under the block each is about. */
  readonly comments: readonly Comment[];
  /** Whether the typewriter is still revealing this block. */
  readonly live: boolean;
  /** Whether this block's turn reached a terminal status. */
  readonly terminal: boolean;
  /** Shown while the block is empty; only the draft has one. */
  readonly placeholder?: string;
};

/**
 * A machine block is content the caret never enters: the answer's reasoning, a
 * tool call, or the input another Thread wrote. Each variant carries exactly
 * what its existing React row needs to render.
 */
export type MachineBlock =
  | {
      readonly kind: 'thinking';
      readonly key: string;
      readonly promptId: string;
      readonly segment: ThinkingSegment;
      /** Whether the reasoning is still arriving. */
      readonly pulsing: boolean;
    }
  | {
      readonly kind: 'tool';
      readonly key: string;
      readonly promptId: string;
      readonly segment: ToolSegment;
      /** Whether this is the call the turn is waiting on. */
      readonly active: boolean;
      readonly terminal: boolean;
    }
  | {
      readonly kind: 'delegated';
      readonly key: string;
      readonly promptId: string;
      readonly delegated: DelegatedInput;
      /** The sending Thread's name, when it still resolves. */
      readonly name?: string;
    };

/** The tones a one-line notice can wear. */
export type NoticeTone = 'muted' | 'destructive' | 'sending';

/**
 * A notice is a line of explanation rather than conversation: why a prompt has
 * no answer, that a prompt's text was not recorded, that a send is in flight or
 * refused, and the subscription's own error.
 */
export type NoticeBlock = {
  readonly kind: 'notice';
  readonly key: string;
  readonly tone: NoticeTone;
  readonly text: string;
};

export type Block = ProseBlock | MachineBlock | NoticeBlock;

/**
 * A turn is one row: the band that carries its chrome, its gutter, and the
 * blocks it holds in document order.
 */
export type Turn = {
  readonly key: string;
  readonly promptId?: string;
  /** What the gutter shows: the agent's icon, or the human's reserved slot. */
  readonly role: 'user' | 'agent';
  /** Whether the row wears the band that marks what the human wrote. */
  readonly raised: boolean;
  /** Whether the gutter carries the draft's terminal marker. */
  readonly marker: boolean;
  /** Whether the row has a gutter at all; the notice rows have none. */
  readonly gutter: boolean;
  readonly blocks: readonly Block[];
};

/**
 * The whole document. `generation` rises when the document must be rebuilt from
 * scratch rather than reconciled — a send, which also discards the draft's own
 * text and every pending edit.
 */
export type DocumentModel = {
  readonly turns: readonly Turn[];
  readonly generation: number;
};

/**
 * What the model needs from the conversation's local state: everything the
 * durable projection cannot know. The document owns the text of its mutable
 * blocks, so `edits` only ever classifies them as dirty.
 */
export type LocalState = {
  readonly focus?: { readonly key: string };
  readonly edits: Readonly<Record<string, string>>;
  readonly comments: readonly Comment[];
  /** The prompts whose answer is still arriving. */
  readonly livePrompts: ReadonlySet<string>;
  /** The typewriter's visible prefix per live agent block, by block key. */
  readonly revealed: Readonly<Record<string, string>>;
  readonly sending: boolean;
  readonly sendError?: string;
  /** The Thread's lifecycle notice; it takes the draft's place. */
  readonly notice?: string;
  /** The subscription's own error. */
  readonly error?: string;
  /** Bumped when the draft's text and the pending work must be discarded. */
  readonly resetToken: number;
  /** Resolves a Thread id to its name for a delegated block. */
  readonly threadName?: (id: string) => string | undefined;
};

/** The key of the turn that holds one prompt's text. */
export const userTurnKey = (promptId: string): string => promptId;

/** The key of the turn that holds one prompt's answer. */
export const agentTurnKey = (promptId: string): string => `${promptId}:answer`;

/** The key of the draft's turn, which is also the draft block's key. */
export const draftTurnKey = 'draft';

/** The key of the row that explains the subscription's own error. */
export const errorTurnKey = 'error';

/** The key of the row that explains a stopped Thread. */
export const noticeTurnKey = 'notice';

/** The key of the reasoning block at one position in a turn's segments. */
export const thinkingBlockKey = (promptId: string, index: number): string =>
  `${promptId}:thinking:${index}`;

/** The key of the tool block for one call. */
export const toolBlockKey = (promptId: string, callId: string): string =>
  `${promptId}:tool:${callId}`;

/** The key of the block that holds another Thread's input. */
export const delegatedBlockKey = (promptId: string): string =>
  `${promptId}:delegated`;

/** The key of a notice inside a turn, named for what it explains. */
export const noticeBlockKey = (turnKey: string, name: string): string =>
  `${turnKey}:${name}`;

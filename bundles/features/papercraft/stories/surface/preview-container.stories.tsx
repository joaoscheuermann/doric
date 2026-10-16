// The whole frame of one preview, over the story host: the node in the
// conversation column and the canvas window. Everything the frame reads —
// the record, the policy, the markup, the threads of the Thread's log and
// the drafts of the composer stack — comes from `storyHost`, so the frame is
// live: drop a pin, reply, resolve, send, zoom, isolate.

import { useEffect } from 'react';

import { controllerFor } from '../../src/client/canvas-registry.js';
import {
  type PreviewChrome,
  PreviewContainer,
} from '../../src/client/surface/preview-container.js';
import {
  COMMENT_THREAD_OPEN_EVENT,
  type CommentThreadOpenDetail,
  type PreviewScope,
} from '../../src/contracts/index.js';
import { CanvasWindow, ChatColumn } from '../support/frame.js';
import { type StoryHostOptions, useStoryHost } from '../support/host.js';
import { ARTIFACT_ID, PROJECT_ID, THREAD_ID } from '../support/preview.js';

const SCOPE: PreviewScope = { projectId: PROJECT_ID, threadId: THREAD_ID };

/** How long a story waits for the host's first answers before acting. */
const SETTLE_MS = 150;

function Frame({
  chrome,
  host,
  composer,
  scope = SCOPE,
  blockRevision,
  openThread,
  armComment = false,
}: {
  readonly chrome: PreviewChrome;
  readonly host?: StoryHostOptions;
  readonly composer?: boolean;
  readonly scope?: PreviewScope | undefined;
  readonly blockRevision?: number;
  /** A thread to open once the frame read its comments. */
  readonly openThread?: string;
  /** Whether the window arms the comment tool once it read its revision. */
  readonly armComment?: boolean;
}) {
  const services = useStoryHost({
    ...host,
    ...(composer === undefined ? {} : { composer }),
  });

  // What a reader would do first: the conversation asks to see a thread, or
  // the bar's `C` arms the comment tool. One timer, cleared with the story.
  useEffect(() => {
    if (openThread === undefined && !armComment) return;

    const timer = setTimeout(() => {
      if (openThread !== undefined) {
        const detail: CommentThreadOpenDetail = {
          commentId: openThread,
          target: { kind: 'artifact', id: ARTIFACT_ID },
        };
        document.dispatchEvent(
          new CustomEvent(COMMENT_THREAD_OPEN_EVENT, { detail }),
        );
      }

      if (armComment) controllerFor(ARTIFACT_ID)?.setTool('comment');
    }, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [openThread, armComment]);

  return (
    <PreviewContainer
      services={services}
      chrome={chrome}
      scope={scope}
      artifactId={ARTIFACT_ID}
      {...(blockRevision === undefined ? {} : { blockRevision })}
    />
  );
}

export default {
  title: 'Papercraft/Surface/Preview container',
  component: PreviewContainer,
};

/**
 * The node in the conversation: the square frame of revision 2 with its
 * threads and drafts. Click it to focus it and show its controls.
 */
export const Node = {
  render: () => (
    <ChatColumn>
      <Frame chrome="node" host={{ revisions: 2 }} blockRevision={2} />
    </ChatColumn>
  ),
};

/** A preview nobody commented on yet. */
export const NodeWithoutComments = {
  render: () => (
    <ChatColumn>
      <Frame
        chrome="node"
        host={{ comments: false, drafts: false }}
        blockRevision={1}
      />
    </ChatColumn>
  ),
};

/** The revision names a module the window could not load: the markup stands in. */
export const NodeModuleFallback = {
  render: () => (
    <ChatColumn>
      <Frame
        chrome="node"
        host={{
          comments: false,
          drafts: false,
          entries: ['index.html', 'index.js'],
        }}
        blockRevision={1}
      />
    </ChatColumn>
  ),
};

/** Chat's composer is not active: there is no stack to comment into. */
export const NodeComposerUnavailable = {
  render: () => (
    <ChatColumn>
      <Frame chrome="node" composer={false} blockRevision={1} />
    </ChatColumn>
  ),
};

/** A frame without a Project scope reads nothing: an empty canvas. */
export const NodeWithoutScope = {
  render: () => (
    <ChatColumn>
      <Frame chrome="node" scope={undefined} blockRevision={1} />
    </ChatColumn>
  ),
};

/**
 * The canvas window: the tree on the left, the command bar at the bottom,
 * every pin state, and the send button for the stack's drafts.
 */
export const Canvas = {
  render: () => (
    <CanvasWindow>
      <Frame chrome="canvas" host={{ revisions: 2 }} />
    </CanvasWindow>
  ),
};

/** The thread of the pay button open beside its pin. */
export const CanvasThreadOpen = {
  render: () => (
    <CanvasWindow>
      <Frame
        chrome="canvas"
        host={{ revisions: 2 }}
        openThread="comment-pay-label"
      />
    </CanvasWindow>
  ),
};

/** The thread the agent answered last, awaiting the reader. */
export const CanvasAwaitingThreadOpen = {
  render: () => (
    <CanvasWindow>
      <Frame
        chrome="canvas"
        host={{ revisions: 2 }}
        openThread="comment-seats"
      />
    </CanvasWindow>
  ),
};

/** Comment mode armed: hover an element to see its outline and source line. */
export const CanvasCommentMode = {
  render: () => (
    <CanvasWindow>
      <Frame chrome="canvas" host={{ revisions: 2 }} armComment />
    </CanvasWindow>
  ),
};

/** Under `request`: `Autorizar` on the revision on screen. */
export const CanvasApprovalNeeded = {
  render: () => (
    <CanvasWindow>
      <Frame
        chrome="canvas"
        host={{ revisions: 3, policy: 'request', drafts: false }}
      />
    </CanvasWindow>
  ),
};

export const CanvasApproved = {
  render: () => (
    <CanvasWindow>
      <Frame
        chrome="canvas"
        host={{ revisions: 3, policy: 'request', approved: [3], drafts: false }}
      />
    </CanvasWindow>
  ),
};

/** A first revision with nothing on it yet. */
export const CanvasEmpty = {
  render: () => (
    <CanvasWindow>
      <Frame chrome="canvas" host={{ comments: false, drafts: false }} />
    </CanvasWindow>
  ),
};

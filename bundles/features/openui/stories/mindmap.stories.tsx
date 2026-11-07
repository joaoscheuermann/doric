// Every state of a MindMap in a conversation fence
// (openui-diagrams-phase2.md, Files to change): the outline while the fence
// streams, a drawn mind map and tree, maps at the 300-topic and 8-level limits
// laid out by the real layout chunk, a layout that fails, and a static older
// revision.

import type { Services } from 'bundle/contracts';

import type { ChatFence } from '../src/client/chat-contract.js';
import { layout as chunkLayout } from '../src/client/chunks/layout.js';
import { ConversationFence } from '../src/client/chunks/renderer.js';
import type {
  LayoutGraph,
  LayoutResult,
} from '../src/client/diagram/layout-types.js';
import { randomMindMapProgram } from '../tests/client/support/random-graph.js';

/** Services that accept every call and answer nothing. */
const services = {
  provide: () => ({ dispose: () => undefined }),
  use: () => ({
    sendAction: async () => ({ status: 'accepted' }),
    reportErrors: async () => undefined,
    status: async () => ({ state: 'pending' }),
    answer: async () => ({ state: 'pending' }),
  }),
  whenAvailable: () => ({ dispose: () => undefined }),
} as Services;

/** One MindMap fence of a main Thread, laid out by `layout`. */
function Fence(props: {
  readonly program: string;
  readonly state?: ChatFence['state'];
  readonly latest?: boolean;
  readonly layout?: (graph: LayoutGraph) => Promise<LayoutResult>;
}) {
  const fence: ChatFence = {
    key: 'p1/1/0',
    projectId: 'project-1',
    threadId: 'thread-1',
    promptId: 'p1',
    turnSequence: 1,
    index: 0,
    info: 'openui-lang launch-plan',
    body: props.program,
    state: props.state ?? 'closed',
  };
  return (
    <ConversationFence
      view={{ fence, origin: 'user', fences: [fence] }}
      revision={{
        key: fence.key,
        identity: 'launch-plan',
        revision: 1,
        program: props.program,
        complete: fence.state === 'closed',
        question: false,
      }}
      latest={props.latest ?? true}
      superseded={false}
      services={services}
      watchAnswers={() => () => undefined}
      layout={props.layout ?? chunkLayout}
    />
  );
}

export default {
  title: 'OpenUI/Organisms/MindMap',
  component: Fence,
};

/** F22's form: the root topic, then one statement per branch. */
const launchPlan = (layout: 'right' | 'down') =>
  [
    'root = Stack([title, map])',
    'title = TextContent("Launch plan", "large-heavy")',
    `map = MindMap(top, "${layout}")`,
    'top = Topic("Launch", [b1, b2, b3])',
    'b1 = Topic("Product", [Topic("Pricing", [Topic("Free tier"), Topic("Teams")]), Topic("Docs")])',
    'b2 = Topic("Marketing", [Topic("Blog post"), Topic("Social"), Topic("Press")])',
    'b3 = Topic("Support", [Topic("FAQ"), Topic("On-call rota")])',
    '',
  ].join('\n');

const MIND_MAP = launchPlan('right');

/** While the fence streams: the outline grows, the picture waits. */
export const Streaming = {
  render: () => (
    <Fence
      program={MIND_MAP.slice(0, MIND_MAP.indexOf('b3 = '))}
      state="streaming"
    />
  ),
};

export const MindMapRight = { render: () => <Fence program={MIND_MAP} /> };

export const TreeDown = {
  render: () => <Fence program={launchPlan('down')} />,
};

/** 300 topics in 8 levels: the limits. */
export const AtTheLimits = {
  render: () => (
    <Fence
      program={randomMindMapProgram({ topics: 300, depth: 8 }, 7919, 'right')}
    />
  ),
};

export const LayoutFailed = {
  render: () => (
    <Fence
      program={MIND_MAP}
      layout={() => Promise.reject(new Error('ELK could not lay it out'))}
    />
  ),
};

/** An older revision: fitted, with no toolbar and no gestures. */
export const Static = {
  render: () => <Fence program={MIND_MAP} latest={false} />,
};

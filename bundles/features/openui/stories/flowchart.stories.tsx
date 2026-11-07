// Every state of a Flowchart in a conversation fence (openui-diagrams.md F4,
// F7, F8): the outline while the fence streams, drawn diagrams with groups
// nested down to the limit, a diagram at the 100-node limit laid out by the
// real layout chunk, a layout that fails, and a static older revision.

import type { Services } from 'bundle/contracts';

import type { ChatFence } from '../src/client/chat-contract.js';
import { layout as chunkLayout } from '../src/client/chunks/layout.js';
import { ConversationFence } from '../src/client/chunks/renderer.js';
import type {
  LayoutGraph,
  LayoutResult,
} from '../src/client/diagram/layout-types.js';
import { randomFlowchartProgram } from '../tests/client/support/random-graph.js';

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

/** One Flowchart fence of a main Thread, laid out by `layout`. */
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
    info: 'openui-lang deploy-map',
    body: props.program,
    state: props.state ?? 'closed',
  };
  return (
    <ConversationFence
      view={{ fence, origin: 'user', fences: [fence] }}
      revision={{
        key: fence.key,
        identity: 'deploy-map',
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
  title: 'OpenUI/Organisms/Flowchart',
  component: Fence,
};

/** The concept's example (openui-diagrams.md, An example). */
const DEPLOY_MAP = [
  'root = Stack([title, chart])',
  'title = TextContent("Deployment", "large-heavy")',
  'chart = Flowchart(nodes, edges, groups, "right")',
  'groups = [Group("ci", "CI"), Group("aws", "AWS"), Group("vpc", "VPC", "aws")]',
  'nodes = [Node("git", "GitHub", "round"), Node("build", "Build", "box", "ci"), Node("test", "Test", "box", "ci"), Node("api", "API", "box", "vpc"), Node("db", "Postgres", "cylinder", "vpc")]',
  'edges = [Edge("git", "build", "push"), Edge("build", "test"), Edge("test", "api", "deploy"), Edge("api", "db")]',
  '',
].join('\n');

/** Every shape and edge style, groups nested four deep. */
const NESTED = [
  'root = Stack([chart])',
  'chart = Flowchart(nodes, edges, groups, "down")',
  'nodes = [Node("web", "Web app", "round"), Node("api", "API gateway", "box", "edge"), Node("auth", "Auth", "circle", "core"), Node("orders", "Orders", "box", "core"), Node("db", "Orders DB", "cylinder", "data"), Node("ok", "Healthy?", "diamond", "data")]',
  'groups = [Group("cloud", "Cloud"), Group("edge", "Edge", "cloud"), Group("core", "Core services", "edge"), Group("data", "Data", "core")]',
  'edges = [Edge("web", "api", "HTTPS"), Edge("api", "auth"), Edge("api", "orders"), Edge("orders", "db", "SQL", "dashed"), Edge("db", "ok", "", "solid", "none")]',
  '',
].join('\n');

/** While the fence streams: the outline grows, the picture waits. */
export const Streaming = {
  render: () => (
    <Fence
      program={DEPLOY_MAP.slice(0, DEPLOY_MAP.indexOf('Edge("test"'))}
      state="streaming"
    />
  ),
};

export const DeployMap = { render: () => <Fence program={DEPLOY_MAP} /> };

export const NestedFourDeep = { render: () => <Fence program={NESTED} /> };

/** 100 nodes, 200 edges and 25 groups four deep: the limits. */
export const AtTheLimits = {
  render: () => (
    <Fence
      program={randomFlowchartProgram(
        { nodes: 100, edges: 200, groups: 25, depth: 4 },
        7919,
      )}
    />
  ),
};

export const LayoutFailed = {
  render: () => (
    <Fence
      program={DEPLOY_MAP}
      layout={() => Promise.reject(new Error('ELK could not lay it out'))}
    />
  ),
};

/** An older revision: fitted, with no toolbar and no gestures. */
export const Static = {
  render: () => <Fence program={DEPLOY_MAP} latest={false} />,
};

// Every state of an EntityDiagram in a conversation fence
// (openui-diagrams-phase2.md, Files to change): the outline while the fence
// streams, drawn ER and class diagrams, a class diagram at the 60-entity and
// 120-relation limits laid out by the real layout chunk, a layout that fails,
// and a static older revision.

import type { Services } from 'bundle/contracts';

import type { ChatFence } from '../src/client/chat-contract.js';
import { layout as chunkLayout } from '../src/client/chunks/layout.js';
import { ConversationFence } from '../src/client/chunks/renderer.js';
import type {
  LayoutGraph,
  LayoutResult,
} from '../src/client/diagram/layout-types.js';
import { randomEntityDiagramProgram } from '../tests/client/support/random-graph.js';

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

/** One EntityDiagram fence of a main Thread, laid out by `layout`. */
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
    info: 'openui-lang shop-model',
    body: props.program,
    state: props.state ?? 'closed',
  };
  return (
    <ConversationFence
      view={{ fence, origin: 'user', fences: [fence] }}
      revision={{
        key: fence.key,
        identity: 'shop-model',
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
  title: 'OpenUI/Organisms/EntityDiagram',
  component: Fence,
};

/** Tables with every key kind and every count. */
const SHOP = [
  'root = Stack([title, model])',
  'title = TextContent("Shop", "large-heavy")',
  'model = EntityDiagram(entities, relations, "er")',
  'entities = [Entity("customer", "Customer", [Field("id", "uuid", "pk"), Field("email", "text", "unique"), Field("name", "text")]), Entity("order", "Order", [Field("id", "uuid", "pk"), Field("customer_id", "uuid", "fk"), Field("placed_at", "timestamp")]), Entity("line", "OrderLine", [Field("order_id", "uuid", "pk-fk"), Field("product_id", "uuid", "pk-fk"), Field("quantity", "int")]), Entity("product", "Product", [Field("id", "uuid", "pk"), Field("price", "numeric")]), Entity("profile", "Profile", [Field("customer_id", "uuid", "pk-fk"), Field("bio", "text")])]',
  'relations = [Relation("customer", "order", "association", "places", "1", "*"), Relation("order", "line", "association", "holds", "1", "1..*"), Relation("product", "line", "association", "", "1", "*"), Relation("customer", "profile", "association", "", "1", "0..1")]',
  '',
].join('\n');

/** Classes with methods and every relation kind. */
const CLASSES = [
  'root = Stack([model])',
  'model = EntityDiagram(entities, relations, "class")',
  'entities = [Entity("repo", "Repository", [], ["save(item): void", "find(id): Item"]), Entity("sql", "SqlRepository", [Field("pool", "Pool")], ["save(item): void", "find(id): Item"]), Entity("base", "Entity", [Field("id", "string")]), Entity("order", "Order", [Field("lines", "Line[]")], ["total(): number"]), Entity("line", "Line", [Field("quantity", "number")]), Entity("customer", "Customer", [Field("name", "string")]), Entity("logger", "Logger", [], ["info(text): void"])]',
  'relations = [Relation("sql", "repo", "implements"), Relation("order", "base", "inherits"), Relation("order", "line", "composition", "", "1", "1..*"), Relation("customer", "order", "aggregation", "orders", "1", "*"), Relation("sql", "logger", "dependency"), Relation("sql", "order", "association", "stores")]',
  '',
].join('\n');

/** While the fence streams: the outline grows, the picture waits. */
export const Streaming = {
  render: () => (
    <Fence
      program={SHOP.slice(0, SHOP.indexOf('Entity("product"'))}
      state="streaming"
    />
  ),
};

export const Shop = { render: () => <Fence program={SHOP} /> };

export const Classes = { render: () => <Fence program={CLASSES} /> };

/** 60 classes and 120 relations: the limits. */
export const AtTheLimits = {
  render: () => (
    <Fence
      program={randomEntityDiagramProgram(
        { entities: 60, relations: 120 },
        7919,
        'class',
      )}
    />
  ),
};

export const LayoutFailed = {
  render: () => (
    <Fence
      program={SHOP}
      layout={() => Promise.reject(new Error('ELK could not lay it out'))}
    />
  ),
};

/** An older revision: fitted, with no toolbar and no gestures. */
export const Static = {
  render: () => <Fence program={SHOP} latest={false} />,
};

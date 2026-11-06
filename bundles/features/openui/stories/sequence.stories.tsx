// Every state of a SequenceDiagram in a conversation fence
// (openui-diagrams-phase2.md, Files to change): the outline while the fence
// streams, drawn diagrams with nested fragments, a diagram at the 20-participant
// and 200-step limits, and a static older revision. A sequence is laid out
// without the layout chunk, so no layout can fail.

import type { Services } from 'bundle/contracts';

import type { ChatFence } from '../src/client/chat-contract.js';
import { layout as chunkLayout } from '../src/client/chunks/layout.js';
import { ConversationFence } from '../src/client/chunks/renderer.js';
import { randomSequenceProgram } from '../tests/client/support/random-graph.js';

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

/** One SequenceDiagram fence of a main Thread. */
function Fence(props: {
  readonly program: string;
  readonly state?: ChatFence['state'];
  readonly latest?: boolean;
}) {
  const fence: ChatFence = {
    key: 'p1/1/0',
    projectId: 'project-1',
    threadId: 'thread-1',
    promptId: 'p1',
    turnSequence: 1,
    index: 0,
    info: 'openui-lang login-flow',
    body: props.program,
    state: props.state ?? 'closed',
  };
  return (
    <ConversationFence
      view={{ fence, origin: 'user', fences: [fence] }}
      revision={{
        key: fence.key,
        identity: 'login-flow',
        revision: 1,
        program: props.program,
        complete: fence.state === 'closed',
        question: false,
      }}
      latest={props.latest ?? true}
      superseded={false}
      services={services}
      watchAnswers={() => () => undefined}
      layout={chunkLayout}
    />
  );
}

export default {
  title: 'OpenUI/Organisms/SequenceDiagram',
  component: Fence,
};

/** A login with every message kind, a note and an `alt` fragment. */
const LOGIN = [
  'root = Stack([title, seq])',
  'title = TextContent("Login", "large-heavy")',
  'seq = SequenceDiagram(participants, steps)',
  'participants = [Participant("browser", "Browser"), Participant("app", "Web app"), Participant("auth", "Auth server")]',
  'steps = [Message("browser", "app", "GET /login"), Message("app", "auth", "authorize", "call"), Note("Checks the session", ["auth"]), Fragment("alt", [Section("signed in", [Message("auth", "app", "code", "reply")]), Section("signed out", [Message("auth", "browser", "login form", "reply"), Message("browser", "auth", "credentials")])]), Message("app", "app", "store token"), Message("app", "browser", "redirect", "async")]',
  '',
].join('\n');

/** Fragments nested three deep, a parallel block and a loop. */
const NESTED = [
  'root = Stack([seq])',
  'seq = SequenceDiagram(participants, steps)',
  'participants = [Participant("client", "Client"), Participant("queue", "Queue"), Participant("worker", "Worker")]',
  'steps = [Fragment("loop", [Section("every job", [Message("client", "queue", "enqueue", "async"), Fragment("par", [Section("fetch", [Message("worker", "queue", "take")]), Section("report", [Fragment("opt", [Section("on failure", [Message("worker", "client", "failed", "async"), Note("Retried later", ["client", "worker"])])])])])])])]',
  '',
].join('\n');

/** While the fence streams: the outline grows inside the open fragment. */
export const Streaming = {
  render: () => (
    <Fence
      program={LOGIN.slice(0, LOGIN.indexOf('Message("browser", "auth"'))}
      state="streaming"
    />
  ),
};

export const Login = { render: () => <Fence program={LOGIN} /> };

export const NestedThreeDeep = { render: () => <Fence program={NESTED} /> };

/** 20 participants and 200 steps: the limits. */
export const AtTheLimits = {
  render: () => (
    <Fence
      program={randomSequenceProgram({ participants: 20, steps: 200 }, 7919)}
    />
  ),
};

/** An older revision: fitted, with no toolbar and no gestures. */
export const Static = {
  render: () => <Fence program={LOGIN} latest={false} />,
};

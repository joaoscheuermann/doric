// `events/v1` served by `core` over the router (S39b): the port of
// `../events.test.ts` onto `createCoreServices` and `createTestRouter`
// (without its static check of the shipped composition, which stays there).
// Payloads are `google.protobuf.Any`s of the code-built test messages; the
// stored body is the message's JSON (protobuf-es `toJson`: JSON names,
// fields at their default kept, `alwaysEmitImplicit: true`) after `type`.
// `core.event-hooks/v1` firing on a committed append is proved through
// `hooks/v1` in `./hooks.test.ts` (S40b).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  create,
  type DescMessage,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import { type Any, anyPack } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import { type CallScope, fromConnectError } from 'bundle/contracts';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';

import {
  type RoutedCore,
  type ServeCoreOptions,
  serveCore,
  testMessages,
} from '../support/router.js';

const types = testMessages();

const messageOf = (typeName: string): DescMessage => {
  const desc = types.getMessage(typeName);

  assert.ok(desc !== undefined, typeName);

  return desc;
};

const Added = messageOf('notes.Added');
const Typed = messageOf('notes.Typed');
const XSent = messageOf('notes.XSent');

const pack = (desc: DescMessage, init: Record<string, unknown>): Any =>
  anyPack(desc, create(desc, init as MessageInitShape<typeof desc>));

const added = (init: Record<string, unknown>): Any => pack(Added, init);

const scope = { projectId: 'p-1', threadId: 't-1', promptId: 'q-1' };

/** The sink a bundle registers in the same shape the runtime uses. */
const sinkSpec = {
  scopeKeys: ['projectId', 'threadId', 'promptId'],
  stream: 'notes.thread-events/{threadId}',
  scopeDescription: 'a project, a Thread and a prompt',
};

const notesProvides = ['notes.added/v1@1.0.0', 'notes.typed/v1@1.0.0'];

const served = (options: ServeCoreOptions = {}): Promise<RoutedCore> =>
  serveCore({
    bundles: { notes: notesProvides, other: [], x: ['x.sent/v1@1.0.0'] },
    ...options,
  });

const rejectsWith = async (
  promise: Promise<unknown>,
  code: string,
  check?: (message: string) => void,
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `not a ConnectError: ${error}`);

    const contract = fromConnectError(error);

    assert.equal(contract.code, code, error.message);
    check?.(contract.message);

    return true;
  });
};

/** `bundleId`'s events client, with `callScope` on every call. */
const events = (
  core: RoutedCore,
  bundleId: string,
  callScope?: CallScope,
): Client<typeof EventsService> =>
  core.client(
    EventsService,
    bundleId,
    callScope === undefined ? {} : { scope: callScope },
  );

/** `notes` with `notes.added/v1` registered and, unless `false`, its sink. */
const registered = async (
  core: RoutedCore,
  sink: typeof sinkSpec | { scopeKeys: string[]; stream: string } | false = sinkSpec,
) => {
  const notes = events(core, 'notes');

  await notes.register({ type: 'notes.added/v1', messageType: 'notes.Added' });

  if (sink !== false) {
    await notes.sink(sink);
  }

  return notes;
};

/** The platform's read of `stream`. */
const readStream = (core: RoutedCore, stream: string) =>
  core.storage('doric').read({ stream, afterSequence: 0, limit: 100 });

void test('an appended event lands in its sink stream, redacted and storable, byte for byte', async () => {
  const core = await served({
    secretsOptions: {
      rows: [{ id: 'c-1', kind: 'API_TOKEN', name: 'key', secret: 'sk-stored' }],
    },
  });

  try {
    await registered(core);
    await core
      .client(SecretsService, 'doric')
      .addRedaction({ secret: 'ghp-added' });

    await events(core, 'notes', scope).append({
      type: 'notes.added/v1',
      payload: added({
        noteId: 'n-1',
        token: 'sk-stored then ghp-added\u0000',
      }),
    });

    const page = await readStream(core, 'notes.thread-events/t-1');

    assert.equal(page.lastSequence, 1);

    const [entry] = page.entries;

    assert.ok(entry);
    assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));
    // Scope keys in sink order, then the type and the redacted, storable
    // body, as today's facade writes it.
    assert.equal(
      JSON.stringify(entry.value),
      '{"projectId":"p-1","threadId":"t-1","promptId":"q-1","type":"notes.added/v1","event":{"type":"notes.added/v1","noteId":"n-1","token":"[REDACTED] then [REDACTED]�"}}',
    );
  } finally {
    await core.close();
  }
});

void test('an append needs every key of its sink in the call scope', async () => {
  const core = await served();

  try {
    await registered(core);

    const request = {
      type: 'notes.added/v1',
      payload: added({ noteId: 'x' }),
    };
    const namesScope = (message: string) => {
      assert.ok(
        message.includes('a project, a Thread and a prompt'),
        message,
      );
    };

    await rejectsWith(
      events(core, 'notes').append(request),
      'invalid_scope',
      namesScope,
    );
    await rejectsWith(
      events(core, 'notes', { projectId: 'p-1', threadId: 't-1' }).append(
        request,
      ),
      'invalid_scope',
      namesScope,
    );
    assert.equal(
      (await readStream(core, 'notes.thread-events/t-1')).lastSequence,
      0,
    );
  } finally {
    await core.close();
  }
});

void test('an append without any sink registered is refused as an invalid scope', async () => {
  const core = await served();

  try {
    await registered(core, false);
    await rejectsWith(
      events(core, 'notes', scope).append({
        type: 'notes.added/v1',
        payload: added({ noteId: 'x' }),
      }),
      'invalid_scope',
    );
  } finally {
    await core.close();
  }
});

void test('the row keeps only the keys its sink names, in the sink order', async () => {
  const core = await served();

  try {
    await registered(core, {
      scopeKeys: ['promptId', 'threadId'],
      stream: 'notes.by-thread/{threadId}',
    });
    await events(core, 'notes', scope).append({
      type: 'notes.added/v1',
      payload: added({ noteId: 'ok' }),
    });

    const page = await readStream(core, 'notes.by-thread/t-1');

    assert.equal(
      JSON.stringify(page.entries[0]?.value),
      '{"promptId":"q-1","threadId":"t-1","type":"notes.added/v1","event":{"type":"notes.added/v1","noteId":"ok","token":""}}',
    );
  } finally {
    await core.close();
  }
});

void test('a stored body keeps a field at its default value, as the spec’s JSON rule emits implicit fields (S52a)', async () => {
  const core = await served();

  try {
    await registered(core);
    // `token` left at its default (`""`), as a `CommentsResolved` reopen
    // leaves `resolved` at `false`: the stored body still names it.
    await events(core, 'notes', scope).append({
      type: 'notes.added/v1',
      payload: added({ noteId: 'n-1', token: '' }),
    });

    const page = await readStream(core, 'notes.thread-events/t-1');
    const value = page.entries[0]?.value as
      | { readonly event?: Record<string, unknown> }
      | undefined;

    assert.deepEqual(value?.event, {
      type: 'notes.added/v1',
      noteId: 'n-1',
      token: '',
    });
  } finally {
    await core.close();
  }
});

void test('only the owner appends a registered event, and only a valid payload', async () => {
  const core = await served();

  try {
    const notes = events(core, 'notes', scope);

    await notes.sink(sinkSpec);
    await rejectsWith(
      notes.append({ type: 'notes.added/v1', payload: added({ noteId: 'x' }) }),
      'unknown_event',
    );

    await notes.register({
      type: 'notes.added/v1',
      messageType: 'notes.Added',
    });

    await rejectsWith(
      events(core, 'other', scope).append({
        type: 'notes.added/v1',
        payload: added({ noteId: 'x' }),
      }),
      'not_owner',
    );
    // A rule break (`note_id` has `min_len 1`).
    await rejectsWith(
      notes.append({ type: 'notes.added/v1', payload: added({ noteId: '' }) }),
      'invalid_input',
    );
    // An `Any` of another message.
    await rejectsWith(
      notes.append({
        type: 'notes.added/v1',
        payload: pack(Typed, { type: 'x' }),
      }),
      'invalid_input',
    );
    assert.equal(
      (await readStream(core, 'notes.thread-events/t-1')).lastSequence,
      0,
    );

    await notes.append({
      type: 'notes.added/v1',
      payload: added({ noteId: 'ok' }),
    });
    assert.equal(
      (await readStream(core, 'notes.thread-events/t-1')).lastSequence,
      1,
    );
  } finally {
    await core.close();
  }
});

void test('an event is registered once, by the bundle its namespace names and lists in provides, without a payload "type"', async () => {
  const core = await served();

  try {
    const notes = events(core, 'notes');

    await rejectsWith(
      events(core, 'other').register({
        type: 'notes.added/v1',
        messageType: 'notes.Added',
      }),
      'not_owner',
    );
    await rejectsWith(
      notes.register({ type: 'notes.typed/v1', messageType: 'notes.Typed' }),
      'invalid_input',
    );
    await rejectsWith(
      notes.register({ type: 'notes.added/v1', messageType: 'notes.Nope' }),
      'invalid_input',
    );
    // The message's option names another event type.
    await rejectsWith(
      notes.register({ type: 'notes.added/v1', messageType: 'notes.Typed' }),
      'invalid_input',
    );

    await notes.register({
      type: 'notes.added/v1',
      messageType: 'notes.Added',
    });
    await rejectsWith(
      notes.register({ type: 'notes.added/v1', messageType: 'notes.Added' }),
      'registration_conflict',
    );
  } finally {
    await core.close();
  }

  const undeclared = await serveCore({ bundles: { notes: [] } });

  try {
    await rejectsWith(
      events(undeclared, 'notes').register({
        type: 'notes.added/v1',
        messageType: 'notes.Added',
      }),
      'undeclared_provide',
    );
  } finally {
    await undeclared.close();
  }
});

void test('one event sink per events/v1 provider, and only a stream its owner names', async () => {
  const core = await served();

  try {
    const notes = events(core, 'notes');

    await rejectsWith(
      notes.sink({ scopeKeys: ['threadId'], stream: 'other.x/{threadId}' }),
      'not_owner',
    );

    const { registrationId } = await notes.sink(sinkSpec);

    await rejectsWith(notes.sink(sinkSpec), 'registration_conflict');

    await notes.unsink({ registrationId });
    await notes.sink(sinkSpec);
  } finally {
    await core.close();
  }
});

void test('a sink whose owner segment is a placeholder writes only the streams of its owner, row by row', async () => {
  const core = await served();

  try {
    // The owner is filled by the call's projectId, so the sample check passes
    // for the bundle named "x" alone; each row must still name its own owner.
    const x = events(core, 'x');

    await x.register({ type: 'x.sent/v1', messageType: 'notes.XSent' });
    await x.sink({
      scopeKeys: ['projectId', 'threadId'],
      stream: '{projectId}.x/{threadId}',
    });

    const request = { type: 'x.sent/v1', payload: pack(XSent, { text: 'x' }) };

    await rejectsWith(
      events(core, 'x', { projectId: 'runtime', threadId: 't-1' }).append(
        request,
      ),
      'not_owner',
    );
    assert.equal(
      (await readStream(core, 'runtime.x/t-1')).lastSequence,
      0,
      'a row names no stream of another owner',
    );

    await events(core, 'x', { projectId: 'x', threadId: 't-1' }).append(
      request,
    );
    assert.equal((await readStream(core, 'x.x/t-1')).lastSequence, 1);
  } finally {
    await core.close();
  }
});

void test('after Unsink or Unregister an append is invalid_scope or unknown_event; another bundle\'s id is a no-op', async () => {
  const core = await served();

  try {
    const notes = events(core, 'notes', scope);
    const other = events(core, 'other');
    const { registrationId: eventId } = await notes.register({
      type: 'notes.added/v1',
      messageType: 'notes.Added',
    });
    const { registrationId: sinkId } = await notes.sink(sinkSpec);
    const request = {
      type: 'notes.added/v1',
      payload: added({ noteId: 'ok' }),
    };

    await other.unsink({ registrationId: sinkId });
    await other.unregister({ registrationId: eventId });
    await notes.append(request);
    assert.equal(
      (await readStream(core, 'notes.thread-events/t-1')).lastSequence,
      1,
    );

    await notes.unsink({ registrationId: sinkId });
    await rejectsWith(notes.append(request), 'invalid_scope');

    await notes.sink(sinkSpec);
    await notes.unregister({ registrationId: eventId });
    await rejectsWith(notes.append(request), 'unknown_event');
  } finally {
    await core.close();
  }
});

void test("events follow the router's stamp: each generation registers its own, once, and an Unregister frees only its generation", async () => {
  const core = await served();

  try {
    const first = core.client(EventsService, 'notes', { generation: 1 });
    const second = core.client(EventsService, 'notes', { generation: 2 });
    const event = { type: 'notes.added/v1', messageType: 'notes.Added' };
    const { registrationId } = await first.register(event);

    await second.register(event);
    await first.unregister({ registrationId });

    await rejectsWith(second.register(event), 'registration_conflict');
    await first.register(event);
  } finally {
    await core.close();
  }
});

// P1 (phase 3, S58): the routed host part of `chat` answers the window's
// composer script exactly as the desktop part does. One script — the cases of
// `composer-service.test.ts`: the portrait, the author, the watch, the keying
// by Project, the `message` flush with its writes, the refused send, the
// put-back id and the reply after its root — runs against the desktop part
// booted from its build (`bootDesktop`, the bridge shapes) and against the
// host part over the test router (the wire, read back with the codec). Reads
// and flush answers are equal, watch items are equal without their revision,
// and generated ids are compared by the order they first appear in.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';

import type {
  ComposerService,
  WatchResponse,
} from '../src/contracts/gen/doric/chat/composer/v1/composer_pb.js';
import {
  ChatComposerV1,
  type ComposerAddInput,
  type ComposerFlushed,
  type ComposerItem,
  type ComposerSnapshot,
  type ComposerWatchItem,
} from '../src/contracts/index.js';
import { commentWriteOf, itemOf } from '../src/host/codec.js';
import { bootDesktop, type Desktop } from './support/desktop.js';
import { type ChatWorld, chatWorld, until } from './support/router.js';

/** The composer as the script drives it, whichever part serves it. */
interface Composer {
  read(threadId: string, projectId?: string): Promise<ComposerSnapshot>;
  /** Opens a watch; resolves once its snapshot arrived. */
  watch(threadId: string): Promise<ComposerWatchItem[]>;
  setText(threadId: string, text: string, projectId?: string): Promise<void>;
  addItem(input: ComposerAddInput): Promise<ComposerItem>;
  updateNote(threadId: string, id: string, note: string): Promise<void>;
  removeItem(threadId: string, id: string): Promise<void>;
  flush(
    threadId: string,
    promptId: string,
  ): Promise<readonly ComposerFlushed[]>;
}

const messageItem = {
  kind: 'message',
  elementTag: 'chat-comment-line',
  data: {
    target: {
      kind: 'message',
      id: 'prompt-answered',
      anchor: { form: 'range', text: 'essa resposta' },
    },
  },
  author: 'jao.scheuermann',
  note: 'essa resposta está desatualizada',
};

const previewItem = {
  kind: 'preview',
  elementTag: 'papercraft-comment-line',
  data: {
    target: { kind: 'preview', id: 'p', anchor: { form: 'point', x: 1, y: 2 } },
  },
  note: 'um pino no preview',
  author: 'jao.scheuermann',
};

/** The script: every value it read, in order, and the watches it kept open. */
const script = async (
  composer: Composer,
): Promise<{ transcript: unknown[]; watches: ComposerWatchItem[][] }> => {
  const transcript: unknown[] = [];
  const watched = await composer.watch('thread-watch');
  const flushWatch = await composer.watch('thread-flush');

  // The portrait.
  transcript.push(await composer.read('thread-one'));
  await composer.setText('thread-one', 'words to send');
  transcript.push(
    await composer.addItem({ threadId: 'thread-one', ...messageItem }),
  );
  transcript.push(await composer.read('thread-one'));

  // The author.
  const { author: _signed, ...unsigned } = messageItem;
  transcript.push(
    await composer.addItem({ threadId: 'thread-author', ...unsigned }),
  );
  transcript.push(
    await composer.addItem({
      threadId: 'thread-author',
      ...unsigned,
      author: 'ana',
    }),
  );

  // The watch.
  await composer.setText('thread-watch', 'the words');
  const added = await composer.addItem({
    threadId: 'thread-watch',
    ...messageItem,
  });
  await composer.updateNote('thread-watch', added.id, 'a better note');
  await composer.removeItem('thread-watch', added.id);

  // The keying by Project.
  await composer.setText('thread-key', 'one project', 'project-one');
  transcript.push(await composer.read('thread-key', 'project-one'));
  transcript.push(await composer.read('thread-key', 'project-two'));
  transcript.push(await composer.read('thread-key'));

  // The message flush.
  transcript.push(
    await composer.addItem({ threadId: 'thread-flush', ...messageItem }),
  );
  transcript.push(
    await composer.addItem({ threadId: 'thread-flush', ...previewItem }),
  );
  transcript.push(await composer.flush('thread-flush', 'prompt-just-accepted'));
  transcript.push(await composer.read('thread-flush'));

  // The refused send.
  transcript.push(
    await composer.addItem({ threadId: 'thread-refused', ...messageItem }),
  );
  transcript.push(await composer.read('thread-refused'));
  transcript.push(await composer.flush('thread-refused', 'prompt-accepted'));
  transcript.push(await composer.flush('thread-refused', 'prompt-accepted'));

  // The put-back id.
  transcript.push(
    await composer.addItem({ threadId: 'thread-ids', ...messageItem }),
  );
  for (const id of ['comment-sent-before', 'comment-sent-before', 'item-1']) {
    transcript.push(
      await composer.addItem({ threadId: 'thread-ids', id, ...messageItem }),
    );
  }

  // The reply after its root.
  const replyTo = (root: string, note: string): ComposerAddInput => ({
    threadId: 'thread-replies',
    ...messageItem,
    data: { ...messageItem.data, inReplyTo: root },
    note,
  });
  const root = await composer.addItem({
    threadId: 'thread-replies',
    ...messageItem,
  });
  transcript.push(root);
  transcript.push(await composer.addItem(replyTo(root.id, 'e mais isso')));
  const empty = await composer.addItem({
    threadId: 'thread-replies',
    ...messageItem,
    note: '',
  });
  transcript.push(empty);
  transcript.push(await composer.addItem(replyTo(empty.id, 'resposta')));
  transcript.push(await composer.flush('thread-replies', 'prompt-replies'));
  transcript.push(await composer.read('thread-replies'));

  return { transcript, watches: [watched, flushWatch] };
};

/** `comment-<uuid>` ids become `id-<n>` by the order they first appear in. */
const normalized = (value: unknown): JsonValue => {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value).replace(
    /comment-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (id) => {
      const known = ids.get(id) ?? `id-${ids.size + 1}`;
      ids.set(id, known);
      return known;
    },
  );
  return JSON.parse(text) as JsonValue;
};

const desktopComposer = (desktop: Desktop): Composer => {
  const scoped = (projectId?: string) =>
    projectId === undefined
      ? desktop.services.use(ChatComposerV1)
      : desktop.services.use(ChatComposerV1, { projectId });
  return {
    read: (threadId, projectId) => scoped(projectId).read({ threadId }),
    watch: (threadId) => {
      const items: ComposerWatchItem[] = [];
      scoped().watch(threadId, (item) => items.push(item));
      return Promise.resolve(items);
    },
    setText: (threadId, text, projectId) =>
      scoped(projectId).setText({ threadId, text }),
    addItem: (input) => scoped().addItem(input),
    updateNote: (threadId, id, note) =>
      scoped().updateNote({ threadId, id, note }),
    removeItem: (threadId, id) => scoped().removeItem({ threadId, id }),
    flush: (threadId, promptId) => scoped().flush({ threadId, promptId }),
  };
};

/** A wire watch item as the window's composer reads it. */
const watchItemOf = (response: WatchResponse): ComposerWatchItem => {
  const { kind } = response;
  switch (kind.case) {
    case 'snapshot':
      return {
        kind: 'snapshot',
        threadId: kind.value.threadId,
        text: kind.value.text,
        items: kind.value.items.map(itemOf),
      };
    case 'text':
      return {
        kind: 'text',
        threadId: kind.value.threadId,
        text: kind.value.text,
      };
    case 'added':
    case 'updated':
      return {
        kind: kind.case,
        threadId: kind.value.threadId,
        item: itemOf(kind.value.item ?? assert.fail('no item')),
      };
    case 'removed':
      return {
        kind: 'removed',
        threadId: kind.value.threadId,
        id: kind.value.id,
      };
    default:
      return assert.fail('a watch item without kind');
  }
};

const hostComposer = (world: ChatWorld, signal: AbortSignal): Composer => {
  const scoped = (projectId?: string): Client<typeof ComposerService> =>
    world.composer({ scope: projectId === undefined ? {} : { projectId } });
  return {
    read: async (threadId, projectId) => {
      const snapshot =
        (await scoped(projectId).read({ threadId })).composerSnapshot ??
        assert.fail('Read answered no snapshot');
      return {
        threadId: snapshot.threadId,
        text: snapshot.text,
        items: snapshot.items.map(itemOf),
      };
    },
    watch: async (threadId) => {
      const items: ComposerWatchItem[] = [];
      void (async () => {
        try {
          for await (const response of scoped().watch(
            { threadId },
            { signal },
          )) {
            items.push(watchItemOf(response));
          }
        } catch {
          // Cancelled at the end of the test.
        }
      })();
      await until(() => items.length > 0, `the snapshot of ${threadId}`);
      return items;
    },
    setText: async (threadId, text, projectId) => {
      await scoped(projectId).setText({ threadId, text });
    },
    addItem: async (input) => {
      const { data, ...rest } = input;
      const answer = await scoped().addItem({
        ...rest,
        ...(data === undefined
          ? {}
          : { data: fromJson(ValueSchema, data as JsonValue) }),
      });
      return itemOf(
        answer.composerItem ?? assert.fail('AddItem answered no item'),
      );
    },
    updateNote: async (threadId, id, note) => {
      await scoped().updateNote({ threadId, id, note });
    },
    removeItem: async (threadId, id) => {
      await scoped().removeItem({ threadId, id });
    },
    flush: async (threadId, promptId) =>
      (await scoped().flush({ threadId, promptId })).flushed.map((flushed) => ({
        item: itemOf(
          flushed.item ?? assert.fail('a flushed entry without item'),
        ),
        writes: flushed.writes.map(commentWriteOf),
      })),
  };
};

let desktop: Desktop | undefined;
let world: ChatWorld | undefined;
const watches = new AbortController();

after(async () => {
  watches.abort();
  if (world !== undefined) await world.stop();
  if (desktop !== undefined) await desktop.stop();
});

void test('P1: the routed host part answers the composer script as the desktop part does', async () => {
  desktop = await bootDesktop();
  world = chatWorld();
  await world.activate();

  const window = await script(desktopComposer(desktop));
  const routed = await script(hostComposer(world, watches.signal));

  assert.deepEqual(
    normalized(routed.transcript),
    normalized(window.transcript),
  );
  for (const [index, expected] of window.watches.entries()) {
    const seen = routed.watches[index] ?? assert.fail('a watch is missing');
    await until(() => seen.length >= expected.length, `watch ${index}`);
    assert.deepEqual(normalized(seen), normalized(expected));
  }
});

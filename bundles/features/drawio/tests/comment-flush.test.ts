// The `drawio-diagram` comment kind in chat's composer (desktopMain): when
// the send of a prompt drains the stack, the kind's flush turns each diagram
// draft into the durable `comments/v1.add` write the sender performs; a draft
// without words or without a target stays drafted. The desktop part
// registers that flush with chat's composer whenever one is available, and
// its cleanup takes the registration and the `drawio.svg/v1` service back.
//
// Contract matrix (plan §3, tests 10–12):
// - a draft with a note and a target flushes to one write (10);
// - an empty note or a missing target flushes to nothing (11);
// - activation registers the kind's flush; cleanup disposes it (12).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DesktopContext, Services } from 'bundle/contracts';

import {
  CHAT_COMMENT_LINE_TAG,
  type ComposerFlush,
  type ComposerItem,
} from '../src/contracts/chat.js';
import {
  type CommentTarget,
  type DiagramItemData,
  DRAWIO_COMMENT_KIND,
} from '../src/contracts/index.js';
import { drawioFlush } from '../src/desktop/comment-flush.js';
import { activate } from '../src/desktop/index.js';

const TARGET: CommentTarget = {
  kind: 'artifact',
  id: 'a-1',
  revision: 3,
  anchor: {
    form: 'selector',
    selector: 'page/p1/cell/c1',
    label: 'Start',
    x: 70,
    y: 50,
    cellKind: 'vertex',
    index: 0,
  },
};

const CONTEXT = { projectId: 'p1', threadId: 't1', promptId: 'q1' };

/** A stack item of the `drawio-diagram` kind. */
const itemOf = (
  note: string,
  data: unknown,
  author?: string,
): ComposerItem => ({
  id: 'comment-1',
  kind: DRAWIO_COMMENT_KIND,
  elementTag: CHAT_COMMENT_LINE_TAG,
  data,
  note,
  ...(author === undefined ? {} : { author }),
});

test('a diagram draft flushes to one comment write with its trimmed note', async () => {
  const data: DiagramItemData = {
    target: TARGET,
    pin: 1,
    inReplyTo: 'comment-root',
  };

  assert.deepEqual(await drawioFlush(itemOf('  x ', data, 'jao'), CONTEXT), [
    {
      target: TARGET,
      text: 'x',
      commentId: 'comment-1',
      inReplyTo: 'comment-root',
      author: 'jao',
    },
  ]);
});

test('a draft without words or without a target stays drafted', async () => {
  const drafts: Record<string, ComposerItem> = {
    'blank note': itemOf(' \n\t ', { target: TARGET }),
    'no target': itemOf('x', { pin: 1 }),
    'no data': itemOf('x', undefined),
  };

  for (const [name, item] of Object.entries(drafts)) {
    assert.deepEqual(await drawioFlush(item, CONTEXT), [], name);
  }
});

/**
 * The main process as the desktop part sees it: chat's composer is available,
 * and every provide, registration and their disposal are recorded.
 */
const mainWithComposer = () => {
  const provided: { id: string; disposed: boolean }[] = [];
  const registrations: {
    kind: string;
    flush: ComposerFlush;
    disposed: boolean;
  }[] = [];

  const composer = {
    registerFlush: (input: { kind: string; flush: ComposerFlush }) => {
      const registration = { ...input, disposed: false };

      registrations.push(registration);

      return {
        dispose: () => {
          registration.disposed = true;
        },
      };
    },
  };

  const services = {
    provide: (definition: { id: string }) => {
      const service = { id: definition.id, disposed: false };

      provided.push(service);

      return {
        dispose: () => {
          service.disposed = true;
        },
      };
    },
    use: (contract: { id: string }) => {
      throw new Error(`${contract.id} used during activation`);
    },
    whenAvailable: (
      contract: { id: string },
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      if (contract.id !== 'chat.composer/v1') {
        return { dispose: () => undefined };
      }

      const cleanup = callback(composer, {
        bundleId: 'chat',
        version: '1.0.0',
      });

      return {
        dispose: () => {
          if (typeof cleanup === 'function') {
            cleanup();
          }
        },
      };
    },
  } as unknown as Services;

  return { context: { services } as DesktopContext, provided, registrations };
};

test('activation registers the drawio-diagram flush; cleanup takes it and the service back', async () => {
  const main = mainWithComposer();

  const cleanup = activate(main.context);

  assert.deepEqual(
    main.registrations.map(({ kind, flush }) => ({ kind, flush })),
    [{ kind: 'drawio-diagram', flush: drawioFlush }],
  );
  assert.deepEqual(
    main.provided.map(({ id }) => id),
    ['drawio.svg/v1'],
  );

  await cleanup();

  assert.ok(main.registrations.every(({ disposed }) => disposed));
  assert.ok(main.provided.every(({ disposed }) => disposed));
});

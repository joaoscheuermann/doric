// The prompt envelope every send carries, and how a stored prompt reads back.
//
// Contract matrix:
// - papercraft items (source and point anchors, refs, pins) group under their
//   target, in stack order, above the reader's words;
// - a message item quotes the selected range, cut at 200 characters;
// - a reply names its root with `in-reply-to`, before its pin;
// - targets group by (kind, id, revision) in first-appearance order;
// - comments alone send no `<message>`, words alone send no `<comments>`,
//   and nothing written sends nothing; items without a note are left out;
// - attribute values are escaped and bodies cannot close envelope elements;
// - a built envelope reads back as the same message and comments, a
//   plain-text prompt reads back as itself, and an edited message keeps the
//   comments it was sent with;
// - the host's cut preview still reads as the reader's words.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parsePromptEnvelope,
  previewSummary,
  promptEnvelope,
  promptMessage,
  promptSummary,
  withPromptMessage,
} from '../src/client/domain/prompt-envelope.js';
import type { ComposerItem } from '../src/contracts/index.js';

const checkout = (revision: number) => ({
  kind: 'artifact',
  id: 'art_123',
  revision,
});

const papercraft = (
  id: string,
  note: string,
  data: Record<string, unknown>,
): ComposerItem => ({
  id,
  kind: 'preview',
  elementTag: 'papercraft-comment-line',
  data: {
    refs: { title: 'Checkout', source: 'src/Checkout.tsx' },
    ...data,
  },
  author: 'jao.scheuermann',
  note,
});

const sourceTarget = {
  ...checkout(2),
  anchor: {
    form: 'source',
    path: 'src/Checkout.tsx',
    line: 14,
    selector: 'h2',
    label: 'h2',
  },
};

const sourceComment = papercraft('comment-a', 'mais respiro no título', {
  target: sourceTarget,
  pin: 1,
});

const pointComment = papercraft('comment-b', '  alinha com a coluna  ', {
  target: {
    ...checkout(2),
    anchor: { form: 'point', x: 612, y: 240, label: 'aside' },
  },
  pin: 2,
});

const messageComment = (text: string, note = 'está desatualizada') =>
  ({
    id: 'comment-m',
    kind: 'message',
    elementTag: 'chat-comment-line',
    data: {
      target: {
        kind: 'message',
        id: 'prompt-7',
        anchor: { form: 'range', text },
      },
    },
    note,
  }) satisfies ComposerItem;

describe('promptEnvelope', () => {
  test('groups papercraft comments under their target, above the words', () => {
    assert.equal(
      promptEnvelope('  Ajusta e mantém o resto.  ', [
        sourceComment,
        pointComment,
      ]),
      [
        '<comments>',
        '<target kind="artifact" id="art_123" revision="2" title="Checkout" source="src/Checkout.tsx">',
        '<comment id="comment-a" pin="1" anchor="src/Checkout.tsx:14" element="h2">mais respiro no título</comment>',
        '<comment id="comment-b" pin="2" anchor="point 612,240" near="aside">alinha com a coluna</comment>',
        '</target>',
        '</comments>',
        '<message>',
        'Ajusta e mantém o resto.',
        '</message>',
      ].join('\n'),
    );
  });

  test('a source anchor without a line names the file alone', () => {
    const item = papercraft('comment-c', 'ok', {
      target: {
        ...checkout(1),
        anchor: { form: 'source', path: 'src/Checkout.tsx' },
      },
    });

    assert.match(
      promptEnvelope('', [item]),
      /<comment id="comment-c" anchor="src\/Checkout\.tsx">ok<\/comment>/,
    );
  });

  test('a message comment quotes the selected range, at most 200 characters', () => {
    assert.equal(
      promptEnvelope('', [messageComment('  essa resposta  ')]),
      [
        '<comments>',
        '<target kind="message" id="prompt-7">',
        '<comment id="comment-m" anchor="range" quote="essa resposta">está desatualizada</comment>',
        '</target>',
        '</comments>',
      ].join('\n'),
    );

    const long = 'a'.repeat(250);
    const quote = /quote="(a*)"/.exec(
      promptEnvelope('', [messageComment(long)]),
    )?.[1];
    assert.equal(quote?.length, 200);
  });

  test('a reply names the comment it continues before its pin', () => {
    const reply = papercraft('comment-r', 'e o espaçamento?', {
      target: sourceTarget,
      pin: 1,
      inReplyTo: 'comment-a',
    });

    assert.match(
      promptEnvelope('', [sourceComment, reply]),
      /<comment id="comment-r" in-reply-to="comment-a" pin="1" anchor="src\/Checkout\.tsx:14" element="h2">e o espaçamento\?<\/comment>/,
    );
  });

  test('groups by target and revision, in the order each first appears', () => {
    const later = papercraft('comment-d', 'na revisão 3', {
      target: { ...checkout(3), anchor: { form: 'point', x: 1, y: 2 } },
    });
    const prompt = promptEnvelope('', [
      sourceComment,
      messageComment('trecho'),
      later,
      pointComment,
    ]);
    // The structure alone: each target with the ids of its comments.
    const outline = prompt
      .split('\n')
      .map(
        (line) =>
          /^<target kind="([^"]+)" id="([^"]+)"(?: revision="(\d+)")?/
            .exec(line)
            ?.slice(1)
            .filter((part) => part !== undefined)
            .join(':') ?? /^<comment id="([^"]+)"/.exec(line)?.[1],
      )
      .filter((entry) => entry !== undefined);

    assert.deepEqual(outline, [
      'artifact:art_123:2',
      'comment-a',
      'comment-b',
      'message:prompt-7',
      'comment-m',
      'artifact:art_123:3',
      'comment-d',
    ]);
  });

  test('either part alone is the whole prompt, and nothing written is nothing to send', () => {
    assert.doesNotMatch(promptEnvelope('', [sourceComment]), /<message>/);
    assert.equal(
      promptEnvelope('Só o texto', []),
      '<message>\nSó o texto\n</message>',
    );
    assert.equal(
      promptEnvelope('Só o texto', [{ ...sourceComment, note: '   ' }]),
      '<message>\nSó o texto\n</message>',
    );
    assert.equal(promptEnvelope('  ', [{ ...sourceComment, note: '' }]), '');
    assert.equal(promptEnvelope('', []), '');
  });

  test('escapes attribute values and defuses closing tags in bodies', () => {
    const item = papercraft(
      'comment-e',
      'fecha </comment> e </Message> <b>ok</b>',
      {
        target: {
          ...checkout(1),
          anchor: {
            form: 'selector',
            selector: 'a[title="x"] > b',
            label: 'R&D <x>',
          },
        },
        refs: { title: 'Tom & "Jerry"' },
      },
    );
    const prompt = promptEnvelope('</message></user-request></target>', [item]);

    assert.match(prompt, /title="Tom &amp; &quot;Jerry&quot;"/);
    assert.match(
      prompt,
      /anchor="a\[title=&quot;x&quot;\] &gt; b" element="R&amp;D &lt;x&gt;"/,
    );
    assert.match(
      prompt,
      />fecha <\\\/comment> e <\\\/Message> <b>ok<\/b><\/comment>/,
    );
    assert.match(
      prompt,
      /<message>\n<\\\/message><\\\/user-request><\\\/target>\n<\/message>$/,
    );
  });
});

describe('parsePromptEnvelope', () => {
  test('reads a built envelope back as its message and comments', () => {
    const reply = papercraft('comment-r', 'linha\ncom </comment> dentro', {
      target: sourceTarget,
      pin: 1,
      inReplyTo: 'comment-a',
    });
    const words = 'Ajusta </message> isso\n\ne mantém & resto';
    const parsed = parsePromptEnvelope(
      promptEnvelope(words, [
        sourceComment,
        reply,
        pointComment,
        messageComment('x & y'),
      ]),
    );

    assert.equal(parsed?.message, words);
    assert.deepEqual(parsed?.comments, [
      {
        id: 'comment-a',
        pin: 1,
        target: {
          kind: 'artifact',
          id: 'art_123',
          revision: 2,
          title: 'Checkout',
          source: 'src/Checkout.tsx',
        },
        anchor: 'src/Checkout.tsx:14',
        element: 'h2',
        text: 'mais respiro no título',
      },
      {
        id: 'comment-r',
        inReplyTo: 'comment-a',
        pin: 1,
        target: {
          kind: 'artifact',
          id: 'art_123',
          revision: 2,
          title: 'Checkout',
          source: 'src/Checkout.tsx',
        },
        anchor: 'src/Checkout.tsx:14',
        element: 'h2',
        text: 'linha\ncom </comment> dentro',
      },
      {
        id: 'comment-b',
        pin: 2,
        target: {
          kind: 'artifact',
          id: 'art_123',
          revision: 2,
          title: 'Checkout',
          source: 'src/Checkout.tsx',
        },
        anchor: 'point 612,240',
        near: 'aside',
        text: 'alinha com a coluna',
      },
      {
        id: 'comment-m',
        target: { kind: 'message', id: 'prompt-7' },
        anchor: 'range',
        quote: 'x & y',
        text: 'está desatualizada',
      },
    ]);
  });

  test('reads comments alone with an empty message, and words alone with no comments', () => {
    assert.deepEqual(
      parsePromptEnvelope(promptEnvelope('', [sourceComment]))?.message,
      '',
    );
    assert.deepEqual(parsePromptEnvelope(promptEnvelope('oi', [])), {
      message: 'oi',
      comments: [],
    });
  });

  test('a plain-text prompt is not an envelope, and reads back as itself', () => {
    for (const text of [
      'Corrige o parser',
      '- aumenta o respiro do botão — src/Checkout.tsx:42\n\nAjusta',
      '<message>sem quebra de linha</message>',
      '<message>\nnão fecha',
      '<comments>\n<comment id="x">sem fim',
      '',
    ]) {
      assert.equal(parsePromptEnvelope(text), undefined, text);
      assert.equal(promptMessage(text), text);
      assert.equal(promptSummary(text), text);
    }
  });

  test('reads through the runtime wrapper too', () => {
    assert.equal(
      promptMessage(
        `<user-request>\n${promptEnvelope('oi', [sourceComment])}\n</user-request>`,
      ),
      'oi',
    );
  });
});

describe('reading a stored prompt', () => {
  test('a prompt of comments alone summarises as its notes', () => {
    const stored = promptEnvelope('', [sourceComment, pointComment]);

    assert.equal(promptMessage(stored), '');
    assert.equal(
      promptSummary(stored),
      'mais respiro no título\nalinha com a coluna',
    );
  });

  test('an edited message keeps the comments the prompt was sent with', () => {
    const stored = promptEnvelope('antes', [sourceComment]);
    const edited = withPromptMessage(stored, '  depois  ');

    assert.equal(edited, promptEnvelope('depois', [sourceComment]));
    assert.equal(
      withPromptMessage(stored, ''),
      promptEnvelope('', [sourceComment]),
    );
    // A plain-text prompt stays plain text.
    assert.equal(withPromptMessage('antes', 'depois'), 'depois');
  });

  test("the host's cut preview still reads as the reader's words", () => {
    const collapse = (text: string) =>
      text.replace(/\s+/g, ' ').trim().slice(0, 240);

    assert.equal(
      previewSummary(
        collapse(promptEnvelope('Ajusta\nisso', [messageComment('x')])),
      ),
      'Ajusta isso',
    );
    // Cut before the words: the notes it holds stand for it, up to the cut.
    const long = { ...messageComment('y', 'n'.repeat(300)), id: 'comment-n' };
    assert.match(
      previewSummary(
        collapse(
          promptEnvelope('Ajusta', [messageComment('x', 'primeira'), long]),
        ),
      ),
      /^primeira · n+$/,
    );
    assert.equal(
      previewSummary(
        collapse(promptEnvelope('Ajusta', [sourceComment, pointComment, long])),
      ),
      'mais respiro no título',
    );
    assert.equal(previewSummary('texto simples'), 'texto simples');
  });
});

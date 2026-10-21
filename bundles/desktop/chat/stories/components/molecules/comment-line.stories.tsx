import { CommentLine } from '../../../src/client/components/molecules/comment-line.js';
import { commentExcerpt } from '../../../src/client/domain/comment-excerpt.js';

const target = {
  kind: 'artifact',
  id: 'checkout-1',
  revision: 3,
  title: 'Checkout',
  source: 'src/components/Checkout.tsx',
};

/** The target of a comment on words of the agent's answer. */
const message = (text: string) => ({
  kind: 'message',
  id: 'a0000000-0000-4000-8000-000000001001',
  anchor: { form: 'range', text },
});

/** The answer's paragraph those words are in. */
const paragraph =
  'I see the placeholder text and a photo of an orange kitten. Are you testing messages and comments, or do you want me to change the checkout?';

export default {
  title: 'Chat/Molecules/Comment line',
  component: CommentLine,
};

/**
 * The passage in its paragraph, the selected words highlighted; hovering the
 * card (or tabbing into it) shows the arrow that goes to the passage.
 */
export const InContext = {
  render: () => (
    <CommentLine
      item={{
        note: 'Is it still there in dark mode?',
        target: message('of an orange'),
        pin: 1,
      }}
      excerpt={commentExcerpt(message('of an orange'), paragraph)}
      onGo={() => undefined}
    />
  ),
};

/** Words late in a long paragraph: the context before them is cut short. */
export const LateInTheParagraph = {
  render: () => (
    <CommentLine
      item={{ note: 'Change the checkout too', pin: 2 }}
      excerpt={commentExcerpt(message('change the checkout'), paragraph)}
    />
  ),
};

/** The transcript no longer draws the paragraph: the quote stands alone. */
export const QuoteAlone = {
  render: () => (
    <CommentLine
      item={{ note: 'Say “Pay now” instead', pin: 4 }}
      excerpt={commentExcerpt(message('Complete purchase'))}
    />
  ),
};

export const Reply = {
  render: () => (
    <CommentLine
      item={{
        author: 'Agent',
        note: 'Fixed: the button now uses the primary token.',
        pin: 1,
        reply: true,
      }}
      excerpt={commentExcerpt(message('of an orange'), paragraph)}
    />
  ),
};

export const EmptyNote = {
  render: () => <CommentLine item={{ note: '', target, pin: 2 }} />,
};

export const LongNote = {
  render: () => (
    <CommentLine
      item={{
        note: 'This section should have 8px of breathing room between the header and the list, and the list items should align with the title baseline.',
        pin: 3,
      }}
      excerpt={commentExcerpt(message('photo'), paragraph)}
    />
  ),
};

const anchored = (line: number, label: string) => ({
  ...target,
  anchor: {
    form: 'element',
    selector: label,
    path: 'src/components/Checkout.tsx',
    line,
    label,
  },
});

/** An element's comment quotes nothing: its anchor label is the context. */
export const Anchored = {
  render: () => (
    <CommentLine
      item={{
        note: 'The primary button disappears in dark mode',
        target: anchored(42, 'button'),
        pin: 1,
      }}
      excerpt={commentExcerpt(anchored(42, 'button'))}
    />
  ),
};

export const OtherAuthor = {
  render: () => (
    <CommentLine
      item={{
        author: 'Marina Costa',
        note: 'Can we keep the old copy for the EU storefront?',
        pin: 5,
      }}
      excerpt={commentExcerpt(anchored(51, 'p'))}
    />
  ),
};

export const Stack = {
  render: () => (
    <div className="flex flex-col gap-1.5">
      <CommentLine
        item={{ note: 'Is it still there in dark mode?', pin: 1 }}
        excerpt={commentExcerpt(message('of an orange'), paragraph)}
      />
      <CommentLine
        item={{ note: 'Title and list need 8px between them', pin: 2 }}
        excerpt={commentExcerpt(anchored(18, 'h2'))}
      />
      <CommentLine
        item={{
          author: 'Agent',
          note: 'Should the gap be 8px on mobile too?',
          pin: 2,
          reply: true,
        }}
        excerpt={commentExcerpt(anchored(18, 'h2'))}
      />
    </div>
  ),
};

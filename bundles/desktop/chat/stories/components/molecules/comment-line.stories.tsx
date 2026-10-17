import { CommentLine } from '../../../src/client/components/molecules/comment-line.js';

const target = {
  kind: 'artifact',
  id: 'checkout-1',
  revision: 3,
  title: 'Checkout',
  source: 'src/components/Checkout.tsx',
};

export default {
  title: 'Chat/Molecules/Comment line',
  component: CommentLine,
};

export const Draft = {
  render: () => (
    <CommentLine
      item={{
        note: 'The primary button disappears in dark mode',
        target,
        pin: 1,
      }}
    />
  ),
};

export const Reply = {
  render: () => (
    <CommentLine
      item={{
        author: 'Agent',
        note: 'Fixed: the button now uses the primary token.',
        target,
        pin: 1,
        reply: true,
      }}
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
        target,
        pin: 3,
      }}
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

export const Anchored = {
  render: () => (
    <CommentLine
      item={{
        note: 'The primary button disappears in dark mode',
        target: anchored(42, 'button'),
        pin: 1,
      }}
    />
  ),
};

export const SelectedTextAnchor = {
  render: () => (
    <CommentLine
      item={{
        note: 'Say “Pay now” instead',
        target: {
          ...target,
          anchor: { form: 'text', text: 'Complete purchase' },
        },
        pin: 4,
      }}
    />
  ),
};

export const WithStateMarker = {
  render: () => (
    <CommentLine
      item={{
        note: 'Title and list need 8px between them',
        target: anchored(18, 'h2'),
        pin: 2,
      }}
      end={
        <span className="text-(color:--paper-green)" title="resolved">
          ✓
        </span>
      }
    />
  ),
};

export const OtherAuthor = {
  render: () => (
    <CommentLine
      item={{
        author: 'Marina Costa',
        note: 'Can we keep the old copy for the EU storefront?',
        target: anchored(51, 'p'),
        pin: 5,
      }}
    />
  ),
};

export const Stack = {
  render: () => (
    <div className="flex flex-col">
      <CommentLine
        item={{
          note: 'The primary button disappears in dark mode',
          target: anchored(42, 'button'),
          pin: 1,
        }}
      />
      <CommentLine
        item={{
          note: 'Title and list need 8px between them',
          target: anchored(18, 'h2'),
          pin: 2,
        }}
      />
      <CommentLine
        item={{
          author: 'Agent',
          note: 'Should the gap be 8px on mobile too?',
          target: anchored(18, 'h2'),
          pin: 2,
          reply: true,
        }}
      />
    </div>
  ),
};

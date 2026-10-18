import { Button } from 'desktop/ui/button';
import { SquareIcon } from 'lucide-react';

import { CollapsibleBlock } from '../../../src/client/components/molecules/collapsible-block.js';
import { WithChosen } from '../../support/chosen.js';

const detail = (
  <div className="flex flex-col gap-1.5">
    <div>Read src/components/Checkout.tsx</div>
    <div>Searched for “bg-white” in src</div>
    <div>Edited src/components/Checkout.tsx</div>
  </div>
);

export default {
  title: 'Chat/Molecules/Collapsible block',
  component: CollapsibleBlock,
};

export const Settled = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={<span className="font-normal">Thought, called 3 tools</span>}
          openness={{ active: false, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          {detail}
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const InProgress = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={<span className="font-normal">Thinking</span>}
          openness={{ active: true, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          I need a route, a page component and a paginated query.
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const OpenedByReader = {
  render: () => (
    <WithChosen initial>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={<span className="font-normal">Thought, called 3 tools</span>}
          openness={{ active: false, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          {detail}
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const Focused = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          focused
          label={<span className="font-normal">Thought</span>}
          openness={{ active: false, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          The caret's stop wears the hover style.
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const WithoutGuide = {
  render: () => (
    <WithChosen initial>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          guide={false}
          label={<span className="font-normal">Ran npm test</span>}
          openness={{ active: false, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          <div className="rounded-md border border-border bg-card/50 px-3 py-2 font-mono">
            Tests 10 passed (10)
          </div>
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const WithTrailingControl = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={<span className="font-normal">Running npm run dev</span>}
          openness={{ active: true, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
          trailing={
            <Button size="icon-xs" variant="ghost" aria-label="Stop">
              <SquareIcon className="fill-current" />
            </Button>
          }
        >
          <pre className="font-mono">VITE v6.0.3 ready in 412 ms</pre>
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const WithHeaderAction = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={<span className="font-normal">Agent replied</span>}
          action={{
            content: (
              <Button size="xs" variant="link" className="h-auto px-0">
                Checkout.tsx:42
              </Button>
            ),
            toggleLabel: 'Show the reply',
          }}
          openness={{ active: false, hasContent: true, defaultOpen: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          Fixed: the button now uses the primary token.
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const EmptyWhileInProgress = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={<span className="font-normal">Calling Search files</span>}
          openness={{ active: true, hasContent: false }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          {null}
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

export const LongLabel = {
  render: () => (
    <WithChosen>
      {(chosen, onChosenChange) => (
        <CollapsibleBlock
          label={
            <span className="truncate font-normal">
              Ran npx playwright test e2e/checkout.spec.ts --project=chromium
              --reporter=line --retries=2 --workers=4
            </span>
          }
          openness={{ active: false, hasContent: true }}
          chosen={chosen}
          onChosenChange={onChosenChange}
        >
          6 passed (14.2s)
        </CollapsibleBlock>
      )}
    </WithChosen>
  ),
};

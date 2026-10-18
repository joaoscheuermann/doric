import { createElement } from 'react';

import { defineUsageElements } from '../src/client/elements.js';
import { footerDecorator } from './support/footer.js';
import { createStoryQueryClient } from './support/query.js';
import {
  fixtureUsage,
  partiallyPricedUsage,
  summaryServices,
} from './support/usage.js';

type Services = ReturnType<typeof summaryServices>;

/**
 * `<usage-summary>` as the activation defines it, under a tag of its own
 * per story (a custom element class keeps the query client it was defined
 * with), with the window's services set as a property.
 */
const summaryTag = (name: string): string => {
  const tag = `usage-summary-story-${name}`;
  if (customElements.get(tag) === undefined) {
    customElements.define(
      tag,
      defineUsageElements(createStoryQueryClient()).summary,
    );
  }
  return tag;
};

function SummaryElement({
  name,
  services,
}: {
  readonly name: string;
  readonly services: Services;
}) {
  return createElement(summaryTag(name), {
    ref: (element: (HTMLElement & { services?: Services }) | null) => {
      if (element !== null) element.services = services;
    },
  });
}

export default {
  title: 'Usage/Elements/Usage summary element',
  decorators: [footerDecorator],
};

export const Summary = {
  render: () => <SummaryElement name="default" services={summaryServices()} />,
};

export const PartialCost = {
  render: () => (
    <SummaryElement
      name="partial-cost"
      services={summaryServices({
        usage: fixtureUsage({ usage: partiallyPricedUsage }),
      })}
    />
  ),
};

export const WithoutUsageProvider = {
  render: () => (
    <SummaryElement
      name="without-usage"
      services={summaryServices({ usage: null })}
    />
  ),
};

import { createElement } from 'react';

import { defineResourcesElements } from '../src/client/elements.js';
import { createStoryQueryClient } from './support/query.js';
import { readyProject, saturatedContainer } from './support/resources.js';
import { monitorServices } from './support/workspace.js';

type Services = ReturnType<typeof monitorServices>;

/**
 * `<resources-monitor>` as the activation defines it, under a tag of its
 * own per story (a custom element class keeps the query client it was
 * defined with), with the window's services set as a property.
 */
const monitorTag = (name: string): string => {
  const tag = `resources-monitor-story-${name}`;
  if (customElements.get(tag) === undefined) {
    customElements.define(
      tag,
      defineResourcesElements(createStoryQueryClient()).monitor,
    );
  }
  return tag;
};

function MonitorElement({
  name,
  services,
}: {
  readonly name: string;
  readonly services: Services;
}) {
  return createElement(monitorTag(name), {
    ref: (element: (HTMLElement & { services?: Services }) | null) => {
      if (element !== null) element.services = services;
    },
  });
}

export default {
  title: 'Resources/Elements/Resources monitor element',
};

export const Monitor = {
  render: () => <MonitorElement name="default" services={monitorServices()} />,
};

export const MemoryWarning = {
  render: () => (
    <MonitorElement
      name="memory-warning"
      services={monitorServices({
        project: () => readyProject(saturatedContainer()),
      })}
    />
  ),
};

export const WithoutLayout = {
  render: () => (
    <MonitorElement
      name="without-layout"
      services={monitorServices({ workspace: null })}
    />
  ),
};

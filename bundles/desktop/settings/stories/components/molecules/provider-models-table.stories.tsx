import { useState } from 'react';

import { ProviderModelsTable } from '../../../src/client/components/molecules/provider-models-table.js';
import type {
  CatalogModel,
  ProviderModel,
} from '../../../src/client/domain/config.js';
import { largeCatalog, openRouterCatalog } from '../../support/fixtures.js';
import { sectionFrame } from '../../support/frames.js';

/** The table with its own offered list, so a tick adds or removes a model. */
function Table({
  catalog = openRouterCatalog,
  initial = [
    { name: 'anthropic/claude-sonnet-4.5', reasonings: [] },
    { name: 'deepseek/deepseek-v3.2', reasonings: [] },
  ],
  loading = false,
}: {
  readonly catalog?: readonly CatalogModel[];
  readonly initial?: readonly ProviderModel[];
  readonly loading?: boolean;
}) {
  const [offered, setOffered] = useState(initial);

  return (
    <ProviderModelsTable
      catalog={catalog}
      loading={loading}
      offered={offered}
      onPick={(id, picked) =>
        setOffered((current) =>
          picked
            ? current.some(({ name }) => name === id)
              ? current
              : [...current, { name: id, reasonings: [] }]
            : current.filter(({ name }) => name !== id),
        )
      }
    />
  );
}

export default {
  title: 'Settings/Molecules/Provider models table',
  component: ProviderModelsTable,
  decorators: [sectionFrame],
};

export const Default = {
  render: () => <Table />,
};

export const NothingOffered = {
  render: () => <Table initial={[]} />,
};

export const NotInTheCatalog = {
  render: () => (
    <Table
      initial={[
        { name: 'anthropic/claude-sonnet-4.5', reasonings: [] },
        { name: 'internal/fine-tuned-coder', reasonings: ['low', 'high'] },
      ]}
    />
  ),
};

export const ManyPages = {
  render: () => <Table catalog={largeCatalog} />,
};

export const Loading = {
  render: () => <Table catalog={[]} initial={[]} loading />,
};

export const EmptyCatalog = {
  render: () => <Table catalog={[]} initial={[]} />,
};

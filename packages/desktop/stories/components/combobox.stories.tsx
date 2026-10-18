import { Button } from 'desktop/ui/button';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
} from 'desktop/ui/combobox';
import { Fragment } from 'react';

import { models, type ProjectFixture, projects } from '../support/doric.js';

export default {
  title: 'desktop/ui/Combobox',
  component: Combobox,
};

type Model = (typeof models)[number];

const ModelList = () => (
  <ComboboxList>
    {(model: Model) => (
      <ComboboxItem key={model.id} value={model}>
        {model.label}
      </ComboboxItem>
    )}
  </ComboboxList>
);

export const Open = {
  render: () => (
    <div className="h-72">
      <Combobox
        items={models}
        itemToStringValue={(model: Model) => model.label}
        defaultValue={models[1]}
        defaultOpen
      >
        <ComboboxInput placeholder="Choose a model" className="w-64" />
        <ComboboxContent>
          <ComboboxEmpty>No model matches.</ComboboxEmpty>
          <ModelList />
        </ComboboxContent>
      </Combobox>
    </div>
  ),
};

export const Empty = {
  render: () => (
    <div className="h-40">
      <Combobox
        items={models}
        itemToStringValue={(model: Model) => model.label}
        defaultInputValue="llama"
        defaultOpen
      >
        <ComboboxInput placeholder="Choose a model" className="w-64" />
        <ComboboxContent>
          <ComboboxEmpty>No model matches.</ComboboxEmpty>
          <ModelList />
        </ComboboxContent>
      </Combobox>
    </div>
  ),
};

const grouped = [
  {
    value: 'Anthropic',
    items: models.filter((model) => model.provider === 'Anthropic'),
  },
  {
    value: 'OpenAI',
    items: models.filter((model) => model.provider === 'OpenAI'),
  },
];

export const Grouped = {
  render: () => (
    <div className="h-80">
      <Combobox
        items={grouped}
        itemToStringValue={(model: Model) => model.label}
        defaultOpen
      >
        <ComboboxInput
          placeholder="Choose a model"
          className="w-64"
          showClear
        />
        <ComboboxContent>
          <ComboboxEmpty>No model matches.</ComboboxEmpty>
          <ComboboxList>
            {(group: (typeof grouped)[number], index: number) => (
              <Fragment key={group.value}>
                {index > 0 && <ComboboxSeparator />}
                <ComboboxGroup items={group.items}>
                  <ComboboxLabel>{group.value}</ComboboxLabel>
                  <ComboboxCollection>
                    {(model: Model) => (
                      <ComboboxItem key={model.id} value={model}>
                        {model.label}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              </Fragment>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  ),
};

const ProjectChips = () => {
  const anchor = useComboboxAnchor();
  return (
    <Combobox
      multiple
      items={projects}
      itemToStringValue={(project: ProjectFixture) => project.name}
      defaultValue={[projects[0], projects[2]]}
      defaultOpen
    >
      <ComboboxChips ref={anchor} className="w-80">
        <ComboboxValue>
          {(values: ProjectFixture[]) => (
            <>
              {values.map((project) => (
                <ComboboxChip key={project.id}>{project.name}</ComboboxChip>
              ))}
              <ComboboxChipsInput placeholder="Add a Project" />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No Project matches.</ComboboxEmpty>
        <ComboboxList>
          {(project: ProjectFixture) => (
            <ComboboxItem key={project.id} value={project}>
              {project.name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};

export const Chips = {
  render: () => (
    <div className="h-72">
      <ProjectChips />
    </div>
  ),
};

export const ButtonTrigger = {
  render: () => (
    <div className="h-72">
      <Combobox
        items={projects}
        itemToStringValue={(project: ProjectFixture) => project.name}
        defaultValue={projects[0]}
        defaultOpen
      >
        <ComboboxTrigger
          render={<Button variant="outline" className="w-56 justify-between" />}
        >
          <ComboboxValue />
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxEmpty>No Project matches.</ComboboxEmpty>
          <ComboboxList>
            {(project: ProjectFixture) => (
              <ComboboxItem key={project.id} value={project}>
                {project.name}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  ),
};

export const Disabled = {
  render: () => (
    <Combobox
      items={models}
      itemToStringValue={(model: Model) => model.label}
      defaultValue={models[0]}
      disabled
    >
      <ComboboxInput placeholder="Choose a model" className="w-64" disabled />
      <ComboboxContent>
        <ModelList />
      </ComboboxContent>
    </Combobox>
  ),
};

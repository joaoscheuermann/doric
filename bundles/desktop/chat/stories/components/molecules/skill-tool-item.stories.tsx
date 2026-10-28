import type { ComponentProps } from 'react';

import { SkillToolItem } from '../../../src/client/components/molecules/skill-tool-item.js';
import { WithChosen } from '../../support/chosen.js';

type Props = Omit<
  ComponentProps<typeof SkillToolItem>,
  'chosen' | 'onChosenChange'
>;

function Skill({
  initial = null,
  ...props
}: Props & { readonly initial?: boolean | null }) {
  return (
    <WithChosen initial={initial}>
      {(chosen, onChosenChange) => (
        <SkillToolItem
          {...props}
          chosen={chosen}
          onChosenChange={onChosenChange}
        />
      )}
    </WithChosen>
  );
}

const skillArgs = (name: string): string => JSON.stringify({ name });

const builtInResult = `# Skill: git-cloning

## Purpose

Create a usable local repository from a remote without overwriting existing workspace content or exposing credentials.

## Procedure

1. Inspect the destination and stop if cloning would overwrite or mix with existing content.
2. Run \`git\` with \`clone\`, an explicit remote URL, and an explicit destination.`;

const workspaceResult = `# Skill: cwd/behavioral-testing

# Behavioral Testing

Write tests from the public behavior a caller relies on, not from the implementation.
Read references/case-selection.md before choosing cases.`;

const mcpResult = `# Skill: mcp/acme/refunds

# Refunds

1. Look up the invoice with mcp__acme__get_invoice.
2. Issue the credit note for the amount the customer disputes.`;

export default {
  title: 'Chat/Molecules/Skill tool item',
  component: SkillToolItem,
};

export const Loading = {
  render: () => <Skill args={skillArgs('git-cloning')} status="running" />,
};

export const Loaded = {
  render: () => (
    <Skill
      args={skillArgs('git-cloning')}
      result={builtInResult}
      status="finished"
    />
  ),
};

export const LoadedWorkspaceOpened = {
  render: () => (
    <Skill
      args={skillArgs('cwd/behavioral-testing')}
      result={workspaceResult}
      status="finished"
      initial
    />
  ),
};

export const Mcp = {
  render: () => (
    <Skill
      args={skillArgs('mcp/acme/refunds')}
      result={mcpResult}
      status="finished"
      initial
    />
  ),
};

export const Failed = {
  render: () => (
    <Skill
      args={skillArgs('cwd/missing-skill')}
      error="No skill is named cwd/missing-skill."
      status="failed"
    />
  ),
};

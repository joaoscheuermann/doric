import { ChangeCounts } from '../../src/client/changes/change-counts.js';

export default {
  title: 'Git/Changes/Change counts',
  component: ChangeCounts,
};

export const Changed = {
  render: () => <ChangeCounts added={142} removed={37} />,
};

export const NoChanges = {
  render: () => <ChangeCounts added={0} removed={0} />,
};

export const OnlyAdded = {
  render: () => <ChangeCounts added={58} removed={0} />,
};

export const OnlyRemoved = {
  render: () => <ChangeCounts added={0} removed={214} />,
};

export const LargeRefactor = {
  render: () => <ChangeCounts added={18_406} removed={12_993} />,
};

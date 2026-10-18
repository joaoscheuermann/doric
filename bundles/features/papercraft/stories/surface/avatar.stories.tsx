import { AGENT_AUTHOR } from '../../src/client/domain/preview-state.js';
import { Avatar, authorName } from '../../src/client/surface/avatar.js';

export default {
  title: 'Papercraft/Surface/Avatar',
  component: Avatar,
};

export const Reader = {
  render: () => <Avatar name={authorName(undefined)} />,
};

export const Agent = {
  render: () => <Avatar name={AGENT_AUTHOR} />,
};

export const Readers = {
  render: () => (
    <div className="flex items-center gap-2">
      {['Maya Chen', 'João Scheuermann', 'Priya Natarajan', 'Leo Park'].map(
        (name) => (
          <span key={name} className="flex items-center gap-1.5 text-sm">
            <Avatar name={name} />
            {name}
          </span>
        ),
      )}
    </div>
  ),
};

/** The size the thread's messages draw the author at. */
export const ThreadSize = {
  render: () => (
    <div className="flex items-center gap-2">
      <Avatar name={authorName(undefined)} className="size-5.5" />
      <Avatar name={AGENT_AUTHOR} className="size-5.5" />
    </div>
  ),
};

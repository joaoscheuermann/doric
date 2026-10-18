import { ReaderAvatar } from '../../../src/client/components/molecules/reader-avatar.js';

export default {
  title: 'Chat/Molecules/Reader avatar',
  component: ReaderAvatar,
};

export const Reader = {
  render: () => <ReaderAvatar name="You" />,
};

const names = ['You', 'Marina Costa', 'João Vitor', 'agent', 'Terminal'];

export const Identities = {
  render: () => (
    <div className="flex flex-col gap-2 font-conversation text-sm font-light">
      {names.map((name) => (
        <span key={name} className="flex items-center gap-2">
          <ReaderAvatar name={name} />
          {name}
        </span>
      ))}
    </div>
  ),
};

export const Large = {
  render: () => <ReaderAvatar name="Marina Costa" className="size-8" />,
};

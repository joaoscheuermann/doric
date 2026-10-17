import { Button } from 'desktop/ui/button';
import { Toaster, toast } from 'desktop/ui/sonner';
import { useEffect } from 'react';

export default {
  title: 'desktop/ui/Sonner',
  component: Toaster,
};

/*
 * Toasts stay until dismissed (`duration: Infinity`) so the story shows them
 * without a timer; the buttons add more of each kind.
 */
const kinds = {
  default: () =>
    toast('Thread archived', {
      id: 'default',
      duration: Number.POSITIVE_INFINITY,
      description: 'Add comment threads to papercraft previews',
      action: { label: 'Undo', onClick: () => undefined },
    }),
  success: () =>
    toast.success('Committed 5b0265d1', {
      id: 'success',
      duration: Number.POSITIVE_INFINITY,
      description: '3 files on feat/papercraft',
    }),
  info: () =>
    toast.info('Sandbox restarted', {
      id: 'info',
      duration: Number.POSITIVE_INFINITY,
    }),
  warning: () =>
    toast.warning('Context window is 90% full', {
      id: 'warning',
      duration: Number.POSITIVE_INFINITY,
    }),
  error: () =>
    toast.error('Unable to update', {
      id: 'error',
      duration: Number.POSITIVE_INFINITY,
      description: 'files/v1.list failed: the sandbox is not running.',
      action: { label: 'Try again', onClick: () => undefined },
    }),
  loading: () =>
    toast.loading('Pushing to origin…', {
      id: 'loading',
      duration: Number.POSITIVE_INFINITY,
    }),
} as const;

type Kind = keyof typeof kinds;

const Demo = ({ show }: { readonly show: readonly Kind[] }) => {
  useEffect(() => {
    for (const kind of show) kinds[kind]();
    return () => {
      toast.dismiss();
    };
  }, [show]);
  return (
    <div className="flex min-h-80 flex-wrap items-start gap-2">
      {(Object.keys(kinds) as Kind[]).map((kind) => (
        <Button key={kind} size="sm" variant="outline" onClick={kinds[kind]}>
          {kind}
        </Button>
      ))}
      <Toaster position="bottom-right" expand />
    </div>
  );
};

const all: readonly Kind[] = [
  'default',
  'success',
  'info',
  'warning',
  'error',
  'loading',
];
const single: readonly Kind[] = ['default'];
const failure: readonly Kind[] = ['error'];

export const Default = {
  render: () => <Demo show={single} />,
};

export const AllKinds = {
  render: () => <Demo show={all} />,
};

export const ReadError = {
  render: () => <Demo show={failure} />,
};

import { PromptMarker } from '../../../src/client/components/molecules/prompt-marker.js';

const at = '2026-10-16T08:42:00.000Z';
const resume = (): void => console.info('Doric story: resume');

export default {
  title: 'Chat/Molecules/Prompt marker',
  component: PromptMarker,
};

export const HostStopped = {
  render: () => (
    <PromptMarker
      event={{ kind: 'pause', reason: 'host_stopped', at, standing: true }}
      onResume={resume}
    />
  ),
};

export const ReaderStopped = {
  render: () => (
    <PromptMarker
      event={{ kind: 'pause', reason: 'reader_stopped', at, standing: true }}
      onResume={resume}
    />
  ),
};

export const HostRestarted = {
  render: () => (
    <PromptMarker
      event={{ kind: 'pause', reason: 'host_restarted', at, standing: true }}
      onResume={resume}
    />
  ),
};

export const LowStorage = {
  render: () => (
    <PromptMarker
      event={{ kind: 'pause', reason: 'storage_low', at, standing: true }}
      onResume={resume}
    />
  ),
};

/** A pause something already took up: no action. */
export const PauseNoLongerStanding = {
  render: () => (
    <PromptMarker
      event={{ kind: 'pause', reason: 'host_stopped', at, standing: false }}
      onResume={resume}
    />
  ),
};

export const Resumed = {
  render: () => (
    <PromptMarker
      event={{
        kind: 'resume',
        attempt: 2,
        pause: { reason: 'host_restarted', at },
      }}
    />
  ),
};

export const ResumedWithoutPause = {
  render: () => <PromptMarker event={{ kind: 'resume', attempt: 1 }} />,
};

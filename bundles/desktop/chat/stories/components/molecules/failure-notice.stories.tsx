import { FailureNotice } from '../../../src/client/components/molecules/failure-notice.js';
import { RESUME_EXHAUSTED } from '../../../src/client/domain/prompt-lifecycle.js';

export default {
  title: 'Chat/Molecules/Failure notice',
  component: FailureNotice,
};

export const Failure = {
  render: () => (
    <FailureNotice
      failure={{
        name: 'ProviderError',
        code: 'rate_limited',
        message:
          'The model provider is rate limiting requests. Try again in a minute.',
      }}
    />
  ),
};

export const ResumeExhausted = {
  render: () => (
    <FailureNotice
      failure={{
        name: 'ResumeError',
        code: RESUME_EXHAUSTED,
        message:
          'Doric stopped resuming this prompt after 3 attempts. The work may be incomplete.',
      }}
    />
  ),
};

export const CodeOnly = {
  render: () => (
    <FailureNotice
      failure={{ name: '', code: 'context_window_exceeded', message: '' }}
    />
  ),
};

export const LongMessage = {
  render: () => (
    <FailureNotice
      failure={{
        name: 'SandboxError',
        code: 'sandbox_unavailable',
        message:
          'The sandbox for storefront could not be reached: the container exited with code 137 while installing dependencies. Free some memory on the host and send the prompt again.',
      }}
    />
  ),
};

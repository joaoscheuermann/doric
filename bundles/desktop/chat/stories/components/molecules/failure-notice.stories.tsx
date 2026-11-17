import { errorFrom, errorInfo } from 'desktop/reads';
import { ErrorNotice } from 'desktop/ui/error-notice';

import { chatErrorCatalog } from '../../../src/client/domain/error-catalog.js';

/** The failed-prompt block as the transcript draws it (§5.1). */
const context = {
  Thread: '22222222-2222-4222-8222-222222222222',
  Prompt: '33333333-3333-4333-8333-333333333333',
};

export default {
  title: 'Chat/Molecules/Failure block',
  component: ErrorNotice,
};

export const Failure = {
  render: () => (
    <ErrorNotice
      error={errorInfo({
        code: 'rate_limited',
        message:
          'The model provider is rate limiting requests. Try again in a minute.',
      })}
      catalog={chatErrorCatalog}
      fallbackCode="prompt_failed"
      context={context}
      onRetry={() => undefined}
    />
  ),
};

export const ResumeExhausted = {
  render: () => (
    <ErrorNotice
      error={errorFrom(
        'resume_exhausted',
        'The run was interrupted three times by a host restart and was not resumed again. The work may be incomplete; send the prompt again to continue.',
      )}
      catalog={chatErrorCatalog}
      fallbackCode="prompt_failed"
      context={context}
      onRetry={() => undefined}
    />
  ),
};

export const CodeOnly = {
  render: () => (
    <ErrorNotice
      error={errorFrom('context_window_exceeded', '')}
      catalog={chatErrorCatalog}
      fallbackCode="prompt_failed"
      context={context}
    />
  ),
};

export const LongMessage = {
  render: () => (
    <ErrorNotice
      error={errorInfo({
        code: 'sandbox_unavailable',
        message:
          'The sandbox for storefront could not be reached: the container exited with code 137 while installing dependencies. Free some memory on the host and send the prompt again.',
      })}
      catalog={chatErrorCatalog}
      fallbackCode="prompt_failed"
      context={context}
    />
  ),
};

export const Retrying = {
  render: () => (
    <ErrorNotice
      error={errorFrom('', 'it stopped')}
      catalog={chatErrorCatalog}
      fallbackCode="prompt_failed"
      context={context}
      onRetry={() => undefined}
      retrying
    />
  ),
};

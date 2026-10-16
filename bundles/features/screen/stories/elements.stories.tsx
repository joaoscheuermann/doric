import { defineScreenElements } from '../src/client/elements.js';
import {
  checkoutProject,
  checkoutSelection,
  failedView,
  longLabelView,
  missingXpraView,
  otherProjectView,
  readyView,
  sandboxView,
  startFailedView,
  waitingView,
} from './support/fixtures.js';
import { ScreensPane } from './support/screens.js';

export default {
  title: 'Screen/Elements/Screens pane',
  component: defineScreenElements,
};

/** The selected Project's running screen. */
export const Ready = {
  render: () => (
    <ScreensPane
      setup={{
        views: [readyView, otherProjectView],
        selection: checkoutSelection,
      }}
    />
  ),
};

/** Every status a row draws; the retryable ones show the retry control. */
export const EveryStatus = {
  render: () => (
    <ScreensPane
      setup={{
        views: [
          readyView,
          waitingView,
          failedView,
          missingXpraView,
          sandboxView,
          startFailedView,
          otherProjectView,
        ],
        selection: checkoutSelection,
      }}
    />
  ),
};

export const Starting = {
  render: () => (
    <ScreensPane
      setup={{ views: [waitingView], selection: checkoutSelection }}
    />
  ),
};

export const BackendUnavailable = {
  render: () => (
    <ScreensPane
      setup={{ views: [failedView], selection: checkoutSelection }}
    />
  ),
};

/** No view of the selected Project yet: only the header's add control. */
export const Empty = {
  render: () => (
    <ScreensPane
      setup={{ views: [otherProjectView], selection: checkoutSelection }}
    />
  ),
};

export const LongLabel = {
  render: () => (
    <ScreensPane
      setup={{
        views: [longLabelView, readyView],
        selection: checkoutSelection,
      }}
    />
  ),
};

/** The selection is a Project without a Thread: the pane still lists it. */
export const ProjectOnlySelection = {
  render: () => (
    <ScreensPane
      setup={{
        views: [readyView, waitingView],
        selection: { project: checkoutProject },
      }}
    />
  ),
};

/**
 * The desktop part is not serving `screen.views/v1`: the rows stay, but
 * every control is disabled.
 */
export const DesktopPartAbsent = {
  render: () => (
    <ScreensPane
      setup={{
        views: [readyView, failedView],
        selection: checkoutSelection,
        desktop: false,
      }}
    />
  ),
};

/** No Project selected: nothing to list, and the add control is disabled. */
export const NoSelection = {
  render: () => <ScreensPane setup={{ views: [readyView], selection: {} }} />,
};

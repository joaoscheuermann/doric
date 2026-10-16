import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from 'desktop/ui/alert';
import { Button } from 'desktop/ui/button';
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Alert',
  component: Alert,
};

export const Default = {
  render: () => (
    <Alert className="max-w-lg">
      <InfoIcon />
      <AlertTitle>Sandbox is starting</AlertTitle>
      <AlertDescription>
        Tools will run once the Project's sandbox is ready. This usually takes a
        few seconds.
      </AlertDescription>
    </Alert>
  ),
};

export const Destructive = {
  render: () => (
    <Alert variant="destructive" className="max-w-lg">
      <CircleAlertIcon />
      <AlertTitle>The provider rejected the request</AlertTitle>
      <AlertDescription>
        Anthropic returned 401 Unauthorized. Check the credential in Settings.
      </AlertDescription>
    </Alert>
  ),
};

export const WithAction = {
  render: () => (
    <Alert className="max-w-lg">
      <TriangleAlertIcon />
      <AlertTitle>3 uncommitted changes</AlertTitle>
      <AlertDescription>
        Switching branches keeps them in the working tree.
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline">
          Review
        </Button>
      </AlertAction>
    </Alert>
  ),
};

export const TitleOnly = {
  render: () => (
    <Alert className="max-w-lg">
      <InfoIcon />
      <AlertTitle>Thread archived</AlertTitle>
    </Alert>
  ),
};

export const LongText = {
  render: () => (
    <Alert className="max-w-sm">
      <TriangleAlertIcon />
      <AlertTitle>
        The context window is almost full for this Thread and older turns will
        be compacted
      </AlertTitle>
      <AlertDescription>
        <p>
          Doric summarises the earliest tool calls first. Pin a message to keep
          it verbatim.
        </p>
        <p>
          You can also start a new Thread from the current one with{' '}
          <a href="#fork">Fork thread</a>.
        </p>
      </AlertDescription>
    </Alert>
  ),
};

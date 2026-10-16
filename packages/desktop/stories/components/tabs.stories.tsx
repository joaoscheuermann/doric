import { Badge } from 'desktop/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from 'desktop/ui/tabs';
import { FileIcon, GitCompareIcon, TerminalIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Tabs',
  component: Tabs,
};

const Panels = () => (
  <>
    <TabsContent value="files" className="text-muted-foreground">
      packages/desktop · 34 components
    </TabsContent>
    <TabsContent value="changes" className="text-muted-foreground">
      3 files changed on feat/app
    </TabsContent>
    <TabsContent value="terminal" className="text-muted-foreground">
      zsh — doric
    </TabsContent>
  </>
);

export const Default = {
  render: () => (
    <Tabs defaultValue="files" className="max-w-md">
      <TabsList>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="changes">Changes</TabsTrigger>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
      </TabsList>
      <Panels />
    </Tabs>
  ),
};

export const Line = {
  render: () => (
    <Tabs defaultValue="changes" className="max-w-md">
      <TabsList variant="line">
        <TabsTrigger value="files">
          <FileIcon />
          Files
        </TabsTrigger>
        <TabsTrigger value="changes">
          <GitCompareIcon />
          Changes
          <Badge variant="secondary">3</Badge>
        </TabsTrigger>
        <TabsTrigger value="terminal">
          <TerminalIcon />
          Terminal
        </TabsTrigger>
      </TabsList>
      <Panels />
    </Tabs>
  ),
};

export const Vertical = {
  render: () => (
    <Tabs defaultValue="general" orientation="vertical" className="max-w-md">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="providers">Providers</TabsTrigger>
        <TabsTrigger value="credentials">Credentials</TabsTrigger>
        <TabsTrigger value="usage">Usage</TabsTrigger>
      </TabsList>
      <TabsContent value="general">Theme, language and updates.</TabsContent>
      <TabsContent value="providers">
        Anthropic, OpenAI and local models.
      </TabsContent>
      <TabsContent value="credentials">
        API keys and OAuth sign-ins.
      </TabsContent>
      <TabsContent value="usage">Tokens spent this month.</TabsContent>
    </Tabs>
  ),
};

export const Disabled = {
  render: () => (
    <Tabs defaultValue="files" className="max-w-md">
      <TabsList>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="changes" disabled>
          Changes
        </TabsTrigger>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
      </TabsList>
      <Panels />
    </Tabs>
  ),
};

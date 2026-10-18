import { Marker, MarkerContent, MarkerIcon } from 'desktop/ui/marker';
import { GitCommitIcon, HistoryIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Marker',
  component: Marker,
};

export const Default = {
  render: () => (
    <Marker className="max-w-md">
      <MarkerIcon>
        <HistoryIcon />
      </MarkerIcon>
      <MarkerContent>
        Context compacted · 14 earlier turns summarised
      </MarkerContent>
    </Marker>
  ),
};

export const Separator = {
  render: () => (
    <Marker variant="separator" className="max-w-md">
      <MarkerContent>Today</MarkerContent>
    </Marker>
  ),
};

export const Border = {
  render: () => (
    <Marker variant="border" className="max-w-md">
      <MarkerIcon>
        <GitCommitIcon />
      </MarkerIcon>
      <MarkerContent>
        Committed <a href="#5b0265d1">5b0265d1</a> on feat/papercraft
      </MarkerContent>
    </Marker>
  ),
};

export const LongText = {
  render: () => (
    <Marker className="max-w-xs">
      <MarkerIcon>
        <HistoryIcon />
      </MarkerIcon>
      <MarkerContent>
        The model switched from Claude Sonnet 4 to Claude Opus 4 for the rest of
        this Thread
      </MarkerContent>
    </Marker>
  ),
};

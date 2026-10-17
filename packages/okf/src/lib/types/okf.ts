import type { LlmProvider, ReasoningEffort } from 'llms';

export type ProgressEvent =
  | {
      readonly event: 'okf.generate.start';
      readonly batchSize: number;
    }
  | {
      readonly event: 'okf.file.start' | 'okf.file.cache.miss';
      readonly source: string;
    }
  | {
      readonly event:
        | 'okf.file.summary.start'
        | 'okf.file.summary.complete'
        | 'okf.file.description.start'
        | 'okf.file.description.complete'
        | 'okf.file.tags.start'
        | 'okf.file.tags.complete';
      readonly source: string;
    }
  | {
      readonly event: 'okf.file.cached' | 'okf.file.generated';
      readonly source: string;
      readonly processed: number;
    }
  | {
      readonly event: 'okf.index.start' | 'okf.index.complete';
      readonly files: number;
    }
  | {
      readonly event: 'okf.generate.complete';
      readonly files: number;
      readonly generated: number;
      readonly cached: number;
    };

export type Progress = (event: ProgressEvent) => void;

export interface OkfConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly promptTarget?: string;
  readonly batchSize?: number;
  readonly ignore?: readonly string[];
  readonly signal?: AbortSignal;
  readonly progress?: Progress;
}

export interface GenerateResult {
  readonly root: string;
  readonly output: string;
  readonly index: string;
  readonly files: readonly string[];
  readonly generated: number;
  readonly cached: number;
}

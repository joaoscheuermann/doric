import type { RenderBlock } from '../../../contracts/index.js';
import {
  GENERIC_BLOCK_TYPE,
  type GenericBlockData,
} from '../../domain/external-blocks.js';

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const isGeneric = (block: RenderBlock): boolean =>
  block.type === GENERIC_BLOCK_TYPE;

/**
 * `<chat-block>`'s content (§7.7): a block nobody draws, shown as what it is —
 * its type, its id, when it happened and its payload as JSON.
 */
export function GenericBlock({ block }: { readonly block?: RenderBlock }) {
  if (block === undefined) return null;
  const data = isGeneric(block) ? (block.data as GenericBlockData) : undefined;
  const type = data?.eventType ?? block.type;
  const payload = data === undefined ? block.data : data.payload;

  return (
    <div className="rounded-md border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
        <span className="font-medium text-foreground">{type}</span>
        <span className="font-mono">{block.id}</span>
        {data !== undefined && (
          <time dateTime={data.createdAt}>{data.createdAt}</time>
        )}
      </div>
      <pre className="mt-1 overflow-x-auto font-mono whitespace-pre-wrap">
        {json(payload)}
      </pre>
    </div>
  );
}

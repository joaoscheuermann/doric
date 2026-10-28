// The pure pieces that turn an MCP server's tools into Doric tools: each
// tool's name (after the server's slug, `serverSlug` in the contracts), the
// text a result reads as, and the tool definition itself. The server's own
// input schema is what the model sees, verbatim; the server validates the
// arguments.

import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CallToolResult,
  Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import { ContractError, isContractError } from 'bundle/contracts';
import {
  type AttachInput,
  type Attachment,
  attachmentMediaTypes,
  attachmentReference,
  RuntimeAttachmentsV1,
} from 'runtime/contracts';
import {
  asJsonObject,
  defineTool,
  type ToolDefinitionObject,
  ToolErrorObject,
} from 'tool';
import { z } from 'zod';

import type { McpToolView } from '../contracts/index.js';

/** The names tools/v1 accepts. */
export const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;

const NAME_MAX = 64;
/** How much of a name survives before its hash suffix: 55 + `_` + 8 = 64. */
const HASHED_PREFIX = 55;

const sha8 = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 8);

/**
 * The Doric name of an MCP tool: `mcp__<slug>__<tool>` with every character
 * outside [a-zA-Z0-9_-] replaced by `_`. One over 64 characters, or one
 * already in `taken`, keeps its first 55 characters and ends with `_` and the
 * first 8 hex digits of the SHA-256 of the MCP tool name. Pure and
 * deterministic; it always matches `toolNamePattern`.
 */
export const toolName = (
  slug: string,
  mcpToolName: string,
  taken: ReadonlySet<string>,
): string => {
  const name = `mcp__${slug}__${mcpToolName}`.replace(/[^a-zA-Z0-9_-]/gu, '_');

  return name.length <= NAME_MAX && !taken.has(name)
    ? name
    : `${name.slice(0, HASHED_PREFIX)}_${sha8(mcpToolName)}`;
};

/** Every page of the server's tools. */
export const listTools = async (
  client: Pick<Client, 'listTools'>,
  signal?: AbortSignal,
): Promise<McpTool[]> => {
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      { signal },
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return tools;
};

/** An MCP tool as the reader sees it. */
export const toolView = (tool: McpTool): McpToolView => ({
  name: tool.name,
  ...(tool.title === undefined ? {} : { title: tool.title }),
  ...(tool.description === undefined ? {} : { description: tool.description }),
});

/** `runtime.attachments/v1.attach`, as a tool's call reaches it. */
type Attach = (input: AttachInput) => Promise<Attachment>;

/** A one-line label: brackets and line breaks would break the line. */
const label = (text: string): string => text.replace(/[[\]\r\n]+/gu, ' ');

const isAttachable = (mimeType: string): boolean =>
  (attachmentMediaTypes as readonly string[]).includes(mimeType);

const imageText = async (
  block: { readonly data: string; readonly mimeType: string },
  attach: Attach,
): Promise<string> => {
  if (!isAttachable(block.mimeType)) {
    return `[An image (${label(block.mimeType)}) the conversation cannot show.]`;
  }

  try {
    const attached = await attach({
      name: `image.${block.mimeType.slice('image/'.length)}`,
      bytes: block.data,
    });

    return attachmentReference(attached.name, attached.id);
  } catch (error) {
    if (isContractError(error) && error.code === 'invalid_input') {
      return `[An image (${label(block.mimeType)}) the Project refused to keep.]`;
    }

    throw error;
  }
};

type Block = CallToolResult['content'][number];

const blockText = (block: Block, attach: Attach): Promise<string> | string => {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return imageText(block, attach);
    case 'audio':
      return `[An audio clip (${label(block.mimeType)}) the conversation cannot play.]`;
    case 'resource_link':
      return `[${label(block.title ?? block.name)}](${block.uri})`;
    case 'resource':
      return 'text' in block.resource
        ? block.resource.text
        : `[A binary resource ${label(block.resource.uri)} (${label(block.resource.mimeType ?? 'unknown type')}) the conversation cannot show.]`;
  }
};

/**
 * The text a tool result reads as: its blocks in order, separated by a blank
 * line. Text stays text; an image is kept for the Project through `attach`
 * and reads as its reference line; an image the Project refuses
 * (`invalid_input`) or cannot show, an audio clip or a binary resource reads
 * as one line naming it; a resource link is a Markdown link; an embedded
 * text resource is its text. With no content, structured content reads as
 * its JSON. Rejects only when `attach` rejects with something other than
 * `invalid_input`.
 */
export const formatResult = async (
  result: CallToolResult,
  attach: Attach,
): Promise<string> => {
  if (result.content.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }

  const texts: string[] = [];

  // In order, one at a time: the attachments keep the result's order.
  for (const block of result.content) {
    texts.push(await blockText(block, attach));
  }

  return texts.join('\n\n');
};

/** Calls the tool on its server, under the prompt call's abort signal. */
export type CallMcpTool = (
  request: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  },
  signal: AbortSignal,
) => Promise<CallToolResult>;

/**
 * The Doric tool of one MCP tool: the server's input schema verbatim as the
 * definition's `inputSchema`, a permissive `input` (the server validates),
 * `strict: false`, and the server's description (else its title). Executing
 * calls the tool and answers `formatResult`; a result flagged `isError`
 * rejects with ContractError('mcp_tool_failed') carrying that text. Throws a
 * ToolErrorObject('invalid_schema') when the server's input schema is not an
 * object JSON Schema.
 */
export const toDoricTool = ({
  name,
  tool,
  callTool,
}: {
  readonly name: string;
  readonly tool: McpTool;
  readonly callTool: CallMcpTool;
}): ToolDefinitionObject<z.ZodObject, z.ZodString> => {
  const inputSchema = asJsonObject(tool.inputSchema);

  if (inputSchema === undefined) {
    throw new ToolErrorObject({
      code: 'invalid_schema',
      toolName: name,
      message: `The input schema of ${tool.name} is not JSON: ${name}`,
    });
  }

  const description = tool.description ?? tool.title;

  return defineTool({
    name,
    ...(description === undefined ? {} : { description }),
    input: z.looseObject({}),
    output: z.string(),
    inputSchema,
    strict: false,
    execute: async (input, call, services) => {
      const result = await callTool(
        { name: tool.name, arguments: input },
        call.signal,
      );
      const text = await formatResult(result, (attachment) =>
        services.use(RuntimeAttachmentsV1, call.scope).attach(attachment, call),
      );

      if (result.isError === true) {
        throw new ContractError(
          'mcp_tool_failed',
          text === '' ? `The MCP tool ${tool.name} failed.` : text,
        );
      }

      return text;
    },
  });
};

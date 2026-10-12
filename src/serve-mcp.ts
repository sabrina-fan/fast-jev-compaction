#!/usr/bin/env node
/** stdio MCP server: expose Jev-guided compaction to any MCP-capable agent. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { compactMessages } from './messages.js';
import { reductionRatio } from './compact.js';
import { envOptions } from './config.js';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().default(''),
  toolUses: z
    .array(
      z.object({
        tool_use_id: z.string(),
        tool: z.string(),
        input: z.record(z.string(), z.unknown()).default({}),
        text: z.string().optional(),
        isError: z.boolean().optional(),
      }),
    )
    .default([]),
  toolResults: z
    .array(
      z.object({
        tool_use_id: z.string(),
        text: z.string(),
        isError: z.boolean().optional(),
      }),
    )
    .optional(),
});

const inputSchema = {
  messages: z.array(messageSchema).describe('Transcript messages to compact'),
  goal: z.string().optional().describe('Ongoing task; defaults to the last 3 user prompts'),
  keepThreshold: z.number().min(0).max(1).optional(),
  preserveRecentMessages: z.number().int().min(0).optional(),
  maxStateTokens: z.number().int().positive().optional(),
  maxRequestTokens: z.number().int().positive().optional(),
  truncateHeadChars: z.number().int().min(0).optional(),
  model: z.string().optional().describe('Jev model override (default: JEV_MODEL env)'),
};

const server = new McpServer({ name: 'jev-compaction', version: '0.3.0' });

server.registerTool(
  'compact_messages',
  {
    title: 'Jev-guided transcript compaction',
    description:
      'Prune stale tool calls/results from an agent transcript using TypeSafe Jev decisions. ' +
      'Never summarizes: kept content stays verbatim, dropped calls/results are removed. ' +
      'Returns the compacted transcript plus per-call decisions and stats.',
    inputSchema,
  },
  async ({ messages, ...options }) => {
    const result = await compactMessages(messages, { ...envOptions(), ...options });
    const ratio = reductionRatio(result);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ...result, reductionRatio: ratio }),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());

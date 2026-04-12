/**
 * MCP Server — Grouping / Write Operations
 *
 * Exposes: propose_group_action, propose_bulk_tag, propose_journal_move,
 * propose_annotation, execute_proposal.
 *
 * All write operations use the propose/confirm pattern.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as tools from '../tools/index.js';

const WALLET = process.env.WALLET_ADDRESS;
if (!WALLET) {
  console.error('WALLET_ADDRESS env var required');
  process.exit(1);
}

const server = new Server(
  { name: 'booba-grouping', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'propose_group_action',
      description: 'Propose merging, linking, or splitting positions. Returns a preview to confirm.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          description: { type: 'string', description: 'Natural language description of what to group' },
        },
        required: ['description'],
      },
    },
    {
      name: 'propose_bulk_tag',
      description: 'Propose applying a tag to multiple positions matching a filter.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          field: { type: 'string', enum: ['strategy', 'thesis', 'emotion', 'sourceTag'] },
          value: { type: 'string' },
          asset: { type: 'string' },
          direction: { type: 'string' },
          regime: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
        required: ['field', 'value'],
      },
    },
    {
      name: 'propose_journal_move',
      description: 'Propose moving positions matching a filter to a different journal.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          targetJournalName: { type: 'string' },
          asset: { type: 'string' },
          direction: { type: 'string' },
          regime: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
        required: ['targetJournalName'],
      },
    },
    {
      name: 'propose_annotation',
      description: 'Propose annotating specific positions with strategy, thesis, emotion, or conviction.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          positionIds: { type: 'array', items: { type: 'string' } },
          strategy: { type: 'string' },
          thesis: { type: 'string' },
          emotion: { type: 'string' },
          conviction: { type: 'number' },
        },
        required: ['positionIds'],
      },
    },
    {
      name: 'execute_proposal',
      description: 'Execute a previously proposed write action after confirmation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          proposalId: { type: 'string' },
        },
        required: ['proposalId'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  let result: any;
  switch (name) {
    case 'propose_group_action':
      result = await tools.proposeGroupAction(WALLET, a.description);
      break;
    case 'propose_bulk_tag':
      result = await tools.proposeBulkTag(WALLET, a.field, a.value, {
        asset: a.asset,
        direction: a.direction,
        regime: a.regime,
        dateFrom: a.dateFrom,
        dateTo: a.dateTo,
      });
      break;
    case 'propose_journal_move':
      result = await tools.proposeJournalMove(WALLET, {
        asset: a.asset,
        direction: a.direction,
        regime: a.regime,
        dateFrom: a.dateFrom,
        dateTo: a.dateTo,
      }, a.targetJournalName);
      break;
    case 'propose_annotation':
      result = await tools.proposeAnnotation(WALLET, a.positionIds, {
        strategy: a.strategy,
        thesis: a.thesis,
        emotion: a.emotion,
        conviction: a.conviction,
      });
      break;
    case 'execute_proposal':
      result = await tools.executeProposal(WALLET, a.proposalId);
      break;
    default:
      result = { error: `Unknown tool: ${name}` };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

export async function startGroupingServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

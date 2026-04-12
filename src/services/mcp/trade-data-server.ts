/**
 * MCP Server — Trade Data
 *
 * Exposes: get_positions, get_position_detail, get_recent_trades,
 * get_open_positions, search_trades.
 *
 * Wallet address is read from WALLET_ADDRESS env var since MCP servers
 * run as standalone processes without Privy auth.
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
  { name: 'booba-trade-data', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_positions',
      description: 'Get trading positions with optional filters.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          asset: { type: 'string' },
          direction: { type: 'string', enum: ['long', 'short'] },
          regime: { type: 'string' },
          tradeType: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'get_position_detail',
      description: 'Get full details of a single position including orders and fills.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          positionId: { type: 'string' },
        },
        required: ['positionId'],
      },
    },
    {
      name: 'get_recent_trades',
      description: 'Get the N most recent trades.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          n: { type: 'number' },
        },
      },
    },
    {
      name: 'get_open_positions',
      description: 'Get all currently open positions.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'search_trades',
      description: 'Search trades by text across thesis, notes, strategy names, asset names.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;

  let result: any;
  switch (name) {
    case 'get_positions':
      result = await tools.getPositions(WALLET, undefined, a);
      break;
    case 'get_position_detail':
      result = await tools.getPositionDetail(WALLET, a.positionId);
      break;
    case 'get_recent_trades':
      result = await tools.getRecentTrades(WALLET, a.n);
      break;
    case 'get_open_positions':
      result = await tools.getOpenPositions(WALLET);
      break;
    case 'search_trades':
      result = await tools.searchTrades(WALLET, a.query);
      break;
    default:
      result = { error: `Unknown tool: ${name}` };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

export async function startTradeDataServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

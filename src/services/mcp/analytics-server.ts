/**
 * MCP Server — Analytics
 *
 * Exposes: get_performance_summary, get_wart_score, get_elo_rating,
 * get_insights, get_regime_breakdown, get_asset_breakdown,
 * get_behavioral_patterns, get_exit_analysis.
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
  { name: 'booba-analytics', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_performance_summary',
      description: 'Get overall trading performance: P&L, win rate, expectancy, profit factor.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string', description: 'Optional journal scope' },
        },
      },
    },
    {
      name: 'get_wart_score',
      description: 'Get the WART composite score with 5 axes: entry, exit, risk, timing, discipline.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
    {
      name: 'get_elo_rating',
      description: 'Get the Elo rating: current, peak, tier, trend.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
    {
      name: 'get_insights',
      description: 'Get all detected behavioral and statistical insights.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
    {
      name: 'get_regime_breakdown',
      description: 'Get performance broken down by market regime.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
    {
      name: 'get_asset_breakdown',
      description: 'Get performance broken down by asset.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
    {
      name: 'get_behavioral_patterns',
      description: 'Get behavioral analysis: tilt, disposition, entropy, decision fatigue.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
    {
      name: 'get_exit_analysis',
      description: 'Get exit quality analysis: MFE/MAE stats, exit efficiency.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          journalId: { type: 'string' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, any>;
  const journalId = a.journalId;

  let result: any;
  switch (name) {
    case 'get_performance_summary':
      result = await tools.getPerformanceSummary(WALLET, journalId);
      break;
    case 'get_wart_score':
      result = await tools.getWartScore(WALLET, journalId);
      break;
    case 'get_elo_rating':
      result = await tools.getEloRating(WALLET, journalId);
      break;
    case 'get_insights':
      result = await tools.getInsights(WALLET, journalId);
      break;
    case 'get_regime_breakdown':
      result = await tools.getRegimeBreakdown(WALLET, journalId);
      break;
    case 'get_asset_breakdown':
      result = await tools.getAssetBreakdown(WALLET, journalId);
      break;
    case 'get_behavioral_patterns':
      result = await tools.getBehavioralPatterns(WALLET, journalId);
      break;
    case 'get_exit_analysis':
      result = await tools.getExitAnalysis(WALLET, journalId);
      break;
    default:
      result = { error: `Unknown tool: ${name}` };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

export async function startAnalyticsServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Launch script for the trade data MCP server.
 *
 * Usage: WALLET_ADDRESS=32K2... npx ts-node src/scripts/mcp-trade-data.ts
 */
import { startTradeDataServer } from '../services/mcp/trade-data-server';

startTradeDataServer().catch((err) => {
  console.error('Failed to start trade data MCP server:', err);
  process.exit(1);
});

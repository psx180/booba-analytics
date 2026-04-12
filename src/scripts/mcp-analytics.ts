/**
 * Launch script for the analytics MCP server.
 *
 * Usage: WALLET_ADDRESS=32K2... npx ts-node src/scripts/mcp-analytics.ts
 */
import { startAnalyticsServer } from '../services/mcp/analytics-server';

startAnalyticsServer().catch((err) => {
  console.error('Failed to start analytics MCP server:', err);
  process.exit(1);
});

/**
 * Launch script for the grouping MCP server.
 *
 * Usage: WALLET_ADDRESS=32K2... npx ts-node src/scripts/mcp-grouping.ts
 */
import { startGroupingServer } from '../services/mcp/grouping-server';

startGroupingServer().catch((err) => {
  console.error('Failed to start grouping MCP server:', err);
  process.exit(1);
});

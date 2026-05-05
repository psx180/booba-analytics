/**
 * Standalone backfill of stop/TP/entry-type fields on existing positions.
 *
 * Assumes orders have already been synced (run a normal import once first, or
 * call PacificaClient.orders.getAllOrderHistory + syncOrders separately). Walks
 * every wallet that has at least one Order row and runs the enrichment.
 *
 * Run: npx tsx src/scripts/backfill-position-orders.ts [walletAddress...]
 *      (no args → all wallets with orders)
 */

import { prisma } from '../lib/prisma';
import { enrichPositionsFromOrders } from '../services/enrichment/positions-from-orders';

async function main() {
  const explicit = process.argv.slice(2).filter((a) => a.length > 0);

  let wallets: string[];
  if (explicit.length > 0) {
    wallets = explicit;
  } else {
    const rows = await prisma.order.findMany({
      distinct: ['walletAddress'],
      select: { walletAddress: true },
    });
    wallets = rows.map((r) => r.walletAddress);
  }

  if (wallets.length === 0) {
    console.log('No wallets with order history. Nothing to backfill.');
    return;
  }

  console.log(`Enriching positions for ${wallets.length} wallet(s)…`);

  let totalConsidered = 0;
  let totalUpdated = 0;
  for (const wallet of wallets) {
    const result = await enrichPositionsFromOrders(wallet);
    totalConsidered += result.positionsConsidered;
    totalUpdated += result.positionsUpdated;
    if (result.errors.length > 0) {
      console.warn(`[${wallet}] ${result.errors.length} errors:`);
      for (const e of result.errors.slice(0, 5)) console.warn(`  - ${e}`);
    }
  }

  console.log(`\nDone. ${totalUpdated}/${totalConsidered} positions updated across ${wallets.length} wallet(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

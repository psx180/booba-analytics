/**
 * reset-wallet.ts — Wipe all data associated with a single wallet so you
 * can re-seed or start fresh for a demo.
 *
 * Reuses `cleanDemoData()` from seed-trades (which handles the FK-safe
 * delete order for trades/positions/journals/signals/playbooks/etc.) and
 * then removes the wallet's Strategy and LinkedStrategy rows, which the
 * main cleaner doesn't touch.
 *
 * Does NOT touch server-wide caches (CandleCache, RegimeSnapshot) or
 * global definitions (CustomStatDefinition).
 *
 * Usage:
 *   npx tsx src/scripts/reset-wallet.ts <wallet_address>
 *   npx tsx src/scripts/reset-wallet.ts   # uses DEV_WALLET env var
 */

import { prisma } from '../lib/prisma';
import { cleanDemoData } from './seed-trades';

const walletAddress = process.argv[2] || process.env.DEV_WALLET;
if (!walletAddress) {
  console.error('Usage: tsx src/scripts/reset-wallet.ts <wallet_address>');
  console.error('Or set DEV_WALLET in your environment.');
  process.exit(1);
}

async function run() {
  console.log(`[reset] Clearing wallet ${walletAddress}`);

  await cleanDemoData(walletAddress!);

  // cleanDemoData runs its own Position/Trade wipe first, so Strategy and
  // LinkedStrategy have no remaining FK references by the time we get here.
  const strategies = await prisma.strategy.deleteMany({ where: { walletAddress } });
  const linkedStrategies = await prisma.linkedStrategy.deleteMany({ where: { walletAddress } });

  console.log(
    `[reset] Removed ${strategies.count} strategy row(s) and ${linkedStrategies.count} linked-strategy row(s)`,
  );
  console.log(`[reset] Done.`);
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());

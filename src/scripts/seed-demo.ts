/**
 * seed-demo.ts — Entry point for the demo trade history generator.
 *
 * Usage:
 *   npx tsx src/scripts/seed-demo.ts [profile] [--skip-candles]
 *   profile: all (default) | disciplined | struggling | degen | clean
 *
 * Examples:
 *   npx tsx src/scripts/seed-demo.ts              # seed all three profiles
 *   npx tsx src/scripts/seed-demo.ts disciplined  # seed only the disciplined trader
 *   npx tsx src/scripts/seed-demo.ts clean        # delete all demo wallet data
 *   npx tsx src/scripts/seed-demo.ts all --skip-candles  # skip candle fetch (already cached)
 *
 * The script is idempotent: each profile checks for existing data and cleans
 * it before re-inserting.
 */

import { prisma } from '../lib/prisma';
import { populateCandles, runRegimeDetection } from './seed-candles';
import {
  generateTrades,
  cleanDemoData,
  DISCIPLINED_PROFILE,
  STRUGGLING_PROFILE,
  DEGEN_PROFILE,
} from './seed-trades';

const DEMO_WALLETS = [
  DISCIPLINED_PROFILE.walletAddress,
  STRUGGLING_PROFILE.walletAddress,
  DEGEN_PROFILE.walletAddress,
];

async function main() {
  const args        = process.argv.slice(2);
  const profileArg  = args.find((a) => !a.startsWith('--')) ?? 'all';
  const skipCandles = args.includes('--skip-candles');

  // ── Clean command ──────────────────────────────────────────────────────────
  if (profileArg === 'clean') {
    console.log('[seed] Cleaning all demo wallet data...');
    for (const wallet of DEMO_WALLETS) {
      await cleanDemoData(wallet);
    }
    console.log('[seed] Done.');
    return;
  }

  // ── Step 1: Candle cache population ───────────────────────────────────────
  if (skipCandles) {
    console.log('[seed] --skip-candles: assuming candle cache is already populated.');
  } else {
    console.log('[seed] Step 1: Populating candle cache (14 days × BTC/ETH/SOL × 1m/5m/1h)...');
    await populateCandles();
  }

  // ── Step 2: Regime detection ───────────────────────────────────────────────
  if (!skipCandles) {
    console.log('[seed] Step 2: Running BTC 1h regime detection...');
    await runRegimeDetection();
  }

  // ── Step 3: Trade simulation per profile ──────────────────────────────────
  if (profileArg === 'all' || profileArg === 'disciplined') {
    console.log('\n[seed] Step 3a: Generating Disciplined Trader...');
    await generateTrades(DISCIPLINED_PROFILE);
  }

  if (profileArg === 'all' || profileArg === 'struggling') {
    console.log('\n[seed] Step 3b: Generating Struggling Trader...');
    await generateTrades(STRUGGLING_PROFILE);
  }

  if (profileArg === 'all' || profileArg === 'degen') {
    console.log('\n[seed] Step 3c: Generating Degen Trader...');
    await generateTrades(DEGEN_PROFILE);
  }

  if (!['all', 'disciplined', 'struggling', 'degen'].includes(profileArg)) {
    console.error(`[seed] Unknown profile: "${profileArg}". Use: all | disciplined | struggling | degen | clean`);
    process.exit(1);
  }

  console.log('\n[seed] Done!');
}

main()
  .catch((err) => { console.error('[seed] Fatal error:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());

/**
 * import.ts
 *
 * Manual import script — run this to pull trade history into the DB.
 *
 * Usage:
 *   npx tsx src/scripts/import.ts <wallet_address>
 *
 * For ongoing sync (only new trades since last import):
 *   npx tsx src/scripts/import.ts <wallet_address> --incremental
 *
 * To avoid rate limits, set PF_API_KEY in your environment first:
 *   PF_API_KEY=yourkey npx tsx src/scripts/import.ts <wallet_address>
 *
 * To generate a key (requires your private key):
 *   npx tsx src/scripts/create-api-key.ts
 */

import { PacificaClient } from '../services/pacifica';
import {
  filterNewFills,
  getExistingFillIds,
  ingestFunding,
  ingestTrades,
  syncBalanceEvents,
  syncEquitySnapshots,
} from '../services/ingestion';
import { ensureDefaultJournal } from '../lib/journals';

async function main() {
  const walletAddress = process.argv[2];
  const incremental = process.argv.includes('--incremental');

  if (!walletAddress) {
    console.error('Usage: npx tsx src/scripts/import.ts <wallet_address> [--incremental]');
    process.exit(1);
  }

  console.log(`\nImporting trades for: ${walletAddress}`);
  console.log(`Mode: ${incremental ? 'incremental (new only)' : 'full history'}\n`);

  // Make sure the wallet has its default journal up-front so the first
  // grouping run has a target to assign new positions into. The helper is
  // idempotent: harmless if a default already exists.
  const defaultJournal = await ensureDefaultJournal(walletAddress);
  console.log(`Default journal: "${defaultJournal.name}" (${defaultJournal.id})`);

  const apiConfigKey = process.env.PF_API_KEY;
  if (apiConfigKey) console.log('Using API config key for higher rate limits.');

  const client = new PacificaClient({ walletAddress, apiConfigKey });

  // ── Fetch trade history ────────────────────────────────────────────────────

  console.log('Fetching trade history from Pacifica...');
  let fills = await client.account.getAllTradeHistory({ account: walletAddress });
  console.log(`  Fetched ${fills.length} fills`);

  if (incremental) {
    const existingIds = await getExistingFillIds(walletAddress);
    fills = filterNewFills(fills, existingIds);
    console.log(`  ${fills.length} new fills after deduplication`);
  }

  if (fills.length === 0) {
    console.log('  Nothing to import.');
  } else {
    const tradeResult = await ingestTrades(fills, walletAddress);
    console.log('\nTrade ingestion:');
    console.log(`  Fills processed : ${tradeResult.fillsProcessed}`);
    console.log(`  Trades upserted : ${tradeResult.tradesUpserted}`);
    console.log(`  Skipped         : ${tradeResult.skipped}`);
    if (tradeResult.errors.length > 0) {
      console.log(`  Errors (${tradeResult.errors.length}):`);
      tradeResult.errors.forEach((e) => console.log(`    ${e}`));
    }
  }

  // ── Fetch funding history ──────────────────────────────────────────────────

  console.log('\nFetching funding history from Pacifica...');
  const fundingPage = await client.account.getFundingHistory({ account: walletAddress });
  const fundingEvents = fundingPage.data;
  console.log(`  Fetched ${fundingEvents.length} funding events`);

  if (fundingEvents.length > 0) {
    const fundingResult = await ingestFunding(fundingEvents, walletAddress);
    console.log('\nFunding ingestion:');
    console.log(`  Events processed : ${fundingResult.eventsProcessed}`);
    console.log(`  Linked to trades : ${fundingResult.eventsLinked}`);
    console.log(`  Unlinked         : ${fundingResult.eventsUnlinked}`);
    if (fundingResult.errors.length > 0) {
      console.log(`  Errors (${fundingResult.errors.length}):`);
      fundingResult.errors.forEach((e) => console.log(`    ${e}`));
    }
  }

  // ── Sync equity snapshots & balance events ─────────────────────────────────
  // Required by the snapshot-twr equity provider — pulls Pacifica's portfolio
  // history and the cash-flow event log into local tables.

  console.log('\nFetching equity snapshots from Pacifica...');
  const equityResult = await syncEquitySnapshots(walletAddress, client.account);
  console.log('\nEquity snapshot sync:');
  console.log(`  Snapshots fetched : ${equityResult.fetched}`);
  console.log(`  Snapshots upserted: ${equityResult.upserted}`);
  if (equityResult.errors.length > 0) {
    console.log(`  Errors (${equityResult.errors.length}):`);
    equityResult.errors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
  }

  console.log('\nFetching balance event history from Pacifica...');
  const balanceResult = await syncBalanceEvents(walletAddress, client.account);
  console.log('\nBalance event sync:');
  console.log(`  Events fetched   : ${balanceResult.fetched}`);
  console.log(`  Events upserted  : ${balanceResult.upserted}`);
  console.log(`  Deposits         : ${balanceResult.deposits}`);
  console.log(`  Withdrawals      : ${balanceResult.withdrawals}`);
  console.log(`  Other            : ${balanceResult.other}`);
  if (balanceResult.unknownTypes.length > 0) {
    console.log(`  Unknown types    : ${balanceResult.unknownTypes.join(', ')}`);
  }
  if (balanceResult.errors.length > 0) {
    console.log(`  Errors (${balanceResult.errors.length}):`);
    balanceResult.errors.slice(0, 5).forEach((e) => console.log(`    ${e}`));
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});

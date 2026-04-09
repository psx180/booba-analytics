/**
 * compute-regimes.ts
 *
 * Fetches historical candles, computes regime snapshots, then tags all
 * untagged trades with the regime that was in effect at their entry time.
 *
 * Usage:
 *   npx tsx src/scripts/compute-regimes.ts [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]
 *
 * Defaults: start = 1 year ago, end = today.
 * Asset is always BTC (market proxy). Timeframe is daily.
 *
 * To swap candle source to Pacifica, change the commented line below.
 */

import { AdxAtrDetector, BinanceCandleSource, RegimeService } from '../services/regime';

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith('--'))
      .map((a) => a.slice(2).split('=') as [string, string]),
  );

  const end   = args.end   ? new Date(args.end)   : new Date();
  const start = args.start ? new Date(args.start) : new Date(end.getTime() - 365 * 86_400_000);

  const asset     = 'BTCUSDT'; // Binance format — change to 'BTC' if using PacificaCandleSource
  const timeframe = '1d';

  console.log(`\nComputing regimes: ${asset} ${timeframe}`);
  console.log(`Range: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}\n`);

  const detector = new AdxAtrDetector();
  const source   = new BinanceCandleSource();
  // To use Pacifica candles instead:
  // import { PacificaClient } from '../services/pacifica';
  // const client = new PacificaClient();
  // const source = new PacificaCandleSource(client.market);

  const service = new RegimeService(detector, source);

  const { computed, skipped } = await service.computeRegimes(asset, timeframe, start, end);
  console.log(`Regime snapshots: ${computed} computed, ${skipped} skipped (already existed)`);

  const tagged = await service.tagTrades();
  console.log(`Trades tagged:    ${tagged}`);

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});

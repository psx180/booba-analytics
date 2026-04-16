/**
 * testnet-trade.ts — Place real orders on Pacifica testnet to create
 * pattern-rich behavioral demo data for Booba analytics.
 *
 * Usage:
 *   npm run testnet:trade -- --mode=tilt
 *   npm run testnet:trade -- --mode=fatigue --count=20
 *   npm run testnet:trade -- --mode=disposition
 *   npm run testnet:trade -- --mode=discipline --count=8
 *   npm run testnet:trade -- --mode=all
 *   npm run testnet:trade -- --mode=tilt --dry-run
 *
 * Required env vars (or use --dry-run):
 *   PACIFICA_PRIVATE_KEY       base58-encoded 64-byte Solana keypair (direct)
 *   PACIFICA_AGENT_PRIVATE_KEY agent key (also needs DEFAULT_WALLET_ADDRESS or --wallet)
 *   DEFAULT_WALLET_ADDRESS     wallet address used when not passed via --wallet
 *
 * Optional:
 *   PF_API_KEY        Pacifica API config key for higher rate limits
 *   PACIFICA_NETWORK  if set to 'mainnet', script refuses to run
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
dotenvConfig({ path: '.env.local', override: true });

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { PacificaBaseClient, TESTNET_REST_URL } from '../services/pacifica/client';
import { CandleSchema, PriceSchema } from '../services/pacifica/types/market';
import { PositionSchema } from '../services/pacifica/types/account';
import { apiResponse } from '../services/pacifica/types/common';

// Hard-coded — never derived from env. Mainnet is not reachable from this script.
const TESTNET_API_URL = TESTNET_REST_URL;

const BUILDER_CODE = 'BOOBAI';

// Position sizes chosen to stay within testnet balance constraints
const NORMAL_SIZE: Record<string, string> = {
  'BTC-PERP':  '0.001',
  'ETH-PERP':  '0.01',
  'SOL-PERP':  '0.1',
  'WIF-PERP':  '1',
  'JTO-PERP':  '1',
  'BONK-PERP': '10000',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomMs(minSeconds: number, maxSeconds: number): number {
  return randomInt(minSeconds * 1000, maxSeconds * 1000);
}

// 3-5 second inter-order delay — avoids rate limiting, creates natural spacing
function jitter(): Promise<void> {
  return sleep(randomMs(3, 5));
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface Args {
  mode: string;
  count?: number;
  wallet?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const has = (k: string) => argv.includes(`--${k}`);

  const mode = get('mode');
  if (!mode) {
    console.error(
      'Usage: npm run testnet:trade -- --mode=<tilt|fatigue|disposition|discipline|all>' +
      ' [--count=N] [--wallet=<address>] [--dry-run]',
    );
    process.exit(1);
  }

  const countStr = get('count');
  return {
    mode,
    count: countStr !== undefined ? parseInt(countStr, 10) : undefined,
    wallet:  get('wallet'),
    dryRun: has('dry-run'),
  };
}

// ─── Startup confirmation ─────────────────────────────────────────────────────

async function confirmStart(): Promise<void> {
  console.log('\nPlacing trades on TESTNET. Press Ctrl+C to cancel. Starting in 5 seconds...\n');
  for (let i = 5; i > 0; i--) {
    process.stdout.write(`  ${i}...\r`);
    await sleep(1000);
  }
  process.stdout.write('  Starting.\n\n');
}

// ─── Order client ─────────────────────────────────────────────────────────────

class TestnetOrderClient {
  constructor(
    private readonly base: PacificaBaseClient,
    private readonly dryRun: boolean,
  ) {}

  /**
   * Place a market order with builder code on every payload.
   * Returns order_id, or null if the request failed (caller continues).
   */
  async placeMarket(
    symbol: string,
    side: 'bid' | 'ask',
    amount: string,
    label: string,
  ): Promise<number | null> {
    if (this.dryRun) {
      console.log(`  [dry-run] market ${side === 'bid' ? 'LONG' : 'SHORT'} ${amount} ${symbol}  (${label})`);
      return randomInt(100_000, 999_999);
    }

    try {
      const payload = {
        symbol,
        side,
        amount,
        reduce_only: false,
        slippage_percent: '0.5',
        client_order_id: uuidv4(),
        builder_code: BUILDER_CODE,
        builder_fee_rate: '0',
      };
      const body = this.base.sign('create_market_order', payload);
      const result = await this.base.post(
        '/orders/create_market',
        body,
        z.object({ order_id: z.number() }),
      );
      return result.order_id;
    } catch (err) {
      console.error(`  [error] placeMarket ${side === 'bid' ? 'LONG' : 'SHORT'} ${symbol}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Close an existing position with a reduce-only market order.
   * openSide is the direction of the position being closed.
   */
  async closePosition(
    symbol: string,
    openSide: 'bid' | 'ask',
    amount: string,
    label: string,
  ): Promise<number | null> {
    const closeSide: 'bid' | 'ask' = openSide === 'bid' ? 'ask' : 'bid';

    if (this.dryRun) {
      const dir = openSide === 'bid' ? 'LONG' : 'SHORT';
      console.log(`  [dry-run] close ${dir} ${amount} ${symbol}  (${label})`);
      return randomInt(100_000, 999_999);
    }

    try {
      const payload = {
        symbol,
        side: closeSide,
        amount,
        reduce_only: true,
        slippage_percent: '0.5',
        client_order_id: uuidv4(),
        builder_code: BUILDER_CODE,
        builder_fee_rate: '0',
      };
      const body = this.base.sign('create_market_order', payload);
      const result = await this.base.post(
        '/orders/create_market',
        body,
        z.object({ order_id: z.number() }),
      );
      return result.order_id;
    } catch (err) {
      console.error(`  [error] closePosition ${symbol}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Get open positions. Returns [] on error. */
  async getPositions(): Promise<z.infer<typeof PositionSchema>[]> {
    if (this.dryRun) return [];
    try {
      return await this.base
        .get('/positions', { account: this.base.publicKey }, apiResponse(z.array(PositionSchema)))
        .then((r) => r.data);
    } catch (err) {
      console.error(`  [error] getPositions: ${(err as Error).message}`);
      return [];
    }
  }

  /** Get current mark prices keyed by symbol. Returns {} on error. */
  async getMarkPrices(): Promise<Record<string, number>> {
    if (this.dryRun) return {};
    try {
      const prices = await this.base
        .get('/info/prices', {}, apiResponse(z.array(PriceSchema)))
        .then((r) => r.data);
      return Object.fromEntries(prices.map((p) => [p.symbol, parseFloat(p.mark)]));
    } catch (err) {
      console.error(`  [error] getMarkPrices: ${(err as Error).message}`);
      return {};
    }
  }

  /**
   * Check whether the most recent 1m candle closed up or down.
   * Falls back to 'up' on any error — callers handle this gracefully.
   */
  async getCandleDirection(symbol: string): Promise<'up' | 'down'> {
    if (this.dryRun) return Math.random() > 0.5 ? 'up' : 'down';
    try {
      const startTime = Date.now() - 10 * 60 * 1000;
      const candles = await this.base
        .get(
          '/kline',
          { symbol, interval: '1m', start_time: startTime },
          apiResponse(z.array(CandleSchema)),
        )
        .then((r) => r.data);
      if (candles.length === 0) return 'up';
      const last = candles[candles.length - 1];
      return parseFloat(last.c) >= parseFloat(last.o) ? 'up' : 'down';
    } catch {
      return 'up';
    }
  }
}

// ─── Mode: tilt ───────────────────────────────────────────────────────────────
//
// Creates a CUSUM-detectable tilt episode:
//   Phase 1 — normal-sized counter-trend entries (designed to lose)
//   Phase 2 — oversized revenge trades after the losing streak

async function runTilt(client: TestnetOrderClient, count: number): Promise<void> {
  // Require at least 3 normal trades so the losing streak is credible
  const normalCount  = Math.max(3, count - 2);
  const oversizeCount = count - normalCount;

  if (oversizeCount < 1) {
    console.log(`[tilt] count=${count} is too low for oversize trades — raise to 5+. Placing ${normalCount} counter-trend trades only.`);
  }

  const assets = ['BTC-PERP', 'ETH-PERP'];

  console.log(`[tilt] Phase 1: ${normalCount} counter-trend trades...`);
  for (let i = 0; i < normalCount; i++) {
    const symbol = assets[i % assets.length];
    const trend  = await client.getCandleDirection(symbol);
    const side: 'bid' | 'ask' = trend === 'up' ? 'ask' : 'bid'; // deliberately counter-trend

    const orderId = await client.placeMarket(symbol, side, NORMAL_SIZE[symbol], `tilt ${i + 1}/${normalCount}`);
    if (orderId !== null) {
      console.log(`  [tilt] ${i + 1}/${normalCount}: ${side === 'bid' ? 'LONG' : 'SHORT'} ${NORMAL_SIZE[symbol]} ${symbol}  order=${orderId}`);
    }
    await jitter();
  }

  if (oversizeCount > 0) {
    console.log(`\n[tilt] Phase 2: ${oversizeCount} oversized tilt trades (3-5× size)...`);
    for (let i = 0; i < oversizeCount; i++) {
      const symbol  = assets[i % assets.length];
      const base    = parseFloat(NORMAL_SIZE[symbol]);
      const mult    = 3 + Math.random() * 2; // 3-5×
      const decimals = symbol === 'BTC-PERP' ? 4 : symbol === 'ETH-PERP' ? 3 : 2;
      const amount  = (base * mult).toFixed(decimals);

      // Revenge trade: chase the trend (impulsive, not counter-trend)
      const trend = await client.getCandleDirection(symbol);
      const side: 'bid' | 'ask' = trend === 'up' ? 'bid' : 'ask';

      const orderId = await client.placeMarket(symbol, side, amount, `tilt-oversize ${i + 1}/${oversizeCount}`);
      if (orderId !== null) {
        console.log(`  [tilt] oversize ${i + 1}/${oversizeCount}: ${side === 'bid' ? 'LONG' : 'SHORT'} ${amount} ${symbol}  (${mult.toFixed(1)}×)  order=${orderId}`);
      }
      await jitter();
    }
  }

  console.log('[tilt] Done.');
}

// ─── Mode: fatigue ────────────────────────────────────────────────────────────
//
// Creates a detectable decision-fatigue pattern:
//   - First half: trend-following, normal size (high conviction)
//   - Second half: random direction, shrinking size (degraded quality)

async function runFatigue(client: TestnetOrderClient, count: number): Promise<void> {
  const symbol  = 'BTC-PERP';
  const baseSize = parseFloat(NORMAL_SIZE[symbol]);

  console.log(`[fatigue] ${count} rapid trades on ${symbol} — quality degrades over session...`);

  for (let i = 0; i < count; i++) {
    const progress = count > 1 ? i / (count - 1) : 0; // 0 → 1

    // Size shrinks to ~30% by end of session
    const amount = (baseSize * (1 - progress * 0.7)).toFixed(4);

    let side: 'bid' | 'ask';
    if (progress < 0.5) {
      // First half: check the trend (deliberate entries)
      const trend = await client.getCandleDirection(symbol);
      side = trend === 'up' ? 'bid' : 'ask';
    } else {
      // Second half: random (fatigued, no real analysis)
      side = Math.random() > 0.5 ? 'bid' : 'ask';
    }

    const quality = progress < 0.33 ? 'high' : progress < 0.66 ? 'medium' : 'low';
    const orderId = await client.placeMarket(symbol, side, amount, `fatigue ${i + 1}/${count}`);
    if (orderId !== null) {
      console.log(`  [fatigue] ${i + 1}/${count}: ${side === 'bid' ? 'LONG' : 'SHORT'} ${amount} ${symbol}  conviction=${quality}  order=${orderId}`);
    }

    // Inter-trade interval also shrinks (more impatient as session wears on)
    const minS = Math.max(2, 5 - progress * 3);
    const maxS = Math.max(3, 7 - progress * 4);
    await sleep(randomMs(minS, maxS));
  }

  console.log('[fatigue] Done.');
}

// ─── Mode: disposition ────────────────────────────────────────────────────────
//
// Creates PGR/PLR disposition-effect signal:
//   - Open 6 positions across different assets
//   - After 1-2 min: close winners (taking profit too early)
//   - After 5-10 more min: close losers (riding losses too long)
//
// The analytics detector measures hold-time ratio, not absolute duration.

async function runDisposition(client: TestnetOrderClient): Promise<void> {
  const assets = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'WIF-PERP', 'JTO-PERP', 'BONK-PERP'];

  type OpenPos = { symbol: string; side: 'bid' | 'ask'; amount: string };

  console.log('[disposition] Opening 6 positions across different assets...');
  const opened: OpenPos[] = [];

  for (let i = 0; i < assets.length; i++) {
    const symbol = assets[i];
    const amount = NORMAL_SIZE[symbol];
    const side: 'bid' | 'ask' = i % 2 === 0 ? 'bid' : 'ask'; // alternate long/short

    const orderId = await client.placeMarket(symbol, side, amount, `disposition open ${i + 1}/6`);
    if (orderId !== null) {
      opened.push({ symbol, side, amount });
      console.log(`  [disposition] Opened ${i + 1}/6: ${side === 'bid' ? 'LONG' : 'SHORT'} ${amount} ${symbol}  order=${orderId}`);
    }
    await jitter();
  }

  if (opened.length === 0) {
    console.log('[disposition] No positions opened. Aborting.');
    return;
  }

  // Wait 1-2 min, then check which positions are in profit
  const checkDelaySec = randomInt(60, 120);
  console.log(`\n[disposition] ${opened.length} positions open. Checking P&L in ${checkDelaySec}s...`);
  await sleep(checkDelaySec * 1000);

  const [positions, markPrices] = await Promise.all([
    client.getPositions(),
    client.getMarkPrices(),
  ]);

  const posMap = new Map(positions.map((p) => [p.symbol, p]));

  const winners: OpenPos[] = [];
  const losers: OpenPos[]  = [];

  for (const op of opened) {
    const pos  = posMap.get(op.symbol);
    const mark = markPrices[op.symbol];

    let isWinner: boolean;
    if (pos && mark) {
      const entry = parseFloat(pos.entry_price);
      isWinner = op.side === 'bid' ? mark > entry : mark < entry;
    } else {
      // Position may not be visible yet or API failed — random fallback
      // The hold-time ratio is what drives the detection, not exact P&L
      isWinner = Math.random() > 0.5;
    }

    (isWinner ? winners : losers).push(op);
  }

  // Guarantee at least one in each bucket so the ratio is meaningful
  if (winners.length === 0 && losers.length > 0) winners.push(losers.pop()!);
  if (losers.length === 0 && winners.length > 0) losers.push(winners.pop()!);

  // Close winners immediately (disposition effect: cutting profits short)
  console.log(`\n[disposition] Closing ${winners.length} winner(s) — taking profit early...`);
  for (const op of winners) {
    const orderId = await client.closePosition(op.symbol, op.side, op.amount, 'close-winner');
    if (orderId !== null) {
      console.log(`  [disposition] Closed winner: ${op.symbol}  order=${orderId}`);
    }
    await jitter();
  }

  // Hold losers another 5-10 min before closing (disposition effect: riding losses)
  const loserWaitSec = randomInt(5 * 60, 10 * 60);
  console.log(`\n[disposition] Holding ${losers.length} loser(s) for ${Math.round(loserWaitSec / 60)} more min...`);
  await sleep(loserWaitSec * 1000);

  console.log(`[disposition] Closing ${losers.length} loser(s)...`);
  for (const op of losers) {
    const orderId = await client.closePosition(op.symbol, op.side, op.amount, 'close-loser');
    if (orderId !== null) {
      console.log(`  [disposition] Closed loser: ${op.symbol}  order=${orderId}`);
    }
    await jitter();
  }

  console.log('[disposition] Done.');
}

// ─── Mode: discipline ─────────────────────────────────────────────────────────
//
// Creates a high-adherence pattern the playbook analyzer should recognize:
//   - Always enters in the direction of the trend
//   - Consistent sizing and pacing throughout

async function runDiscipline(client: TestnetOrderClient, count: number): Promise<void> {
  const symbol = 'BTC-PERP';
  const amount = NORMAL_SIZE[symbol];

  console.log(`[discipline] ${count} rule-based trend-following trades on ${symbol}...`);

  for (let i = 0; i < count; i++) {
    const trend = await client.getCandleDirection(symbol);
    const side: 'bid' | 'ask' = trend === 'up' ? 'bid' : 'ask'; // always with-trend

    const orderId = await client.placeMarket(symbol, side, amount, `discipline ${i + 1}/${count}`);
    if (orderId !== null) {
      console.log(`  [discipline] ${i + 1}/${count}: ${side === 'bid' ? 'LONG' : 'SHORT'} ${amount} ${symbol}  trend=${trend}  order=${orderId}`);
    }

    // Consistent unhurried pacing — part of the rule set
    await sleep(randomMs(4, 6));
  }

  console.log('[discipline] Done.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Hard stop — this script must never touch mainnet
  if (process.env.PACIFICA_NETWORK === 'mainnet') {
    console.error('ERROR: PACIFICA_NETWORK=mainnet is set. This script is testnet-only. Aborting.');
    process.exit(1);
  }

  const { mode, count, wallet, dryRun } = parseArgs();

  const validModes = ['tilt', 'fatigue', 'disposition', 'discipline', 'all'];
  if (!validModes.includes(mode)) {
    console.error(`Unknown mode: "${mode}". Valid: ${validModes.join(', ')}`);
    process.exit(1);
  }

  const walletAddress = wallet ?? process.env.DEFAULT_WALLET_ADDRESS;
  if (!walletAddress) {
    console.error('No wallet address. Pass --wallet=<address> or set DEFAULT_WALLET_ADDRESS.');
    process.exit(1);
  }

  let baseClient: PacificaBaseClient;

  if (dryRun) {
    baseClient = new PacificaBaseClient({
      restUrl: TESTNET_API_URL,
      walletAddress,
      apiConfigKey: process.env.PF_API_KEY,
    });
  } else {
    const privateKey      = process.env.PACIFICA_PRIVATE_KEY;
    const agentPrivateKey = process.env.PACIFICA_AGENT_PRIVATE_KEY;

    if (!privateKey && !agentPrivateKey) {
      console.error(
        'No signing key found.\n' +
        '  Set PACIFICA_PRIVATE_KEY (direct wallet) or PACIFICA_AGENT_PRIVATE_KEY (agent mode).\n' +
        '  Or pass --dry-run to simulate without placing real orders.',
      );
      process.exit(1);
    }

    baseClient = new PacificaBaseClient({
      restUrl: TESTNET_API_URL,
      walletAddress,
      ...(agentPrivateKey ? { agentPrivateKey } : { privateKey }),
      apiConfigKey: process.env.PF_API_KEY,
    });
  }

  const client = new TestnetOrderClient(baseClient, dryRun);

  console.log('Booba testnet-trade');
  console.log(`  mode    : ${mode}`);
  console.log(`  wallet  : ${walletAddress}`);
  console.log(`  url     : ${TESTNET_API_URL}`);
  console.log(`  dry-run : ${dryRun}`);

  if (dryRun) {
    console.log('\n[dry-run] No real orders will be placed.\n');
  } else {
    await confirmStart();
  }

  switch (mode) {
    case 'tilt':
      await runTilt(client, count ?? 5);
      break;

    case 'fatigue':
      await runFatigue(client, count ?? 17);
      break;

    case 'disposition':
      await runDisposition(client);
      break;

    case 'discipline':
      await runDiscipline(client, count ?? 6);
      break;

    case 'all':
      await runTilt(client, 5);
      console.log('\n[all] Waiting 5 min before fatigue...\n');
      await sleep(5 * 60 * 1000);

      await runFatigue(client, 17);
      console.log('\n[all] Waiting 5 min before disposition...\n');
      await sleep(5 * 60 * 1000);

      await runDisposition(client);
      console.log('\n[all] Waiting 5 min before discipline...\n');
      await sleep(5 * 60 * 1000);

      await runDiscipline(client, 6);
      break;
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

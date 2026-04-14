/**
 * seed-trades.ts — Synthetic trade history generator.
 *
 * Simulates historically-anchored trade histories for three demo profiles.
 * All entry and exit prices are real prices from the CandleCache — never
 * randomly generated. Regime lookups use the BTC 1h snapshots populated by
 * seed-candles.ts.
 *
 * Two Trade (fill) records are created per simulated round-trip:
 *   • open fill  — side: 'open_long'/'open_short', entryTime set, no exit
 *   • close fill — side: 'close_long'/'close_short', exitTime + pnlRealized set
 *
 * Both fills share the same order_id in rawData so FillToOrderLevel groups
 * them into one OrderGroup. The combined exposure delta (open+close = 0) tells
 * OrderToPositionLevel to emit a closed Position immediately.
 *
 * After all fills are inserted, the standard grouping pipeline and analytics
 * metrics computer (MFE/MAE, timing, xPnL, Elo) are run exactly as they
 * would be for real imported data.
 *
 * Usage (standalone):
 *   npx tsx src/scripts/seed-trades.ts [disciplined|struggling|degen]
 *   npx tsx src/scripts/seed-trades.ts clean <walletAddress>
 */

import { prisma } from '../lib/prisma';
import { getCandleCache } from '../services/candles';
import { GroupingService } from '../services/grouping';
import type { Candle } from '../services/regime/types';

const DAYS_BACK = 14;

// ─── Trader profile interface ─────────────────────────────────────────────────

export interface TraderProfile {
  name: string;
  walletAddress: string;
  tradeCount: number;

  baseWinRate: number;
  avgWinPct: number;
  avgLossPct: number;
  avgTradesPerDay: number;
  preferredAssets: { asset: string; weight: number }[];
  preferredDirection: 'long_biased' | 'short_biased' | 'balanced';

  tiltAfterLoss: boolean;
  tiltWinRateDrop: number;
  sessionFatigue: boolean;
  fatigueAfterTrade: number;
  fatigueWinRateDrop: number;

  sizingBehavior: 'consistent' | 'martingale' | 'erratic';
  baseSizeUsd: number;
  sizeMultiplierAfterLoss: number;

  exitBehavior: 'early' | 'optimal' | 'late';
  exitCaptureRatio: number;

  regimeAwareness: boolean;
  bestRegime: string;
  worstRegime: string;
  regimeWinRateBonus: number;
  regimeWinRatePenalty: number;

  liquidationCount: number;
  revengeTradeRate: number;
}

// ─── Profile definitions ──────────────────────────────────────────────────────

export const DISCIPLINED_PROFILE: TraderProfile = {
  name: 'Disciplined Trader',
  walletAddress: 'DemoDiscip1ined000000000000000000000000000001',
  tradeCount: 200,
  baseWinRate: 0.52,
  avgWinPct: 1.8,
  avgLossPct: 1.0,
  avgTradesPerDay: 15,
  preferredAssets: [
    { asset: 'BTC', weight: 0.4 },
    { asset: 'ETH', weight: 0.35 },
    { asset: 'SOL', weight: 0.25 },
  ],
  preferredDirection: 'balanced',
  tiltAfterLoss: false,
  tiltWinRateDrop: 0,
  sessionFatigue: false,
  fatigueAfterTrade: 99,
  fatigueWinRateDrop: 0,
  sizingBehavior: 'consistent',
  baseSizeUsd: 500,
  sizeMultiplierAfterLoss: 1.0,
  exitBehavior: 'optimal',
  exitCaptureRatio: 0.65,
  regimeAwareness: true,
  bestRegime: 'Trending',
  worstRegime: 'Ranging',
  regimeWinRateBonus: 0.08,
  regimeWinRatePenalty: 0.05,
  liquidationCount: 0,
  revengeTradeRate: 0.05,
};

export const STRUGGLING_PROFILE: TraderProfile = {
  name: 'Struggling Trader',
  walletAddress: 'DemoStrugg1ing0000000000000000000000000000002',
  tradeCount: 250,
  baseWinRate: 0.42,
  avgWinPct: 1.2,
  avgLossPct: 1.5,
  avgTradesPerDay: 22,
  preferredAssets: [
    { asset: 'BTC', weight: 0.3 },
    { asset: 'ETH', weight: 0.3 },
    { asset: 'SOL', weight: 0.4 },
  ],
  preferredDirection: 'long_biased',
  tiltAfterLoss: true,
  tiltWinRateDrop: 0.15,
  sessionFatigue: true,
  fatigueAfterTrade: 18,
  fatigueWinRateDrop: 0.12,
  sizingBehavior: 'martingale',
  baseSizeUsd: 400,
  sizeMultiplierAfterLoss: 1.6,
  exitBehavior: 'early',
  exitCaptureRatio: 0.30,
  regimeAwareness: false,
  bestRegime: 'Trending',
  worstRegime: 'Ranging HV',
  regimeWinRateBonus: 0.05,
  regimeWinRatePenalty: 0.12,
  liquidationCount: 2,
  revengeTradeRate: 0.35,
};

export const DEGEN_PROFILE: TraderProfile = {
  name: 'Degen Trader',
  walletAddress: 'DemoDegen00000000000000000000000000000000003',
  tradeCount: 150,
  baseWinRate: 0.38,
  avgWinPct: 2.5,
  avgLossPct: 3.0,
  avgTradesPerDay: 25,
  preferredAssets: [
    { asset: 'SOL', weight: 0.5 },
    { asset: 'ETH', weight: 0.3 },
    { asset: 'BTC', weight: 0.2 },
  ],
  preferredDirection: 'long_biased',
  tiltAfterLoss: true,
  tiltWinRateDrop: 0.20,
  sessionFatigue: true,
  fatigueAfterTrade: 12,
  fatigueWinRateDrop: 0.15,
  sizingBehavior: 'erratic',
  baseSizeUsd: 800,
  sizeMultiplierAfterLoss: 2.0,
  exitBehavior: 'late',
  exitCaptureRatio: 0.15,
  regimeAwareness: false,
  bestRegime: 'Trending HV',
  worstRegime: 'Ranging',
  regimeWinRateBonus: 0.03,
  regimeWinRatePenalty: 0.15,
  liquidationCount: 5,
  revengeTradeRate: 0.50,
};

// ─── Cleanup utility ──────────────────────────────────────────────────────────

export async function cleanDemoData(walletAddress: string): Promise<void> {
  // Alert.relatedTradeId and FundingHistory.tradeId reference Trade rows,
  // so we must clear those FKs before deleting Trades. Then unlink Trades
  // from OrderGroups before deleting OrderGroups/Positions in order.
  await prisma.alert.deleteMany({ where: { walletAddress } });
  await prisma.fundingHistory.deleteMany({ where: { walletAddress } });
  await prisma.trade.updateMany({
    where:  { walletAddress },
    data:   { orderGroupId: null },
  });
  await prisma.orderGroup.deleteMany({ where: { walletAddress } });
  await prisma.position.deleteMany({ where: { walletAddress } });
  await prisma.trade.deleteMany({ where: { walletAddress } });
  await prisma.signal.deleteMany({ where: { walletAddress } });
  await prisma.playbook.deleteMany({ where: { walletAddress } });
  await prisma.boobaObservation.deleteMany({ where: { walletAddress } });
  await prisma.analysisSnapshot.deleteMany({ where: { walletAddress } });
  await prisma.journal.deleteMany({ where: { walletAddress } });
  console.log(`[seed] Cleaned demo data for ${walletAddress}`);
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export async function generateTrades(profile: TraderProfile): Promise<void> {
  // ── Idempotency check ───────────────────────────────────────────────────────
  const existing = await prisma.trade.count({ where: { walletAddress: profile.walletAddress } });
  if (existing > 0) {
    console.log(`[seed] Found ${existing} existing fills for ${profile.name} — cleaning first...`);
    await cleanDemoData(profile.walletAddress);
  }

  // ── Candle loading ──────────────────────────────────────────────────────────
  const cache      = getCandleCache();
  const now        = new Date();
  const periodStart = new Date(now.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000);
  // Fetch with a 2-hour pre-roll so the first few trades have forward candles.
  const fetchStart  = new Date(periodStart.getTime() - 2 * 3_600_000);

  const candlesByAsset = new Map<string, Candle[]>();
  for (const { asset } of profile.preferredAssets) {
    const candles = await cache.getCandles(asset, '1m', fetchStart, now);
    candlesByAsset.set(asset, candles);
    console.log(`[seed] Loaded ${candles.length} 1m candles for ${asset}`);
  }

  // ── Regime snapshot pre-load ────────────────────────────────────────────────
  const regimeRows = await prisma.regimeSnapshot.findMany({
    where: {
      asset:     'BTC',
      timeframe: '1h',
      timestamp: { gte: new Date(periodStart.getTime() - 2 * 3_600_000), lte: now },
    },
    orderBy: { timestamp: 'asc' },
    select:  { timestamp: true, regimeClassification: true },
  });
  const regimeTimes  = regimeRows.map((r) => r.timestamp.getTime());
  const regimeLabels = regimeRows.map((r) => r.regimeClassification);

  function findRegime(ms: number): string | null {
    let lo = 0, hi = regimeTimes.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (regimeTimes[mid] <= ms) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx >= 0 ? regimeLabels[idx] : null;
  }

  // ── Liquidation scheduling ──────────────────────────────────────────────────
  const liquidationIndices = new Set<number>();
  if (profile.liquidationCount > 0) {
    const step = Math.floor(profile.tradeCount / (profile.liquidationCount + 1));
    for (let i = 1; i <= profile.liquidationCount; i++) {
      liquidationIndices.add(step * i);
    }
  }

  // ── Simulation state ────────────────────────────────────────────────────────
  const totalMs     = DAYS_BACK * 24 * 60 * 60 * 1000;
  const avgInterval = totalMs / profile.tradeCount;

  let clockMs           = periodStart.getTime();
  let consecutiveLosses = 0;
  let lastTradeWasLoss  = false;
  let lastSizeUsd       = profile.baseSizeUsd;
  let revengeNext       = false;
  const dailyCount      = new Map<string, number>();
  const profilePrefix   = profile.walletAddress.slice(0, 12);

  let tradeIdx  = 0;
  let wins      = 0;
  let losses    = 0;
  let totalPnl  = 0;
  let liqsLeft  = profile.liquidationCount;

  while (tradeIdx < profile.tradeCount) {
    // ── Advance clock ─────────────────────────────────────────────────────────
    if (revengeNext) {
      clockMs    += Math.floor(rand(60_000, 300_000));
      revengeNext = false;
    } else {
      clockMs += Math.floor(avgInterval * rand(0.7, 1.3));
    }
    if (clockMs >= Date.now() - 60_000) break;

    const tradeTime = new Date(clockMs);
    const dayKey    = tradeTime.toISOString().slice(0, 10);
    const todayN    = dailyCount.get(dayKey) ?? 0;

    // ── Select asset ──────────────────────────────────────────────────────────
    const asset   = weightedPick(profile.preferredAssets.map((a) => ({ item: a.asset, weight: a.weight })));
    const candles = candlesByAsset.get(asset);
    if (!candles || candles.length === 0) continue;

    // ── Find entry candle ─────────────────────────────────────────────────────
    const entryIdx = lastCandleAtOrBefore(candles, clockMs);
    if (entryIdx < 0) continue;
    const entryCandle = candles[entryIdx];
    const entryPrice  = entryCandle.close;

    // ── Direction ────────────────────────────────────────────────────────────
    const longProb  = profile.preferredDirection === 'long_biased' ? 0.65
      : profile.preferredDirection === 'short_biased' ? 0.35 : 0.50;
    const direction = Math.random() < longProb ? 'long' : 'short';

    // ── Regime ──────────────────────────────────────────────────────────────
    const regime = findRegime(clockMs);

    // ── Effective win rate ────────────────────────────────────────────────────
    let wr = profile.baseWinRate;
    if (profile.tiltAfterLoss && consecutiveLosses >= 2)
      wr -= profile.tiltWinRateDrop;
    if (profile.sessionFatigue && todayN >= profile.fatigueAfterTrade)
      wr -= profile.fatigueWinRateDrop;
    if (profile.regimeAwareness) {
      if (regimeMatches(regime, profile.bestRegime))  wr += profile.regimeWinRateBonus;
      if (regimeMatches(regime, profile.worstRegime)) wr -= profile.regimeWinRatePenalty;
    }
    wr = Math.max(0.1, Math.min(0.9, wr));

    // ── Outcome ──────────────────────────────────────────────────────────────
    const isLiquidation = liqsLeft > 0 && liquidationIndices.has(tradeIdx);
    const isWin         = !isLiquidation && Math.random() < wr;

    // ── Position sizing ───────────────────────────────────────────────────────
    let sizeUsd: number;
    if (profile.sizingBehavior === 'martingale' && lastTradeWasLoss) {
      sizeUsd = lastSizeUsd * profile.sizeMultiplierAfterLoss;
    } else if (profile.sizingBehavior === 'erratic') {
      sizeUsd = profile.baseSizeUsd * rand(0.3, 3.0);
    } else {
      sizeUsd = profile.baseSizeUsd * rand(0.85, 1.15);
    }
    sizeUsd      = Math.min(sizeUsd, profile.baseSizeUsd * 6);
    lastSizeUsd  = sizeUsd;
    const sizeInAsset = sizeUsd / entryPrice;

    // ── Exit simulation (walk real candles forward) ───────────────────────────
    const forward = candles.slice(entryIdx, entryIdx + 55);
    let exitPrice: number;
    let exitMs:    number;
    let cause:     string;

    if (isLiquidation) {
      const liquidPct = rand(5, 15) / 100;
      exitPrice = direction === 'long'
        ? entryPrice * (1 - liquidPct)
        : entryPrice * (1 + liquidPct);
      const liqCandleIdx = findAdverseCandle(forward, direction, exitPrice);
      exitMs    = forward[liqCandleIdx].timestamp.getTime();
      cause     = 'market_liquidation';
      liqsLeft--;
    } else if (isWin) {
      const res = simulateWinExit(forward, direction, entryPrice, profile.exitCaptureRatio, profile.avgWinPct);
      exitPrice = res.exitPrice;
      exitMs    = res.exitMs;
      cause     = 'normal';
    } else {
      const res = simulateLossExit(forward, direction, entryPrice, profile.avgLossPct);
      exitPrice = res.exitPrice;
      exitMs    = res.exitMs;
      cause     = 'normal';
    }

    // ── P&L ──────────────────────────────────────────────────────────────────
    const pnlRealized = direction === 'long'
      ? (exitPrice - entryPrice) * sizeInAsset
      : (entryPrice - exitPrice) * sizeInAsset;
    const fee  = sizeUsd * 0.0005; // 0.05% taker fee per side
    const entryTime = new Date(entryCandle.timestamp.getTime());
    const exitTime  = new Date(exitMs);

    // ── Write Trade records ───────────────────────────────────────────────────
    // Shared order_id causes FillToOrderLevel to group these two fills into
    // one OrderGroup. The combined exposure delta (open +X, close -X = 0)
    // causes OrderToPositionLevel to emit a closed Position immediately.
    const orderId  = `demo_order_${profilePrefix}_${tradeIdx}`;
    const openSide = direction === 'long' ? 'open_long'  : 'open_short';
    const closeSide= direction === 'long' ? 'close_long' : 'close_short';
    const tradeType = isLiquidation ? 'liquidation_acquisition' : 'directional';

    await prisma.trade.create({
      data: {
        id:           `demo_open_${profilePrefix}_${tradeIdx}`,
        walletAddress: profile.walletAddress,
        asset,
        direction,
        size:          sizeInAsset,
        entryPrice,
        exitPrice:     null,
        entryTime,
        exitTime:      null,
        pnlRealized:   null,
        fees:          fee,
        captureMode:  'retroactive',
        tradeType:    'directional',
        cause:        'normal',
        regimeAtEntry: regime,
        rawData:       JSON.stringify({ side: openSide, order_id: orderId }),
      },
    });

    await prisma.trade.create({
      data: {
        id:           `demo_close_${profilePrefix}_${tradeIdx}`,
        walletAddress: profile.walletAddress,
        asset,
        direction,
        size:          sizeInAsset,
        entryPrice,
        exitPrice,
        entryTime:     null,
        exitTime,
        pnlRealized,
        fees:          fee,
        captureMode:  'retroactive',
        tradeType,
        cause,
        regimeAtEntry: regime,
        rawData:       JSON.stringify({ side: closeSide, order_id: orderId }),
      },
    });

    // ── State updates ─────────────────────────────────────────────────────────
    if (isWin) {
      wins++;
      consecutiveLosses = 0;
      lastTradeWasLoss  = false;
    } else {
      losses++;
      consecutiveLosses++;
      lastTradeWasLoss = true;
    }

    totalPnl += pnlRealized - fee * 2;
    dailyCount.set(dayKey, todayN + 1);
    tradeIdx++;

    if (!isWin && Math.random() < profile.revengeTradeRate) {
      revengeNext = true;
    }
  }

  console.log(`[seed] Inserted ${tradeIdx * 2} fills (${tradeIdx} round-trips) for ${profile.name}`);

  // ── Grouping ──────────────────────────────────────────────────────────────
  console.log(`[seed] Running grouping pipeline for ${profile.name}...`);
  const groupingService = new GroupingService();
  const groupSummary    = await groupingService.groupAllFills(profile.walletAddress);
  console.log(
    `[seed] Grouping complete: ${groupSummary.totalPositions} positions ` +
    `(${groupSummary.totalOrders} orders from ${groupSummary.totalFills} fills)`,
  );

  // ── Analytics metrics (MFE/MAE, timing, xPnL, Elo) ──────────────────────
  console.log(`[seed] Computing analytics metrics for ${profile.name}...`);
  const { createAnalyticsService } = await import('../services/analytics');
  const analyticsService = createAnalyticsService();
  const metricSummary    = await analyticsService.computeMetrics(profile.walletAddress);
  console.log(
    `[seed] Metrics: ${metricSummary.computed} computed, ${metricSummary.skipped} skipped`,
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  const actualWinRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  console.log(
    `[seed] Done: ${profile.name} — ` +
    `${tradeIdx} trades, win rate ${(actualWinRate * 100).toFixed(1)}%, ` +
    `P&L $${totalPnl.toFixed(2)}`,
  );
}

// ─── Exit simulation helpers ──────────────────────────────────────────────────

function simulateWinExit(
  forward: Candle[],
  direction: 'long' | 'short',
  entry: number,
  captureRatio: number,
  avgWinPct: number,
): { exitPrice: number; exitMs: number } {
  if (forward.length < 2) {
    const fallback = entry * (1 + (direction === 'long' ? 1 : -1) * avgWinPct * 0.5 / 100);
    return { exitPrice: fallback, exitMs: forward[0]?.timestamp.getTime() ?? Date.now() };
  }

  // Walk forward candles (skip the entry candle itself) to find the MFE.
  let mfe = entry;
  for (let i = 1; i < Math.min(forward.length, 51); i++) {
    const c = forward[i];
    mfe = direction === 'long'
      ? Math.max(mfe, c.high)
      : Math.min(mfe, c.low);
  }

  // Target exit = entry + (MFE - entry) * captureRatio
  const mfeDelta    = direction === 'long' ? mfe - entry : entry - mfe;
  const targetDelta = mfeDelta > 0
    ? mfeDelta * captureRatio
    : entry * avgWinPct * 0.3 / 100; // market never moved favorably — use floor

  const targetExit = direction === 'long'
    ? entry + targetDelta
    : entry - targetDelta;

  // Find first candle where price reaches the target.
  for (let i = 1; i < Math.min(forward.length, 51); i++) {
    const c = forward[i];
    if (direction === 'long' && c.high >= targetExit)
      return { exitPrice: targetExit, exitMs: c.timestamp.getTime() };
    if (direction === 'short' && c.low <= targetExit)
      return { exitPrice: targetExit, exitMs: c.timestamp.getTime() };
  }

  // Target never reached — exit at the last available candle.
  const last = forward[Math.min(forward.length - 1, 50)];
  if ((direction === 'long' && last.close > entry) || (direction === 'short' && last.close < entry)) {
    return { exitPrice: last.close, exitMs: last.timestamp.getTime() };
  }
  // Last close wasn't favourable — force minimum win to preserve intended outcome.
  const forced = direction === 'long'
    ? entry * (1 + avgWinPct * 0.3 / 100)
    : entry * (1 - avgWinPct * 0.3 / 100);
  return { exitPrice: forced, exitMs: last.timestamp.getTime() };
}

function simulateLossExit(
  forward: Candle[],
  direction: 'long' | 'short',
  entry: number,
  avgLossPct: number,
): { exitPrice: number; exitMs: number } {
  if (forward.length < 2) {
    const fallback = entry * (1 + (direction === 'long' ? -1 : 1) * avgLossPct / 100);
    return { exitPrice: fallback, exitMs: forward[0]?.timestamp.getTime() ?? Date.now() };
  }

  // Loss target with ±30% randomness around avgLossPct.
  const lossPct    = avgLossPct * rand(0.7, 1.3);
  const lossTarget = direction === 'long'
    ? entry * (1 - lossPct / 100)
    : entry * (1 + lossPct / 100);

  for (let i = 1; i < Math.min(forward.length, 51); i++) {
    const c = forward[i];
    if (direction === 'long' && c.low  <= lossTarget)
      return { exitPrice: lossTarget, exitMs: c.timestamp.getTime() };
    if (direction === 'short' && c.high >= lossTarget)
      return { exitPrice: lossTarget, exitMs: c.timestamp.getTime() };
  }

  // Stop level not hit — use last close if it's in the loss direction.
  const last = forward[Math.min(forward.length - 1, 50)];
  if ((direction === 'long' && last.close < entry) || (direction === 'short' && last.close > entry)) {
    return { exitPrice: last.close, exitMs: last.timestamp.getTime() };
  }
  // Market moved favorably on this "loss" — force a minimum loss.
  const forced = direction === 'long'
    ? entry * (1 - avgLossPct * 0.3 / 100)
    : entry * (1 + avgLossPct * 0.3 / 100);
  return { exitPrice: forced, exitMs: last.timestamp.getTime() };
}

function findAdverseCandle(
  forward: Candle[],
  direction: 'long' | 'short',
  liquidationPrice: number,
): number {
  for (let i = 1; i < forward.length; i++) {
    const c = forward[i];
    if (direction === 'long' && c.low  <= liquidationPrice) return i;
    if (direction === 'short' && c.high >= liquidationPrice) return i;
  }
  return Math.min(forward.length - 1, 30);
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function weightedPick<T>(items: { item: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const { item, weight } of items) {
    r -= weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1].item;
}

/** Binary search — index of last candle whose timestamp ≤ `ms`. Returns -1 if none. */
function lastCandleAtOrBefore(candles: Candle[], ms: number): number {
  let lo = 0, hi = candles.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].timestamp.getTime() <= ms) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return idx;
}

function regimeMatches(regime: string | null, profileLabel: string): boolean {
  if (!regime) return false;
  const r = regime.toLowerCase();
  const p = profileLabel.toLowerCase();
  if (p === 'trending')    return r.startsWith('trending');
  if (p === 'ranging')     return r.startsWith('ranging');
  if (p === 'trending hv') return r === 'trending_high_vol';
  if (p === 'ranging hv')  return r === 'ranging_high_vol';
  if (p === 'trending lv') return r === 'trending_low_vol';
  if (p === 'ranging lv')  return r === 'ranging_low_vol';
  return r.includes(p.replace(' ', '_'));
}

// ─── Standalone entry point ───────────────────────────────────────────────────

if (require.main === module) {
  const arg = process.argv[2];

  if (arg === 'clean') {
    const wallet = process.argv[3];
    if (!wallet) {
      console.error('Usage: tsx src/scripts/seed-trades.ts clean <walletAddress>');
      process.exit(1);
    }
    cleanDemoData(wallet)
      .catch((e) => { console.error(e); process.exit(1); })
      .finally(() => prisma.$disconnect());
  } else {
    const profile = arg === 'struggling' ? STRUGGLING_PROFILE
      : arg === 'degen'       ? DEGEN_PROFILE
      : DISCIPLINED_PROFILE;

    generateTrades(profile)
      .catch((e) => { console.error(e); process.exit(1); })
      .finally(() => prisma.$disconnect());
  }
}

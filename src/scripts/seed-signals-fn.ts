/**
 * seed-signals-fn.ts — Importable version of seed-signals.ts.
 *
 * Mirrors the CLI script but exposes the run logic as a function so it can
 * be invoked from an API route. The CLI script remains the source of truth
 * for the SEEDS / OPEN_TEMPLATES fixtures — keep them in sync if either
 * file changes.
 */

import { prisma } from '../lib/prisma';
import { getCandleCache } from '../services/candles';

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function resolvedAt(created: Date, hoursAfter: number): Date {
  return new Date(created.getTime() + hoursAfter * 3_600_000);
}

function pnlPct(entry: number, outcome: number, direction: 'LONG' | 'SHORT'): number {
  return direction === 'LONG'
    ? ((outcome - entry) / entry) * 100
    : ((entry - outcome) / entry) * 100;
}

function rMultiple(
  entry: number,
  outcome: number,
  stop: number | null,
  direction: 'LONG' | 'SHORT',
): number | null {
  if (stop == null) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  const reward = direction === 'LONG' ? outcome - entry : entry - outcome;
  return reward / risk;
}

// ── Signal definitions ───────────────────────────────────────────────────────

type Status = 'open' | 'hit_target' | 'hit_stop' | 'partial_target' | 'expired' | 'closed_manual';

interface SignalSeed {
  callerName: string;
  source: string;
  channelName: string;
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  targetPrice: number | null;
  targetPrices: number[] | null;   // null → single-TP signal (targetPrice used)
  stopPrice: number | null;
  status: Status;
  outcomePrice: number | null;     // for partial_target: weighted average price
  targetPricesHit: boolean[] | null; // which TPs were hit (null for non-multi-TP signals)
  createdDaysAgo: number;  // days ago the signal was posted
  resolvedHours: number;   // hours after creation it resolved (0 if still open)
}

const SEEDS: SignalSeed[] = [
  // ── AlphaTrader — 20 single-TP + 6 laddered signals, ~65% hit rate ──────
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 79000, targetPrice: 84000, targetPrices: null, stopPrice: 76000, status: 'hit_target', outcomePrice: 84000, targetPricesHit: null, createdDaysAgo: 85, resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 2900,  targetPrice: 3200,  targetPrices: null, stopPrice: 2750,  status: 'hit_target', outcomePrice: 3200,  targetPricesHit: null, createdDaysAgo: 80, resolvedHours: 36 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 135,   targetPrice: 155,   targetPrices: null, stopPrice: 125,   status: 'hit_target', outcomePrice: 155,   targetPricesHit: null, createdDaysAgo: 75, resolvedHours: 24 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 87000, targetPrice: 81000, targetPrices: null, stopPrice: 90000, status: 'hit_target', outcomePrice: 81000, targetPricesHit: null, createdDaysAgo: 72, resolvedHours: 60 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'SHORT', entryPrice: 3500,  targetPrice: 3100,  targetPrices: null, stopPrice: 3650,  status: 'hit_target', outcomePrice: 3100,  targetPricesHit: null, createdDaysAgo: 68, resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 75000, targetPrice: 80000, targetPrices: null, stopPrice: 72000, status: 'hit_stop',   outcomePrice: 72000, targetPricesHit: null, createdDaysAgo: 64, resolvedHours: 18 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 142,   targetPrice: 165,   targetPrices: null, stopPrice: 132,   status: 'hit_target', outcomePrice: 165,   targetPricesHit: null, createdDaysAgo: 60, resolvedHours: 72 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 78000, targetPrice: 86000, targetPrices: null, stopPrice: 74000, status: 'hit_target', outcomePrice: 86000, targetPricesHit: null, createdDaysAgo: 55, resolvedHours: 96 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 3050,  targetPrice: 3400,  targetPrices: null, stopPrice: 2900,  status: 'hit_stop',   outcomePrice: 2900,  targetPricesHit: null, createdDaysAgo: 50, resolvedHours: 30 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 91000, targetPrice: 84000, targetPrices: null, stopPrice: 94000, status: 'hit_target', outcomePrice: 84000, targetPricesHit: null, createdDaysAgo: 46, resolvedHours: 84 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'SHORT', entryPrice: 175,   targetPrice: 155,   targetPrices: null, stopPrice: 183,   status: 'hit_target', outcomePrice: 155,   targetPricesHit: null, createdDaysAgo: 42, resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 2800,  targetPrice: 3100,  targetPrices: null, stopPrice: 2650,  status: 'hit_target', outcomePrice: 3100,  targetPricesHit: null, createdDaysAgo: 38, resolvedHours: 60 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 82000, targetPrice: 89000, targetPrices: null, stopPrice: 78000, status: 'hit_target', outcomePrice: 89000, targetPricesHit: null, createdDaysAgo: 33, resolvedHours: 120 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 120,   targetPrice: 145,   targetPrices: null, stopPrice: 110,   status: 'hit_stop',   outcomePrice: 110,   targetPricesHit: null, createdDaysAgo: 28, resolvedHours: 12 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 95000, targetPrice: 87000, targetPrices: null, stopPrice: 98000, status: 'hit_target', outcomePrice: 87000, targetPricesHit: null, createdDaysAgo: 23, resolvedHours: 72 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'SHORT', entryPrice: 3800,  targetPrice: 3300,  targetPrices: null, stopPrice: 4000,  status: 'hit_target', outcomePrice: 3300,  targetPricesHit: null, createdDaysAgo: 18, resolvedHours: 96 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 80000, targetPrice: 88000, targetPrices: null, stopPrice: 76000, status: 'hit_stop',   outcomePrice: 76000, targetPricesHit: null, createdDaysAgo: 14, resolvedHours: 24 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 128,   targetPrice: 148,   targetPrices: null, stopPrice: 118,   status: 'hit_target', outcomePrice: 148,   targetPricesHit: null, createdDaysAgo: 9,  resolvedHours: 48 },

  // AlphaTrader — laddered calls (3 TPs each) ──────────────────────────────
  // SOL long: all 3 TPs hit — full winner
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 103,   targetPrice: 110,   targetPrices: [110, 114, 120], stopPrice: 99,    status: 'hit_target',    outcomePrice: 120,   targetPricesHit: [true,  true,  true ], createdDaysAgo: 71, resolvedHours: 56  },
  // BTC long: TP1 + TP2 hit, then stopped — partial (2/3 = 0.67 win)
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 81000, targetPrice: 85000, targetPrices: [85000, 89000, 93000], stopPrice: 78000, status: 'partial_target', outcomePrice: (85000 + 89000 + 78000) / 3, targetPricesHit: [true, true, false], createdDaysAgo: 61, resolvedHours: 72 },
  // ETH short: all 3 TPs hit — full winner
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'SHORT', entryPrice: 3600,  targetPrice: 3400,  targetPrices: [3400, 3200, 3000], stopPrice: 3750,  status: 'hit_target',    outcomePrice: 3000,  targetPricesHit: [true,  true,  true ], createdDaysAgo: 52, resolvedHours: 96  },
  // SOL long: only TP1 hit, then stopped — partial (1/3 = 0.33 win)
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 115,   targetPrice: 122,   targetPrices: [122, 130, 140], stopPrice: 110,   status: 'partial_target', outcomePrice: (122 + 110 + 110) / 3, targetPricesHit: [true, false, false], createdDaysAgo: 40, resolvedHours: 36 },
  // BTC short: all 3 TPs hit — full winner
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 97000, targetPrice: 92000, targetPrices: [92000, 88000, 84000], stopPrice: 100000, status: 'hit_target',   outcomePrice: 84000, targetPricesHit: [true,  true,  true ], createdDaysAgo: 30, resolvedHours: 120 },
  // ── DegenKing — 15 signals, ~53% hit rate, volatile ─────────────────────
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'LONG',  entryPrice: 145,   targetPrice: 175,   targetPrices: null, stopPrice: 130,   status: 'hit_target', outcomePrice: 175,   targetPricesHit: null, createdDaysAgo: 82, resolvedHours: 36  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 76000, targetPrice: 84000, targetPrices: null, stopPrice: 70000, status: 'hit_stop',   outcomePrice: 70000, targetPricesHit: null, createdDaysAgo: 76, resolvedHours: 18  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'SHORT', entryPrice: 3400,  targetPrice: 2900,  targetPrices: null, stopPrice: 3600,  status: 'hit_target', outcomePrice: 2900,  targetPricesHit: null, createdDaysAgo: 70, resolvedHours: 72  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'SHORT', entryPrice: 170,   targetPrice: 140,   targetPrices: null, stopPrice: 185,   status: 'hit_stop',   outcomePrice: 185,   targetPricesHit: null, createdDaysAgo: 65, resolvedHours: 24  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 72000, targetPrice: 81000, targetPrices: null, stopPrice: 67000, status: 'hit_target', outcomePrice: 81000, targetPricesHit: null, createdDaysAgo: 60, resolvedHours: 96  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'LONG',  entryPrice: 2600,  targetPrice: 3000,  targetPrices: null, stopPrice: 2400,  status: 'hit_target', outcomePrice: 3000,  targetPricesHit: null, createdDaysAgo: 54, resolvedHours: 60  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'LONG',  entryPrice: 130,   targetPrice: 160,   targetPrices: null, stopPrice: 118,   status: 'hit_stop',   outcomePrice: 118,   targetPricesHit: null, createdDaysAgo: 48, resolvedHours: 30  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'SHORT', entryPrice: 88000, targetPrice: 80000, targetPrices: null, stopPrice: 92000, status: 'hit_target', outcomePrice: 80000, targetPricesHit: null, createdDaysAgo: 43, resolvedHours: 84  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'SHORT', entryPrice: 3700,  targetPrice: 3100,  targetPrices: null, stopPrice: 3900,  status: 'hit_stop',   outcomePrice: 3900,  targetPricesHit: null, createdDaysAgo: 37, resolvedHours: 12  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'LONG',  entryPrice: 140,   targetPrice: 170,   targetPrices: null, stopPrice: 128,   status: 'hit_target', outcomePrice: 170,   targetPricesHit: null, createdDaysAgo: 31, resolvedHours: 48  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 83000, targetPrice: 92000, targetPrices: null, stopPrice: 78000, status: 'hit_stop',   outcomePrice: 78000, targetPricesHit: null, createdDaysAgo: 25, resolvedHours: 36  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'LONG',  entryPrice: 2950,  targetPrice: 3400,  targetPrices: null, stopPrice: 2750,  status: 'hit_target', outcomePrice: 3400,  targetPricesHit: null, createdDaysAgo: 19, resolvedHours: 72  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'SHORT', entryPrice: 155,   targetPrice: 130,   targetPrices: null, stopPrice: 168,   status: 'expired',    outcomePrice: 148,   targetPricesHit: null, createdDaysAgo: 14, resolvedHours: 168 },

  // ── SolanaWhale — 8 signals, ~38% hit rate, mostly SOL ──────────────────
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 160,   targetPrice: 220,   targetPrices: null, stopPrice: 140,   status: 'hit_stop',   outcomePrice: 140,   targetPricesHit: null, createdDaysAgo: 80, resolvedHours: 24  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 128,   targetPrice: 175,   targetPrices: null, stopPrice: 112,   status: 'hit_target', outcomePrice: 175,   targetPricesHit: null, createdDaysAgo: 72, resolvedHours: 120 },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'SHORT', entryPrice: 185,   targetPrice: 150,   targetPrices: null, stopPrice: 200,   status: 'hit_stop',   outcomePrice: 200,   targetPricesHit: null, createdDaysAgo: 63, resolvedHours: 18  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 115,   targetPrice: 150,   targetPrices: null, stopPrice: 100,   status: 'hit_stop',   outcomePrice: 100,   targetPricesHit: null, createdDaysAgo: 52, resolvedHours: 12  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'BTC', direction: 'LONG',  entryPrice: 70000, targetPrice: 78000, targetPrices: null, stopPrice: 65000, status: 'hit_target', outcomePrice: 78000, targetPricesHit: null, createdDaysAgo: 40, resolvedHours: 84  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 150,   targetPrice: 200,   targetPrices: null, stopPrice: 135,   status: 'hit_stop',   outcomePrice: 135,   targetPricesHit: null, createdDaysAgo: 28, resolvedHours: 36  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'SHORT', entryPrice: 140,   targetPrice: 110,   targetPrices: null, stopPrice: 152,   status: 'expired',    outcomePrice: 132,   targetPricesHit: null, createdDaysAgo: 15, resolvedHours: 168 },

  // ── ChartMaster — 12 signals, ~58% hit rate, conservative ───────────────
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 78500, targetPrice: 82000, targetPrices: null, stopPrice: 76500, status: 'hit_target', outcomePrice: 82000, targetPricesHit: null, createdDaysAgo: 83, resolvedHours: 36  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'SHORT', entryPrice: 3250,  targetPrice: 3000,  targetPrices: null, stopPrice: 3380,  status: 'hit_target', outcomePrice: 3000,  targetPricesHit: null, createdDaysAgo: 77, resolvedHours: 48  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'SHORT', entryPrice: 86000, targetPrice: 82000, targetPrices: null, stopPrice: 88000, status: 'hit_stop',   outcomePrice: 88000, targetPricesHit: null, createdDaysAgo: 70, resolvedHours: 24  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'SOL', direction: 'LONG',  entryPrice: 137,   targetPrice: 148,   targetPrices: null, stopPrice: 131,   status: 'hit_target', outcomePrice: 148,   targetPricesHit: null, createdDaysAgo: 64, resolvedHours: 60  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'LONG',  entryPrice: 2850,  targetPrice: 3050,  targetPrices: null, stopPrice: 2750,  status: 'hit_target', outcomePrice: 3050,  targetPricesHit: null, createdDaysAgo: 57, resolvedHours: 72  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 74000, targetPrice: 78000, targetPrices: null, stopPrice: 72000, status: 'hit_stop',   outcomePrice: 72000, targetPricesHit: null, createdDaysAgo: 50, resolvedHours: 18  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'SOL', direction: 'SHORT', entryPrice: 168,   targetPrice: 152,   targetPrices: null, stopPrice: 176,   status: 'hit_target', outcomePrice: 152,   targetPricesHit: null, createdDaysAgo: 44, resolvedHours: 48  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 80000, targetPrice: 84000, targetPrices: null, stopPrice: 78000, status: 'hit_target', outcomePrice: 84000, targetPricesHit: null, createdDaysAgo: 37, resolvedHours: 60  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'SHORT', entryPrice: 3600,  targetPrice: 3350,  targetPrices: null, stopPrice: 3720,  status: 'hit_stop',   outcomePrice: 3720,  targetPricesHit: null, createdDaysAgo: 30, resolvedHours: 12  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'SOL', direction: 'LONG',  entryPrice: 122,   targetPrice: 135,   targetPrices: null, stopPrice: 115,   status: 'hit_target', outcomePrice: 135,   targetPricesHit: null, createdDaysAgo: 22, resolvedHours: 84  },
];

// ── Open-signal templates (priced against real candles at seed time) ─────────
//
// These rows resolve to `status: 'open'` in the DB. Their entry/stop/target
// are built from the actual candle close at `createdDaysAgo` so clicking
// "Check Outcomes" walks genuine price action forward and plausibly
// resolves some during a demo. Percentages below mirror the ratios of the
// previously-hardcoded open rows so each caller's R:R profile stays intact.

interface OpenTemplate {
  callerName: string;
  source: string;
  channelName: string;
  asset: 'BTC' | 'ETH' | 'SOL';
  direction: 'LONG' | 'SHORT';
  stopPct: number;      // fraction of entry (e.g. 0.05 = 5%)
  tpPcts: number[];     // fractions from entry (single-element = single TP)
  createdDaysAgo: number;
}

const OPEN_TEMPLATES: OpenTemplate[] = [
  // AlphaTrader: two single-TP longs + one laddered long
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls',  asset: 'ETH', direction: 'LONG',  stopPct: 0.055, tpPcts: [0.109],                createdDaysAgo: 4 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls',  asset: 'BTC', direction: 'LONG',  stopPct: 0.052, tpPcts: [0.104],                createdDaysAgo: 1 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls',  asset: 'ETH', direction: 'LONG',  stopPct: 0.057, tpPcts: [0.057, 0.113, 0.170],  createdDaysAgo: 3 },
  // DegenKing: two aggressive longs
  { callerName: 'DegenKing',   source: 'twitter',  channelName: '@DegenKing',   asset: 'BTC', direction: 'LONG',  stopPct: 0.051, tpPcts: [0.101],                createdDaysAgo: 3 },
  { callerName: 'DegenKing',   source: 'twitter',  channelName: '@DegenKing',   asset: 'ETH', direction: 'LONG',  stopPct: 0.071, tpPcts: [0.143],                createdDaysAgo: 1 },
  // SolanaWhale: one big-R SOL long
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha',    asset: 'SOL', direction: 'LONG',  stopPct: 0.080, tpPcts: [0.240],                createdDaysAgo: 2 },
  // ChartMaster: two conservative longs
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  stopPct: 0.026, tpPcts: [0.066],                createdDaysAgo: 5 },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'LONG',  stopPct: 0.044, tpPcts: [0.093],                createdDaysAgo: 2 },
];

// Fallback prices if the candle cache returns nothing (offline / no network).
// Rounded to keep numbers readable in the UI.
const FALLBACK_PRICE: Record<OpenTemplate['asset'], number> = {
  BTC: 80000,
  ETH: 3000,
  SOL: 140,
};

function roundForAsset(asset: OpenTemplate['asset'], value: number): number {
  const decimals = asset === 'SOL' ? 2 : 0;
  const pow = 10 ** decimals;
  return Math.round(value * pow) / pow;
}

// ── Insert ───────────────────────────────────────────────────────────────────

/**
 * Fetch a recent candle window per asset and return a helper that picks the
 * close price nearest a given historical timestamp. One query per asset
 * covers every open-template lookup.
 */
async function buildPriceLookup(
  assets: OpenTemplate['asset'][],
  oldestDaysAgo: number,
): Promise<(asset: OpenTemplate['asset'], at: Date) => number | null> {
  const cache = getCandleCache();
  const end = new Date();
  const start = daysAgo(oldestDaysAgo + 1); // small buffer so the oldest signal has headroom

  const perAsset = new Map<OpenTemplate['asset'], { ts: number; close: number }[]>();
  for (const asset of assets) {
    try {
      const candles = await cache.getCandles(asset, '1h', start, end);
      if (candles.length > 0) {
        perAsset.set(asset, candles.map((c) => ({ ts: c.timestamp.getTime(), close: c.close })));
      }
    } catch (err) {
      console.warn(`  candle fetch for ${asset} failed: ${(err as Error).message}`);
    }
  }

  return (asset, at) => {
    const series = perAsset.get(asset);
    if (!series || series.length === 0) return null;
    // Binary-search-lite: series is chronological, so linear is fine for ≤200 rows.
    const target = at.getTime();
    let best = series[0];
    let bestGap = Math.abs(best.ts - target);
    for (const row of series) {
      const gap = Math.abs(row.ts - target);
      if (gap < bestGap) { best = row; bestGap = gap; }
    }
    return best.close;
  };
}

export async function seedSignals(walletAddress: string): Promise<{
  inserted: number;
  openInserted: number;
  skipped: boolean;
  message: string;
}> {
  // Check for existing seed to avoid duplicates
  const existing = await prisma.signal.count({ where: { walletAddress } });
  if (existing > 0) {
    return {
      inserted: 0,
      openInserted: 0,
      skipped: true,
      message: `Wallet already has ${existing} signals. Delete them first to re-seed.`,
    };
  }

  let inserted = 0;
  for (const s of SEEDS) {
    const createdAt = daysAgo(s.createdDaysAgo);
    const resolved = s.status !== 'open' && s.resolvedHours > 0
      ? resolvedAt(createdAt, s.resolvedHours)
      : null;

    const outcomePnlPct = s.outcomePrice != null
      ? pnlPct(s.entryPrice, s.outcomePrice, s.direction)
      : null;

    const outcomeRMultiple = s.outcomePrice != null
      ? rMultiple(s.entryPrice, s.outcomePrice, s.stopPrice, s.direction)
      : null;

    // Compute targetPrices — use provided array, or wrap single targetPrice
    const targetPricesArray = s.targetPrices ?? (s.targetPrice != null ? [s.targetPrice] : null);

    await prisma.signal.create({
      data: {
        walletAddress,
        callerName: s.callerName,
        source: s.source,
        channelName: s.channelName,
        asset: s.asset,
        direction: s.direction,
        entryPrice: s.entryPrice,
        targetPrice: s.targetPrice,
        targetPrices: targetPricesArray ? JSON.stringify(targetPricesArray) : null,
        stopPrice: s.stopPrice,
        status: s.status,
        outcomePrice: s.outcomePrice,
        outcomePnlPct,
        outcomeRMultiple,
        targetPricesHit: s.targetPricesHit ? JSON.stringify(s.targetPricesHit) : null,
        resolvedAt: resolved,
        createdAt,
        updatedAt: resolved ?? createdAt,
      },
    });
    inserted++;
  }

  // ── Open signals priced against live candles ─────────────────────────────
  const openAssets = [...new Set(OPEN_TEMPLATES.map((t) => t.asset))];
  const oldestDays = Math.max(...OPEN_TEMPLATES.map((t) => t.createdDaysAgo));
  const priceAt = await buildPriceLookup(openAssets, oldestDays);

  let openInserted = 0;
  for (const t of OPEN_TEMPLATES) {
    const createdAt = daysAgo(t.createdDaysAgo);
    const livePrice = priceAt(t.asset, createdAt);
    const rawEntry = livePrice ?? FALLBACK_PRICE[t.asset];

    // Small jitter (~±0.3%) so the entry doesn't land exactly on a candle close.
    const jitter = 1 + (Math.random() - 0.5) * 0.006;
    const entry = roundForAsset(t.asset, rawEntry * jitter);

    const sideSign = t.direction === 'LONG' ? 1 : -1;
    const stop = roundForAsset(t.asset, entry * (1 - sideSign * t.stopPct));
    const targets = t.tpPcts.map((p) =>
      roundForAsset(t.asset, entry * (1 + sideSign * p)),
    );

    await prisma.signal.create({
      data: {
        walletAddress,
        callerName: t.callerName,
        source: t.source,
        channelName: t.channelName,
        asset: t.asset,
        direction: t.direction,
        entryPrice: entry,
        targetPrice: targets[0],
        targetPrices: JSON.stringify(targets),
        stopPrice: stop,
        status: 'open',
        outcomePrice: null,
        outcomePnlPct: null,
        outcomeRMultiple: null,
        targetPricesHit: null,
        resolvedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
    openInserted++;
  }

  return {
    inserted,
    openInserted,
    skipped: false,
    message: `Seeded ${inserted + openInserted} signals for ${walletAddress}`,
  };
}

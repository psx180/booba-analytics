/**
 * seed-signals.ts — Seed demo caller/signal data.
 *
 * Creates 4 callers with distinct track records and ~55 signals spread over
 * the last 3 months, with realistic BTC/ETH/SOL prices and mixed outcomes.
 *
 * Usage:
 *   npx tsx src/scripts/seed-signals.ts <wallet_address>
 *   npx tsx src/scripts/seed-signals.ts   # uses DEV_WALLET env var
 */

import { prisma } from '../lib/prisma';

const walletAddress = process.argv[2] || process.env.DEV_WALLET;
if (!walletAddress) {
  console.error('Usage: tsx src/scripts/seed-signals.ts <wallet_address>');
  console.error('Or set DEV_WALLET in your environment.');
  process.exit(1);
}

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

type Status = 'open' | 'hit_target' | 'hit_stop' | 'expired' | 'closed_manual';

interface SignalSeed {
  callerName: string;
  source: string;
  channelName: string;
  asset: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  targetPrice: number | null;
  stopPrice: number | null;
  status: Status;
  outcomePrice: number | null;
  createdDaysAgo: number;  // days ago the signal was posted
  resolvedHours: number;   // hours after creation it resolved (0 if still open)
}

const SEEDS: SignalSeed[] = [
  // ── AlphaTrader — 20 signals, ~65% hit rate, reliable ───────────────────
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 79000, targetPrice: 84000, stopPrice: 76000, status: 'hit_target', outcomePrice: 84000, createdDaysAgo: 85, resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 2900,  targetPrice: 3200,  stopPrice: 2750,  status: 'hit_target', outcomePrice: 3200,  createdDaysAgo: 80, resolvedHours: 36 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 135,   targetPrice: 155,   stopPrice: 125,   status: 'hit_target', outcomePrice: 155,   createdDaysAgo: 75, resolvedHours: 24 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 87000, targetPrice: 81000, stopPrice: 90000, status: 'hit_target', outcomePrice: 81000, createdDaysAgo: 72, resolvedHours: 60 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'SHORT', entryPrice: 3500,  targetPrice: 3100,  stopPrice: 3650,  status: 'hit_target', outcomePrice: 3100,  createdDaysAgo: 68, resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 75000, targetPrice: 80000, stopPrice: 72000, status: 'hit_stop',   outcomePrice: 72000, createdDaysAgo: 64, resolvedHours: 18 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 142,   targetPrice: 165,   stopPrice: 132,   status: 'hit_target', outcomePrice: 165,   createdDaysAgo: 60, resolvedHours: 72 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 78000, targetPrice: 86000, stopPrice: 74000, status: 'hit_target', outcomePrice: 86000, createdDaysAgo: 55, resolvedHours: 96 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 3050,  targetPrice: 3400,  stopPrice: 2900,  status: 'hit_stop',   outcomePrice: 2900,  createdDaysAgo: 50, resolvedHours: 30 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 91000, targetPrice: 84000, stopPrice: 94000, status: 'hit_target', outcomePrice: 84000, createdDaysAgo: 46, resolvedHours: 84 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'SHORT', entryPrice: 175,   targetPrice: 155,   stopPrice: 183,   status: 'hit_target', outcomePrice: 155,   createdDaysAgo: 42, resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 2800,  targetPrice: 3100,  stopPrice: 2650,  status: 'hit_target', outcomePrice: 3100,  createdDaysAgo: 38, resolvedHours: 60 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 82000, targetPrice: 89000, stopPrice: 78000, status: 'hit_target', outcomePrice: 89000, createdDaysAgo: 33, resolvedHours: 120 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 120,   targetPrice: 145,   stopPrice: 110,   status: 'hit_stop',   outcomePrice: 110,   createdDaysAgo: 28, resolvedHours: 12 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'SHORT', entryPrice: 95000, targetPrice: 87000, stopPrice: 98000, status: 'hit_target', outcomePrice: 87000, createdDaysAgo: 23, resolvedHours: 72 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'SHORT', entryPrice: 3800,  targetPrice: 3300,  stopPrice: 4000,  status: 'hit_target', outcomePrice: 3300,  createdDaysAgo: 18, resolvedHours: 96 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 80000, targetPrice: 88000, stopPrice: 76000, status: 'hit_stop',   outcomePrice: 76000, createdDaysAgo: 14, resolvedHours: 24 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'SOL', direction: 'LONG',  entryPrice: 128,   targetPrice: 148,   stopPrice: 118,   status: 'hit_target', outcomePrice: 148,   createdDaysAgo: 9,  resolvedHours: 48 },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'ETH', direction: 'LONG',  entryPrice: 2750,  targetPrice: 3050,  stopPrice: 2600,  status: 'open',       outcomePrice: null,  createdDaysAgo: 4,  resolvedHours: 0  },
  { callerName: 'AlphaTrader', source: 'discord',  channelName: 'alpha-calls', asset: 'BTC', direction: 'LONG',  entryPrice: 77000, targetPrice: 85000, stopPrice: 73000, status: 'open',       outcomePrice: null,  createdDaysAgo: 1,  resolvedHours: 0  },

  // ── DegenKing — 15 signals, ~53% hit rate, volatile ─────────────────────
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'LONG',  entryPrice: 145,   targetPrice: 175,   stopPrice: 130,   status: 'hit_target', outcomePrice: 175,   createdDaysAgo: 82, resolvedHours: 36  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 76000, targetPrice: 84000, stopPrice: 70000, status: 'hit_stop',   outcomePrice: 70000, createdDaysAgo: 76, resolvedHours: 18  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'SHORT', entryPrice: 3400,  targetPrice: 2900,  stopPrice: 3600,  status: 'hit_target', outcomePrice: 2900,  createdDaysAgo: 70, resolvedHours: 72  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'SHORT', entryPrice: 170,   targetPrice: 140,   stopPrice: 185,   status: 'hit_stop',   outcomePrice: 185,   createdDaysAgo: 65, resolvedHours: 24  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 72000, targetPrice: 81000, stopPrice: 67000, status: 'hit_target', outcomePrice: 81000, createdDaysAgo: 60, resolvedHours: 96  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'LONG',  entryPrice: 2600,  targetPrice: 3000,  stopPrice: 2400,  status: 'hit_target', outcomePrice: 3000,  createdDaysAgo: 54, resolvedHours: 60  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'LONG',  entryPrice: 130,   targetPrice: 160,   stopPrice: 118,   status: 'hit_stop',   outcomePrice: 118,   createdDaysAgo: 48, resolvedHours: 30  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'SHORT', entryPrice: 88000, targetPrice: 80000, stopPrice: 92000, status: 'hit_target', outcomePrice: 80000, createdDaysAgo: 43, resolvedHours: 84  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'SHORT', entryPrice: 3700,  targetPrice: 3100,  stopPrice: 3900,  status: 'hit_stop',   outcomePrice: 3900,  createdDaysAgo: 37, resolvedHours: 12  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'LONG',  entryPrice: 140,   targetPrice: 170,   stopPrice: 128,   status: 'hit_target', outcomePrice: 170,   createdDaysAgo: 31, resolvedHours: 48  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 83000, targetPrice: 92000, stopPrice: 78000, status: 'hit_stop',   outcomePrice: 78000, createdDaysAgo: 25, resolvedHours: 36  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'LONG',  entryPrice: 2950,  targetPrice: 3400,  stopPrice: 2750,  status: 'hit_target', outcomePrice: 3400,  createdDaysAgo: 19, resolvedHours: 72  },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'SOL', direction: 'SHORT', entryPrice: 155,   targetPrice: 130,   stopPrice: 168,   status: 'expired',    outcomePrice: 148,   createdDaysAgo: 14, resolvedHours: 168 },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'BTC', direction: 'LONG',  entryPrice: 79000, targetPrice: 87000, stopPrice: 75000, status: 'open',       outcomePrice: null,  createdDaysAgo: 3,  resolvedHours: 0   },
  { callerName: 'DegenKing', source: 'twitter', channelName: '@DegenKing', asset: 'ETH', direction: 'LONG',  entryPrice: 2800,  targetPrice: 3200,  stopPrice: 2600,  status: 'open',       outcomePrice: null,  createdDaysAgo: 1,  resolvedHours: 0   },

  // ── SolanaWhale — 8 signals, ~38% hit rate, mostly SOL ──────────────────
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 160,   targetPrice: 220,   stopPrice: 140,   status: 'hit_stop',   outcomePrice: 140,   createdDaysAgo: 80, resolvedHours: 24  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 128,   targetPrice: 175,   stopPrice: 112,   status: 'hit_target', outcomePrice: 175,   createdDaysAgo: 72, resolvedHours: 120 },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'SHORT', entryPrice: 185,   targetPrice: 150,   stopPrice: 200,   status: 'hit_stop',   outcomePrice: 200,   createdDaysAgo: 63, resolvedHours: 18  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 115,   targetPrice: 150,   stopPrice: 100,   status: 'hit_stop',   outcomePrice: 100,   createdDaysAgo: 52, resolvedHours: 12  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'BTC', direction: 'LONG',  entryPrice: 70000, targetPrice: 78000, stopPrice: 65000, status: 'hit_target', outcomePrice: 78000, createdDaysAgo: 40, resolvedHours: 84  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 150,   targetPrice: 200,   stopPrice: 135,   status: 'hit_stop',   outcomePrice: 135,   createdDaysAgo: 28, resolvedHours: 36  },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'SHORT', entryPrice: 140,   targetPrice: 110,   stopPrice: 152,   status: 'expired',    outcomePrice: 132,   createdDaysAgo: 15, resolvedHours: 168 },
  { callerName: 'SolanaWhale', source: 'telegram', channelName: 'sol-alpha', asset: 'SOL', direction: 'LONG',  entryPrice: 125,   targetPrice: 155,   stopPrice: 115,   status: 'open',       outcomePrice: null,  createdDaysAgo: 2,  resolvedHours: 0   },

  // ── ChartMaster — 12 signals, ~58% hit rate, conservative ───────────────
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 78500, targetPrice: 82000, stopPrice: 76500, status: 'hit_target', outcomePrice: 82000, createdDaysAgo: 83, resolvedHours: 36  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'SHORT', entryPrice: 3250,  targetPrice: 3000,  stopPrice: 3380,  status: 'hit_target', outcomePrice: 3000,  createdDaysAgo: 77, resolvedHours: 48  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'SHORT', entryPrice: 86000, targetPrice: 82000, stopPrice: 88000, status: 'hit_stop',   outcomePrice: 88000, createdDaysAgo: 70, resolvedHours: 24  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'SOL', direction: 'LONG',  entryPrice: 137,   targetPrice: 148,   stopPrice: 131,   status: 'hit_target', outcomePrice: 148,   createdDaysAgo: 64, resolvedHours: 60  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'LONG',  entryPrice: 2850,  targetPrice: 3050,  stopPrice: 2750,  status: 'hit_target', outcomePrice: 3050,  createdDaysAgo: 57, resolvedHours: 72  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 74000, targetPrice: 78000, stopPrice: 72000, status: 'hit_stop',   outcomePrice: 72000, createdDaysAgo: 50, resolvedHours: 18  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'SOL', direction: 'SHORT', entryPrice: 168,   targetPrice: 152,   stopPrice: 176,   status: 'hit_target', outcomePrice: 152,   createdDaysAgo: 44, resolvedHours: 48  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 80000, targetPrice: 84000, stopPrice: 78000, status: 'hit_target', outcomePrice: 84000, createdDaysAgo: 37, resolvedHours: 60  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'SHORT', entryPrice: 3600,  targetPrice: 3350,  stopPrice: 3720,  status: 'hit_stop',   outcomePrice: 3720,  createdDaysAgo: 30, resolvedHours: 12  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'SOL', direction: 'LONG',  entryPrice: 122,   targetPrice: 135,   stopPrice: 115,   status: 'hit_target', outcomePrice: 135,   createdDaysAgo: 22, resolvedHours: 84  },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'BTC', direction: 'LONG',  entryPrice: 76000, targetPrice: 81000, stopPrice: 74000, status: 'open',       outcomePrice: null,  createdDaysAgo: 5,  resolvedHours: 0   },
  { callerName: 'ChartMaster', source: 'discord',  channelName: 'chart-setups', asset: 'ETH', direction: 'LONG',  entryPrice: 2700,  targetPrice: 2950,  stopPrice: 2580,  status: 'open',       outcomePrice: null,  createdDaysAgo: 2,  resolvedHours: 0   },
];

// ── Insert ───────────────────────────────────────────────────────────────────

async function run() {
  // Check for existing seed to avoid duplicates
  const existing = await prisma.signal.count({ where: { walletAddress: walletAddress! } });
  if (existing > 0) {
    console.log(`Wallet already has ${existing} signals. Delete them first if you want to re-seed.`);
    console.log('To clear: npx tsx -e "const {prisma} = require(\'./src/lib/prisma\'); prisma.signal.deleteMany({where:{walletAddress:process.argv[1]}}).then(r=>console.log(r))" -- <wallet>');
    process.exit(0);
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

    await prisma.signal.create({
      data: {
        walletAddress: walletAddress!,
        callerName: s.callerName,
        source: s.source,
        channelName: s.channelName,
        asset: s.asset,
        direction: s.direction,
        entryPrice: s.entryPrice,
        targetPrice: s.targetPrice,
        stopPrice: s.stopPrice,
        status: s.status,
        outcomePrice: s.outcomePrice,
        outcomePnlPct,
        outcomeRMultiple,
        resolvedAt: resolved,
        createdAt,
        updatedAt: resolved ?? createdAt,
      },
    });
    inserted++;
  }

  console.log(`Seeded ${inserted} signals for wallet ${walletAddress}`);

  // Print summary per caller
  const callers = [...new Set(SEEDS.map((s) => s.callerName))];
  for (const caller of callers) {
    const callerSeeds = SEEDS.filter((s) => s.callerName === caller);
    const hits = callerSeeds.filter((s) => s.status === 'hit_target').length;
    const stops = callerSeeds.filter((s) => s.status === 'hit_stop').length;
    const expired = callerSeeds.filter((s) => s.status === 'expired').length;
    const open = callerSeeds.filter((s) => s.status === 'open').length;
    const resolved = hits + stops + expired;
    const hitRate = resolved > 0 ? ((hits / resolved) * 100).toFixed(0) : '—';
    console.log(`  ${caller}: ${callerSeeds.length} signals, ${hitRate}% hit rate (${hits} target / ${stops} stop / ${expired} expired / ${open} open)`);
  }
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());

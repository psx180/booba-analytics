/**
 * seed-strategies.ts — Seed four demo strategies and tag a slice of
 * closed positions with each.
 *
 * Strategies are "lightweight" in this codebase — the /api/strategies
 * POST only stores a name. The schema itself has richer fields
 * (directionBias, preferredRegime, typicalTimeframe, description,
 * typicalRrTarget) so this seed populates them directly for demo depth.
 *
 * Each strategy is tagged on ~12 closed positions that match its bias
 * (direction and regime where available), falling back to the most
 * recent untagged closes otherwise. No adherence scoring — strategies
 * don't carry rules (playbooks do).
 *
 * Usage:
 *   npx tsx src/scripts/seed-strategies.ts <wallet_address>
 *   npx tsx src/scripts/seed-strategies.ts   # uses DEV_WALLET env var
 */

import { prisma } from '../lib/prisma';

const walletAddress = process.argv[2] || process.env.DEV_WALLET;
if (!walletAddress) {
  console.error('Usage: tsx src/scripts/seed-strategies.ts <wallet_address>');
  console.error('Or set DEV_WALLET in your environment.');
  process.exit(1);
}

const TAG_COUNT_PER_STRATEGY = 12;

// ── Strategy definitions ───────────────────────────────────────────────────

interface StrategySeed {
  name: string;
  directionBias: 'long_only' | 'short_only' | 'both';
  preferredRegime: string | null;
  typicalTimeframe: 'scalp' | 'intraday' | 'swing' | 'carry';
  description: string;
  entrySignalTags: string[];
  typicalRrTarget: number;
  checklist: { name: string; category: string }[];
  // Filters used to pick "naturally matching" positions to tag.
  preferredDirection?: 'long' | 'short';
  preferredRegimes?: string[];
}

const STRATEGIES: StrategySeed[] = [
  {
    name: 'Breakout Continuation',
    directionBias: 'long_only',
    preferredRegime: 'trending_high_vol',
    typicalTimeframe: 'intraday',
    description:
      'Enter on confirmed range-break with volume expansion. Hold through pullbacks while higher-low structure remains intact.',
    entrySignalTags: ['range_break', 'volume_expansion', 'higher_low'],
    typicalRrTarget: 2.5,
    checklist: [
      { name: 'Prior range defined (>= 4h)', category: 'setup' },
      { name: 'Break candle closes above range high', category: 'entry' },
      { name: 'Volume >= 1.5x 20-bar average', category: 'entry' },
      { name: 'Stop below last pullback low', category: 'risk' },
    ],
    preferredDirection: 'long',
    preferredRegimes: ['trending_high_vol', 'trending_low_vol'],
  },
  {
    name: 'Mean Reversion Scalp',
    directionBias: 'both',
    preferredRegime: 'ranging_low_vol',
    typicalTimeframe: 'scalp',
    description:
      'Fade extremes inside a defined range. Size smaller; exit at midline or opposite edge. Do not hold through a range-break.',
    entrySignalTags: ['range_edge', 'rsi_extreme', 'bollinger_tag'],
    typicalRrTarget: 1.5,
    checklist: [
      { name: 'Range confirmed on HTF', category: 'setup' },
      { name: 'Price at or through range edge', category: 'entry' },
      { name: 'RSI > 70 (short) or < 30 (long)', category: 'entry' },
      { name: 'Stop just beyond range edge', category: 'risk' },
      { name: 'Target mid-range or opposite edge', category: 'exit' },
    ],
    preferredRegimes: ['ranging_low_vol', 'ranging_high_vol'],
  },
  {
    name: 'Momentum Reversal',
    directionBias: 'both',
    preferredRegime: 'trending_high_vol',
    typicalTimeframe: 'swing',
    description:
      'Counter-trend entry at climax exhaustion. Requires divergence + rejection. Swing hold only with strong invalidation.',
    entrySignalTags: ['rsi_divergence', 'climax_candle', 'rejection_wick'],
    typicalRrTarget: 3.0,
    checklist: [
      { name: 'Three+ impulse legs in trend', category: 'setup' },
      { name: 'Bearish/bullish divergence on RSI', category: 'entry' },
      { name: 'Rejection wick on HTF close', category: 'entry' },
      { name: 'Stop beyond climax extreme', category: 'risk' },
      { name: 'Partial at first swing pivot', category: 'exit' },
    ],
    preferredRegimes: ['trending_high_vol'],
  },
  {
    name: 'News Pump Fade',
    directionBias: 'short_only',
    preferredRegime: 'trending_high_vol',
    typicalTimeframe: 'intraday',
    description:
      'Fade the second leg of a news-driven pump after the initial move exhausts. Tight stop above local high.',
    entrySignalTags: ['news_catalyst', 'vertical_candle', 'funding_extreme'],
    typicalRrTarget: 2.0,
    checklist: [
      { name: 'Catalyst verified and priced in', category: 'setup' },
      { name: 'Funding rate > 0.05% (hourly)', category: 'setup' },
      { name: 'Lower high after initial peak', category: 'entry' },
      { name: 'Stop above session high', category: 'risk' },
    ],
    preferredDirection: 'short',
    preferredRegimes: ['trending_high_vol'],
  },
];

// ── Position picking ────────────────────────────────────────────────────────

async function pickPositions(seed: StrategySeed): Promise<{ id: string }[]> {
  const base = {
    walletAddress,
    status: 'closed',
    averageEntryPrice: { not: null },
    firstEntryTime: { not: null },
    strategyId: null,
  } as const;

  const preferredWhere: Record<string, unknown> = { ...base };
  if (seed.preferredDirection) preferredWhere.direction = seed.preferredDirection;
  if (seed.preferredRegimes && seed.preferredRegimes.length > 0) {
    preferredWhere.regimeAtEntry = { in: seed.preferredRegimes };
  }

  const preferred = await prisma.position.findMany({
    where: preferredWhere,
    select: { id: true },
    take: TAG_COUNT_PER_STRATEGY,
    orderBy: { firstEntryTime: 'desc' },
  });
  if (preferred.length >= TAG_COUNT_PER_STRATEGY) return preferred;

  const existingIds = new Set(preferred.map((p) => p.id));
  const fallback = await prisma.position.findMany({
    where: { ...base, id: { notIn: Array.from(existingIds) } },
    select: { id: true },
    take: TAG_COUNT_PER_STRATEGY - preferred.length,
    orderBy: { firstEntryTime: 'desc' },
  });
  return [...preferred, ...fallback];
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function run() {
  const existing = await prisma.strategy.count({ where: { walletAddress } });
  if (existing > 0) {
    console.log(`Wallet already has ${existing} strategies. Skipping to avoid duplicates.`);
    console.log('Delete them first if you want to re-seed:');
    console.log(`  tsx -e "import('./src/lib/prisma').then(({prisma})=>prisma.strategy.deleteMany({where:{walletAddress:'${walletAddress}'}}).then(r=>console.log(r)))"`);
    return;
  }

  // The Strategy.name column is globally unique, not per-wallet. If another
  // wallet already seeded these names, fail loudly so the user can pick a
  // different wallet or clean up rather than silently skipping.
  const conflict = await prisma.strategy.findFirst({
    where: { name: { in: STRATEGIES.map((s) => s.name) } },
    select: { name: true, walletAddress: true },
  });
  if (conflict) {
    console.error(
      `Strategy name "${conflict.name}" already exists on wallet ${conflict.walletAddress ?? '<null>'}.`
      + ' Strategy.name is globally unique — delete the conflicting row first.',
    );
    process.exit(1);
  }

  for (const seed of STRATEGIES) {
    const strategy = await prisma.strategy.create({
      data: {
        walletAddress: walletAddress!,
        name: seed.name,
        directionBias: seed.directionBias,
        preferredRegime: seed.preferredRegime,
        typicalTimeframe: seed.typicalTimeframe,
        description: seed.description,
        entrySignalTags: JSON.stringify(seed.entrySignalTags),
        typicalRrTarget: seed.typicalRrTarget,
        checklist: JSON.stringify(seed.checklist),
      },
    });
    console.log(`Created strategy "${strategy.name}" (${strategy.id})`);

    const picks = await pickPositions(seed);
    if (picks.length === 0) {
      console.log(`  No closed positions available to tag.`);
      continue;
    }

    const { count } = await prisma.position.updateMany({
      where: { id: { in: picks.map((p) => p.id) } },
      data: { strategyId: strategy.id },
    });
    console.log(`  Tagged ${count} closed position(s)`);
  }

  console.log('\nDone. Visit the dashboard to see strategy filters and per-strategy stats.');
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());

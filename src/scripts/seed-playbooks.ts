/**
 * seed-playbooks.ts — Seed two demo playbooks and score adherence on a
 * slice of existing closed positions.
 *
 * Creates:
 *   • "Trending Momentum" — longs in trending regimes during US hours,
 *     with a moderate stop and a conservative size cap.
 *   • "Range Scalp"       — ranging-regime trades during overlap hours,
 *     tight stops and a minimum R:R floor.
 *
 * Then picks ~20 closed positions per playbook (preferring rows that
 * naturally match a few of the rules so the adherence breakdown looks
 * realistic), tags them, and runs the adherence service — so the
 * Playbooks page has populated analytics out of the box.
 *
 * Usage:
 *   npx tsx src/scripts/seed-playbooks.ts <wallet_address>
 *   npx tsx src/scripts/seed-playbooks.ts   # uses DEV_WALLET env var
 */

import { prisma } from '../lib/prisma';
import { runAndStoreAdherence } from '../services/playbooks/adherence-service';
import type { PlaybookRule } from '../services/playbooks/types';

const walletAddress = process.argv[2] || process.env.DEV_WALLET;
if (!walletAddress) {
  console.error('Usage: tsx src/scripts/seed-playbooks.ts <wallet_address>');
  console.error('Or set DEV_WALLET in your environment.');
  process.exit(1);
}

// ── Playbook definitions ───────────────────────────────────────────────────

interface PlaybookSeed {
  name: string;
  description: string;
  rules: PlaybookRule[];
  // Hinted filter used to pick "naturally matching" positions to tag.
  preferredDirection?: 'long' | 'short';
  preferredRegimes?: string[];
}

const PLAYBOOKS: PlaybookSeed[] = [
  {
    name: 'Trending Momentum',
    description: 'Ride trends on longs during US hours. Moderate stop, conservative size.',
    preferredDirection: 'long',
    preferredRegimes: ['trending_low_vol', 'trending_high_vol'],
    rules: [
      {
        type: 'regime',
        params: { regimes: ['trending_low_vol', 'trending_high_vol'] },
        enabled: true,
        label: 'Regime must be Trending',
      },
      {
        type: 'direction',
        params: { direction: 'LONG' },
        enabled: true,
        label: 'Longs only',
      },
      {
        type: 'time_of_day',
        params: { startHour: 9, endHour: 20 },
        enabled: true,
        label: 'Entry during US hours',
      },
      {
        type: 'max_daily_trades',
        params: { maxTrades: 8 },
        enabled: true,
        label: 'Max 8 trades per day',
      },
      {
        type: 'stop_distance',
        params: { maxPercent: 5 },
        enabled: true,
        label: 'Stop within 5% of entry',
      },
      {
        type: 'position_size',
        params: { maxPercentOfEquity: 3 },
        enabled: true,
        label: 'Size ≤ 3% of equity',
      },
    ],
  },
  {
    name: 'Range Scalp',
    description: 'Fade extremes in ranging regimes during session overlap. Tight stop, min R:R.',
    preferredRegimes: ['ranging_low_vol', 'ranging_high_vol'],
    rules: [
      {
        type: 'regime',
        params: { regimes: ['ranging_low_vol', 'ranging_high_vol'] },
        enabled: true,
        label: 'Regime must be Ranging',
      },
      {
        type: 'time_of_day',
        params: { startHour: 12, endHour: 18 },
        enabled: true,
        label: 'Entry during session overlap',
      },
      {
        type: 'max_daily_trades',
        params: { maxTrades: 15 },
        enabled: true,
        label: 'Max 15 trades per day',
      },
      {
        type: 'stop_distance',
        params: { maxPercent: 2 },
        enabled: true,
        label: 'Stop within 2% of entry',
      },
      {
        type: 'min_risk_reward',
        params: { minRR: 1.5 },
        enabled: true,
        label: 'Minimum 1.5:1 R:R',
      },
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

const TARGET_TAG_COUNT = 20;

/**
 * Pick ~N positions to tag with this playbook. Tries to match the seed's
 * preferred direction + regimes first so the breakdown has some passes
 * mixed in with the fails; falls back to any closed position with an
 * entry price if we don't have enough matches.
 */
async function pickPositions(seed: PlaybookSeed): Promise<{ id: string }[]> {
  const base = {
    walletAddress,
    status: 'closed',
    averageEntryPrice: { not: null },
    firstEntryTime: { not: null },
    // Don't steal positions already tagged with a different playbook.
    playbookId: null,
  } as const;

  const preferredWhere: Record<string, unknown> = { ...base };
  if (seed.preferredDirection) preferredWhere.direction = seed.preferredDirection;
  if (seed.preferredRegimes && seed.preferredRegimes.length > 0) {
    preferredWhere.regimeAtEntry = { in: seed.preferredRegimes };
  }

  const preferred = await prisma.position.findMany({
    where: preferredWhere,
    select: { id: true },
    take: TARGET_TAG_COUNT,
    orderBy: { firstEntryTime: 'desc' },
  });
  if (preferred.length >= TARGET_TAG_COUNT) return preferred;

  const existingIds = new Set(preferred.map((p) => p.id));
  const fallback = await prisma.position.findMany({
    where: { ...base, id: { notIn: Array.from(existingIds) } },
    select: { id: true },
    take: TARGET_TAG_COUNT - preferred.length,
    orderBy: { firstEntryTime: 'desc' },
  });
  return [...preferred, ...fallback];
}

async function run() {
  const existing = await prisma.playbook.count({ where: { walletAddress } });
  if (existing > 0) {
    console.log(`Wallet already has ${existing} playbooks. Skipping to avoid duplicates.`);
    console.log('Delete them first if you want to re-seed:');
    console.log(`  tsx -e "import('./src/lib/prisma').then(({prisma})=>prisma.playbook.deleteMany({where:{walletAddress:'${walletAddress}'}}).then(r=>console.log(r)))"`);
    return;
  }

  for (const seed of PLAYBOOKS) {
    const playbook = await prisma.playbook.create({
      data: {
        walletAddress: walletAddress!,
        name: seed.name,
        description: seed.description,
        rules: JSON.stringify(seed.rules),
      },
    });
    console.log(`Created playbook "${playbook.name}" (${playbook.id})`);

    const picks = await pickPositions(seed);
    if (picks.length === 0) {
      console.log(`  No closed positions available to tag — playbook will have empty analytics.`);
      continue;
    }

    await prisma.position.updateMany({
      where: { id: { in: picks.map((p) => p.id) } },
      data: { playbookId: playbook.id },
    });

    let scored = 0;
    for (const pick of picks) {
      try {
        // Historic positions don't have account equity on hand — the size
        // rule will fall to inconclusive, which is the accurate outcome for
        // imported trades without a running equity series.
        const result = await runAndStoreAdherence(pick.id);
        if (result) scored++;
      } catch (err) {
        console.warn(`  adherence failed on ${pick.id}:`, (err as Error).message);
      }
    }
    console.log(`  Tagged and scored ${scored}/${picks.length} positions`);

    const refreshed = await prisma.playbook.findUnique({ where: { id: playbook.id } });
    if (refreshed?.avgAdherence != null) {
      console.log(`  Average adherence: ${refreshed.avgAdherence.toFixed(1)}%`);
    }
  }
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());

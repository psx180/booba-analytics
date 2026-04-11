/**
 * Smoke test for the MFE/MAE pipeline rewrite.
 *
 * Wipes the existing mfePrice/mfePnl/maePrice/maePnl/exitEfficiency/
 * moneyLeftOnTable/maeRatio fields on a wallet's closed positions, then runs
 * computeMetrics() and reports coverage before and after. Also logs a sample
 * of computed positions so the operator can sanity-check the values.
 *
 * Usage: npx tsx src/scripts/smoke-mfe-mae.ts [walletAddress]
 */

import { prisma } from '../lib/prisma';
import { createAnalyticsService } from '../services/analytics';

async function main() {
  const wallet = process.argv[2] ?? '32K2iNzqyFTfahrascrWni9tnp7kkmHcUSVkTzKpAGZk';
  console.log(`\n=== MFE/MAE smoke test for ${wallet} ===\n`);

  const before = await coverage(wallet);
  console.log('BEFORE:', before);

  console.log('\nWiping MFE/MAE columns to force recomputation...');
  await prisma.position.updateMany({
    where: { walletAddress: wallet, status: 'closed' },
    data: {
      mfePrice: null,
      mfePnl: null,
      maePrice: null,
      maePnl: null,
      exitEfficiency: null,
      moneyLeftOnTable: null,
      maeRatio: null,
    },
  });

  console.log('\nRunning computeMetrics()...\n');
  const t0 = Date.now();
  const service = createAnalyticsService();
  const summary = await service.computeMetrics(wallet);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\ncomputeMetrics done in ${elapsed}s:`, summary);

  const after = await coverage(wallet);
  console.log('\nAFTER:', after);

  // Sample 5 closed positions with computed MFE/MAE for a sanity check.
  const sample = await prisma.position.findMany({
    where: {
      walletAddress: wallet,
      status: 'closed',
      mfePnl: { not: null },
    },
    orderBy: { lastExitTime: 'desc' },
    take: 5,
    select: {
      asset: true,
      direction: true,
      averageEntryPrice: true,
      averageExitPrice: true,
      totalSize: true,
      aggregatePnl: true,
      mfePrice: true,
      mfePnl: true,
      maePrice: true,
      maePnl: true,
      exitEfficiency: true,
      moneyLeftOnTable: true,
      maeRatio: true,
      holdTimeSeconds: true,
    },
  });

  console.log('\nSample of computed positions:');
  for (const p of sample) {
    const eff = p.exitEfficiency != null ? `${(p.exitEfficiency * 100).toFixed(1)}%` : '—';
    const ratio = p.maeRatio != null ? p.maeRatio.toFixed(2) : '—';
    console.log(
      `  ${p.asset.padEnd(8)} ${p.direction.padEnd(5)} ` +
      `entry=${p.averageEntryPrice} exit=${p.averageExitPrice} size=${p.totalSize} ` +
      `pnl=${p.aggregatePnl?.toFixed(2)} ` +
      `MFE=$${p.mfePnl?.toFixed(2)} MAE=$${p.maePnl?.toFixed(2)} ` +
      `eff=${eff} maeRatio=${ratio} hold=${p.holdTimeSeconds}s`,
    );
  }

  // Per-asset coverage breakdown so we can see which natives still get skipped.
  const byAsset = await prisma.position.groupBy({
    by: ['asset'],
    where: { walletAddress: wallet, status: 'closed' },
    _count: { _all: true },
  });
  const withMfe = await prisma.position.groupBy({
    by: ['asset'],
    where: { walletAddress: wallet, status: 'closed', mfePnl: { not: null } },
    _count: { _all: true },
  });
  const withMfeMap = new Map(withMfe.map((r) => [r.asset, r._count._all]));

  console.log('\nPer-asset coverage:');
  const rows = byAsset
    .map((r) => ({ asset: r.asset, total: r._count._all, computed: withMfeMap.get(r.asset) ?? 0 }))
    .sort((a, b) => b.total - a.total);
  for (const r of rows) {
    const pct = ((r.computed / r.total) * 100).toFixed(0);
    console.log(`  ${r.asset.padEnd(10)} ${r.computed}/${r.total} (${pct}%)`);
  }

  await prisma.$disconnect();
}

async function coverage(wallet: string) {
  const total = await prisma.position.count({
    where: { walletAddress: wallet, status: 'closed' },
  });
  const withMfe = await prisma.position.count({
    where: { walletAddress: wallet, status: 'closed', mfePnl: { not: null } },
  });
  const withEff = await prisma.position.count({
    where: { walletAddress: wallet, status: 'closed', exitEfficiency: { not: null } },
  });
  return {
    closedTotal: total,
    withMfePnl: withMfe,
    withExitEfficiency: withEff,
    coveragePct: total > 0 ? `${((withMfe / total) * 100).toFixed(1)}%` : 'n/a',
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

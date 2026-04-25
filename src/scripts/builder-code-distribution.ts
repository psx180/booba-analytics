/**
 * Print the builder-code distribution across all positions.
 *
 * Usage:
 *   npx tsx src/scripts/builder-code-distribution.ts [walletAddress]
 *
 * Without an argument, aggregates over every wallet. Use the output to
 * decide which codes belong in DEFAULT_NOISE_BUILDER_CODES (the default
 * "Hide market-making activity" exclusion list in
 * src/app/analytics/types.ts).
 *
 * Heuristics for spotting noise codes from the table:
 *   - very high tradeCount per code
 *   - avgPnl tightly clustered around zero
 *   - very short avgHoldSec (often < 60s for market makers)
 */

import { prisma } from '../lib/prisma';

interface Row {
  builderCode: string;
  trades: number;
  totalPnl: number;
  avgPnl: number;
  winRate: number;
  avgHoldSec: number | null;
  medianHoldSec: number | null;
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const wallet = process.argv[2];
  const where = wallet ? { walletAddress: wallet } : {};

  const positions = await prisma.position.findMany({
    where,
    select: {
      builderCode: true,
      aggregatePnl: true,
      holdTimeSeconds: true,
    },
  });

  if (positions.length === 0) {
    console.log(`No positions found${wallet ? ` for wallet ${wallet}` : ''}.`);
    return;
  }

  const buckets = new Map<string, { pnls: number[]; holds: number[] }>();
  for (const p of positions) {
    const key = p.builderCode ?? 'manual';
    if (!buckets.has(key)) buckets.set(key, { pnls: [], holds: [] });
    const b = buckets.get(key)!;
    b.pnls.push(p.aggregatePnl ?? 0);
    if (p.holdTimeSeconds != null) b.holds.push(p.holdTimeSeconds);
  }

  const rows: Row[] = [];
  for (const [code, { pnls, holds }] of buckets) {
    const total = pnls.reduce((s, x) => s + x, 0);
    const wins = pnls.filter((x) => x > 0).length;
    const avgHold = holds.length > 0 ? holds.reduce((s, x) => s + x, 0) / holds.length : null;
    rows.push({
      builderCode: code,
      trades: pnls.length,
      totalPnl: total,
      avgPnl: total / pnls.length,
      winRate: wins / pnls.length,
      avgHoldSec: avgHold,
      medianHoldSec: median(holds),
    });
  }

  rows.sort((a, b) => b.trades - a.trades);

  console.log(`\nBuilder code distribution${wallet ? ` (wallet=${wallet})` : ' (all wallets)'} — ${positions.length} positions\n`);
  const header = ['code', 'trades', 'totalPnl', 'avgPnl', 'winRate', 'avgHoldSec', 'medianHoldSec'];
  const widths = [22, 8, 12, 10, 9, 12, 14];
  const pad = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);

  console.log(header.map((h, i) => pad(h, widths[i], i > 0)).join('  '));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));

  for (const r of rows) {
    const cells = [
      pad(r.builderCode, widths[0]),
      pad(String(r.trades), widths[1], true),
      pad(fmt(r.totalPnl), widths[2], true),
      pad(fmt(r.avgPnl), widths[3], true),
      pad(`${(r.winRate * 100).toFixed(1)}%`, widths[4], true),
      pad(r.avgHoldSec == null ? '—' : fmt(r.avgHoldSec, 0), widths[5], true),
      pad(r.medianHoldSec == null ? '—' : fmt(r.medianHoldSec, 0), widths[6], true),
    ];
    console.log(cells.join('  '));
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

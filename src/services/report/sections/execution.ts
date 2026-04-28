import type { ReportData } from '../data';
import type { ExecutionSection } from '../types';

export function generateExecution(data: ReportData): ExecutionSection | null {
  if (data.closedPositions.length === 0) return null;

  const efficiencies = data.closedPositions
    .map((p) => p.exitEfficiency)
    .filter((v): v is number => typeof v === 'number' && v >= 0);
  const maes = data.closedPositions
    .map((p) => p.maePnl)
    .filter((v): v is number => typeof v === 'number');
  const mfes = data.closedPositions
    .map((p) => p.mfePnl)
    .filter((v): v is number => typeof v === 'number');

  const avgExitEfficiency = avg(efficiencies);
  const avgMae = avg(maes);
  const avgMfe = avg(mfes);

  // Per-regime exit efficiency (only buckets with ≥3 trades). Efficiency
  // makes sense only on closed wins; the metric computer already gates that.
  const byRegime = new Map<string, { sum: number; n: number }>();
  for (const p of data.closedPositions) {
    if (typeof p.exitEfficiency !== 'number' || p.exitEfficiency < 0) continue;
    const r = p.regimeAtEntry ?? 'unknown';
    const cur = byRegime.get(r) ?? { sum: 0, n: 0 };
    cur.sum += p.exitEfficiency;
    cur.n += 1;
    byRegime.set(r, cur);
  }
  const exitEfficiencyByRegime = byRegime.size > 0
    ? Array.from(byRegime.entries())
        .filter(([, v]) => v.n >= 3)
        .map(([regime, v]) => ({
          regime,
          efficiency: round(v.sum / v.n, 4),
          tradeCount: v.n,
        }))
        .sort((a, b) => b.efficiency - a.efficiency)
    : null;

  const entryTimingScore =
    avgMae != null && avgMfe != null && avgMfe > 0
      ? round(Math.abs(avgMae) / avgMfe, 4)
      : null;

  return {
    summary: buildSummary({ avgExitEfficiency, entryTimingScore }),
    avgExitEfficiency: avgExitEfficiency != null ? round(avgExitEfficiency, 4) : null,
    exitEfficiencyByRegime,
    avgMae: avgMae != null ? round(avgMae, 2) : null,
    avgMfe: avgMfe != null ? round(avgMfe, 2) : null,
    entryTimingScore,
  };
}

function buildSummary(args: {
  avgExitEfficiency: number | null;
  entryTimingScore: number | null;
}): string {
  const eff = args.avgExitEfficiency;
  if (eff == null) {
    return 'Exit efficiency is unavailable — too few winning trades have MFE-tagged candle data.';
  }
  const pct = Math.round(eff * 100);
  let entryClause = '';
  if (args.entryTimingScore != null) {
    if (args.entryTimingScore < 0.5) entryClause = ' Entries print favourably relative to adverse excursion.';
    else if (args.entryTimingScore > 1.5) entryClause = ' Entries see substantial adverse excursion before working.';
  }
  // Descriptive — judgmental "you exit too early/late" framing replaced with
  // a neutral capture statistic plus the no-universal-benchmark caveat.
  return `You captured ${pct}% of average maximum favourable excursion across winning trades.${entryClause} ` +
    `Exit efficiency varies by strategy — there is no universal benchmark. ` +
    `Comparison against specific exit rules (trailing stops, fixed targets) would provide more actionable context.`;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function round(v: number, digits: number): number {
  if (!isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

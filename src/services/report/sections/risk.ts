import type { ReportData } from '../data';
import type { RiskSection } from '../types';

export function generateRisk(data: ReportData): RiskSection | null {
  if (data.closedPositions.length === 0) return null;
  const r = data.riskMetrics;
  const dd = data.drawdownSummary;

  const monteCarlo = data.monteCarlo
    ? {
        probDrawdown25: round(data.monteCarlo.probDrawdown25, 4),
        probDrawdown50: round(data.monteCarlo.probDrawdown50, 4),
        probRuin: round(data.monteCarlo.probRuin, 4),
        medianFinalBalance: round(data.monteCarlo.medianFinalBalance, 2),
        p10FinalBalance: round(data.monteCarlo.p10FinalBalance, 2),
        p90FinalBalance: round(data.monteCarlo.p90FinalBalance, 2),
      }
    : null;

  return {
    summary: buildSummary({
      sharpe: r.sharpeRatio,
      sortino: r.sortinoRatio,
      calmar: r.calmarRatio,
      monteCarlo,
    }),
    sharpeRatio: r.sharpeRatio,
    sortinoRatio: r.sortinoRatio,
    calmarRatio: r.calmarRatio,
    maxDrawdownDollars: round(Math.abs(dd.maxDrawdownDollars), 2),
    maxDrawdownPct: round(Math.abs(dd.maxDrawdownPct), 2),
    currentDrawdownPct: round(Math.abs(dd.currentDrawdownPct), 2),
    monteCarlo,
    recoveryFactor: r.recoveryFactor,
  };
}

function buildSummary(args: {
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  monteCarlo: NonNullable<RiskSection['monteCarlo']> | null;
}): string {
  const ratios = [args.sharpe, args.sortino, args.calmar].filter(
    (v): v is number => typeof v === 'number',
  );
  let header: string;
  if (ratios.length === 0) {
    header = 'Risk-adjusted ratios are unavailable for this period.';
  } else if (ratios.every((r) => r < 0)) {
    header = 'Your risk-adjusted returns are negative across all three measures.';
  } else if (ratios.every((r) => r >= 1)) {
    header = 'Your risk-adjusted returns are strong across all three measures.';
  } else if (ratios.some((r) => r < 0)) {
    header = 'Your risk-adjusted returns are mixed — at least one ratio is negative.';
  } else {
    header = 'Your risk-adjusted returns are modest but positive.';
  }

  let mcClause = '';
  if (args.monteCarlo) {
    const pct50 = Math.round(args.monteCarlo.probDrawdown50 * 100);
    const pct25 = Math.round(args.monteCarlo.probDrawdown25 * 100);
    const headlinePct = pct50 >= 30 ? pct50 : pct25;
    const headlineLabel = pct50 >= 30 ? '50% drawdown' : '25% drawdown';
    mcClause =
      ` Monte Carlo simulation shows a ${headlinePct}% probability of ${headlineLabel} ` +
      `over the next 100 trades.`;
  }

  return `${header}${mcClause}`;
}

function round(v: number, digits: number): number {
  if (!isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

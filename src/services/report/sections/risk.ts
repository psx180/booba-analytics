import type { ReportData } from '../data';
import type { RiskSection } from '../types';

export function generateRisk(data: ReportData): RiskSection | null {
  if (data.closedPositions.length === 0) return null;
  const r = data.riskMetrics;
  const dd = data.drawdownSummary;

  return {
    sharpeRatio: r.sharpeRatio,
    sortinoRatio: r.sortinoRatio,
    calmarRatio: r.calmarRatio,
    maxDrawdownDollars: round(Math.abs(dd.maxDrawdownDollars), 2),
    maxDrawdownPct: round(Math.abs(dd.maxDrawdownPct), 2),
    currentDrawdownPct: round(Math.abs(dd.currentDrawdownPct), 2),
    monteCarlo: data.monteCarlo
      ? {
          probDrawdown25: round(data.monteCarlo.probDrawdown25, 4),
          probDrawdown50: round(data.monteCarlo.probDrawdown50, 4),
          probRuin: round(data.monteCarlo.probRuin, 4),
          medianFinalBalance: round(data.monteCarlo.medianFinalBalance, 2),
          p10FinalBalance: round(data.monteCarlo.p10FinalBalance, 2),
          p90FinalBalance: round(data.monteCarlo.p90FinalBalance, 2),
        }
      : null,
    recoveryFactor: r.recoveryFactor,
  };
}

function round(v: number, digits: number): number {
  if (!isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

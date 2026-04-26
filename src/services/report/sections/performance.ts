import type { ReportData } from '../data';
import type { BreakdownRow, PerformanceSection } from '../types';

export function generatePerformance(data: ReportData): PerformanceSection | null {
  if (data.closedPositions.length === 0) return null;

  const perf = data.performance.data ?? {};
  const totalPnl = (perf.totalPnl as number) ?? 0;
  const totalFees = (perf.totalFees as number) ?? 0;
  const totalFunding = (perf.totalFunding as number) ?? 0;
  const winRate = (perf.winRate as number) ?? 0;
  const averageWin = (perf.averageWin as number) ?? 0;
  const averageLoss = (perf.averageLoss as number) ?? 0;
  const payoffRatio = averageLoss !== 0 ? Math.abs(averageWin / averageLoss) : 0;

  let bestTrade = data.closedPositions[0];
  let worstTrade = data.closedPositions[0];
  for (const p of data.closedPositions) {
    if ((p.aggregatePnl ?? 0) > (bestTrade.aggregatePnl ?? 0)) bestTrade = p;
    if ((p.aggregatePnl ?? 0) < (worstTrade.aggregatePnl ?? 0)) worstTrade = p;
  }

  return {
    totalPnl: round(totalPnl, 2),
    totalFees: round(totalFees, 2),
    totalFunding: round(totalFunding, 2),
    netPnl: round(totalPnl - totalFees + totalFunding, 2),
    winRate: round(winRate, 4),
    averageWin: round(averageWin, 2),
    averageLoss: round(averageLoss, 2),
    payoffRatio: round(payoffRatio, 2),
    bestTrade: {
      asset: bestTrade.asset,
      pnl: round(bestTrade.aggregatePnl ?? 0, 2),
      date: bestTrade.lastExitTime?.toISOString() ?? bestTrade.firstEntryTime?.toISOString() ?? '',
    },
    worstTrade: {
      asset: worstTrade.asset,
      pnl: round(worstTrade.aggregatePnl ?? 0, 2),
      date: worstTrade.lastExitTime?.toISOString() ?? worstTrade.firstEntryTime?.toISOString() ?? '',
    },
    regimeBreakdown: rowsFromBreakdown(data.regimeBreakdown),
    tradeTypeBreakdown: rowsFromBreakdown(data.tradeTypeBreakdown),
  };
}

function rowsFromBreakdown(map: Record<string, Record<string, any>>): BreakdownRow[] {
  return Object.entries(map)
    .filter(([, s]) => (s.tradeCount as number) > 0)
    .map(([label, s]) => ({
      label,
      winRate: (s.winRate as number) ?? 0,
      expectancy: (s.expectancy as number) ?? 0,
      tradeCount: (s.tradeCount as number) ?? 0,
      totalPnl: (s.totalPnl as number) ?? 0,
      isSignificant: Boolean(s.isSignificant),
      pValue: pickPValue(s),
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

function pickPValue(s: Record<string, any>): number | null {
  const pnl = typeof s.pnlPValue === 'number' ? s.pnlPValue : null;
  const wr = typeof s.winRatePValue === 'number' ? s.winRatePValue : null;
  if (pnl != null && wr != null) return Math.min(pnl, wr);
  return pnl ?? wr;
}

function round(v: number, digits: number): number {
  if (!isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

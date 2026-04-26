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

  const tradeCount = data.closedPositions.length;
  const profitFactor = (perf.profitFactor as number) ?? 0;
  // Pacifica's per-fill pnlRealized — and therefore Position.aggregatePnl —
  // is already net of fees, so totalPnl IS the net P&L. Subtracting
  // totalFees here would double-count them. Funding is shown alongside but
  // is also reflected in pnlRealized for funding-bearing fills, so we don't
  // re-add it either. Fees and funding stay in the report as informational
  // line items.
  const netPnl = totalPnl;
  const periodMonths = monthsBetween(
    data.closedPositions[0]?.firstEntryTime ?? null,
    data.closedPositions[data.closedPositions.length - 1]?.lastExitTime ?? null,
  );

  const summary = buildSummary({ tradeCount, periodMonths, netPnl, winRate, profitFactor });

  return {
    summary,
    totalPnl: round(totalPnl, 2),
    totalFees: round(totalFees, 2),
    totalFunding: round(totalFunding, 2),
    netPnl: round(netPnl, 2),
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

function monthsBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return null;
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}

function buildSummary(args: {
  tradeCount: number;
  periodMonths: number | null;
  netPnl: number;
  winRate: number;
  profitFactor: number;
}): string {
  const { tradeCount, periodMonths, netPnl, winRate, profitFactor } = args;
  const span =
    periodMonths == null ? '' :
    periodMonths < 1 ? ' over less than a month' :
    periodMonths < 2 ? ' over the past month' :
    ` over ${Math.round(periodMonths)} months`;

  const pnlVerb = netPnl >= 0 ? 'a net profit of' : 'a net loss of';
  const pnlMag = `$${Math.abs(Math.round(netPnl)).toLocaleString()}`;

  const wrPct = (winRate * 100).toFixed(1);
  const wrLabel =
    winRate < 0.40 ? 'below average' :
    winRate < 0.55 ? 'roughly average' :
    'above average';

  let pfClause: string;
  if (profitFactor >= 2) {
    pfClause = 'and a profit factor above 2 indicates winners materially outweigh losers';
  } else if (profitFactor >= 1.5) {
    pfClause = 'and a profit factor above 1.5 suggests winners outweigh losers';
  } else if (profitFactor >= 1) {
    pfClause = 'with a profit factor barely above breakeven';
  } else {
    pfClause = 'and a profit factor below 1 means losses are dominating';
  }

  return `You closed ${tradeCount.toLocaleString()} trades${span} with ${pnlVerb} ${pnlMag}. ` +
    `Your win rate of ${wrPct}% is ${wrLabel}, ${pfClause}.`;
}

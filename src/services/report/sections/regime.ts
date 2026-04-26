import type { ReportData } from '../data';
import type { BreakdownRow, RegimeSection } from '../types';

const REGIME_LABEL: Record<string, string> = {
  trending_low_vol: 'Trending (low vol)',
  trending_high_vol: 'Trending (high vol)',
  ranging_low_vol: 'Ranging (low vol)',
  ranging_high_vol: 'Ranging (high vol)',
  transitional: 'Transitional',
  unknown: 'Unknown',
};

export function generateRegime(data: ReportData): RegimeSection | null {
  if (data.closedPositions.length === 0) return null;

  const performanceByRegime: BreakdownRow[] = Object.entries(data.regimeBreakdown)
    .filter(([, s]) => (s.tradeCount as number) > 0)
    .map(([regime, s]) => ({
      label: REGIME_LABEL[regime] ?? regime,
      winRate: (s.winRate as number) ?? 0,
      expectancy: (s.expectancy as number) ?? 0,
      tradeCount: (s.tradeCount as number) ?? 0,
      totalPnl: (s.totalPnl as number) ?? 0,
      isSignificant: Boolean(s.isSignificant),
      pValue: pickPValue(s),
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const wf = data.walkForward;
  const edgePersistence = wf
    ? {
        trend: wf.expectancyTrend ?? 'stable',
        firstAvg: wf.firstAvg ?? 0,
        lastAvg: wf.lastAvg ?? 0,
        summary: wf.summary ?? '',
      }
    : null;

  return {
    summary: buildSummary(performanceByRegime),
    currentRegime: data.currentRegime,
    performanceByRegime,
    edgePersistence,
    recommendations: regimeRecommendations(performanceByRegime),
  };
}

function buildSummary(rows: BreakdownRow[]): string {
  const qualifying = rows.filter((r) => r.tradeCount >= 5 && r.label !== 'Unknown');
  if (qualifying.length === 0) {
    return 'Not enough regime-tagged trades yet to draw meaningful conclusions.';
  }

  const profitable = qualifying.filter((r) => r.totalPnl > 0);
  const losing = qualifying.filter((r) => r.totalPnl < 0);

  if (profitable.length > 0 && losing.length === 0) {
    return 'Your performance is consistent across regimes — every market condition has produced a net profit.';
  }
  if (losing.length > 0 && profitable.length === 0) {
    return 'Every regime tracked is a net loser — the issue is broader than market conditions.';
  }
  if (profitable.length > 0 && losing.length > 0) {
    const profLabels = profitable.map((r) => r.label.toLowerCase()).slice(0, 2).join(' and ');
    const loseLabels = losing.map((r) => r.label.toLowerCase()).slice(0, 2).join(' and ');
    return `Your performance is strongly regime-dependent. You are profitable in ${profLabels} ` +
      `but lose money in ${loseLabels}.`;
  }
  return 'Regime-by-regime performance is roughly flat.';
}

function regimeRecommendations(rows: BreakdownRow[]): string[] {
  if (rows.length === 0) return [];
  const positive = rows.find((r) => r.totalPnl > 0 && r.tradeCount >= 5);
  const negative = [...rows].reverse().find((r) => r.totalPnl < 0 && r.tradeCount >= 5);
  const recs: string[] = [];
  if (positive) {
    recs.push(`Lean into ${positive.label} — ${positive.tradeCount} trades have netted ${money(positive.totalPnl)}.`);
  }
  if (negative) {
    recs.push(`Reduce exposure in ${negative.label} — ${negative.tradeCount} trades have lost ${money(negative.totalPnl)}.`);
  }
  return recs;
}

function pickPValue(s: Record<string, any>): number | null {
  const pnl = typeof s.pnlPValue === 'number' ? s.pnlPValue : null;
  const wr = typeof s.winRatePValue === 'number' ? s.winRatePValue : null;
  if (pnl != null && wr != null) return Math.min(pnl, wr);
  return pnl ?? wr;
}

function money(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}

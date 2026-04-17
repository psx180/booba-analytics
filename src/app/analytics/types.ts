// Shared types, constants, and helpers for the Analytics page components.

export interface AnalyticsFilters {
  regime: string;
  tradeType: string;
  asset: string;
  strategy: string;
  source: string;
  builderCode: string;
  builderCodeExclude: boolean;
}

export const EMPTY_FILTERS: AnalyticsFilters = {
  regime: '',
  tradeType: '',
  asset: '',
  strategy: '',
  source: '',
  builderCode: '',
  builderCodeExclude: false,
};

export interface AnalyticsChartProps {
  filters: AnalyticsFilters;
  /**
   * Active journal id from JournalContext. Optional in the type so legacy
   * call sites still type-check, but every page should pass it — analytics
   * routes fall back to the wallet's default journal otherwise.
   */
  journalId?: string;
}

export function buildParams(
  filters: AnalyticsFilters,
  journalId?: string,
): URLSearchParams {
  const p = new URLSearchParams();
  if (journalId) p.set('journalId', journalId);
  if (filters.regime) p.set('regime', filters.regime);
  if (filters.tradeType) p.set('tradeType', filters.tradeType);
  if (filters.asset) p.set('asset', filters.asset);
  if (filters.strategy) p.set('strategy', filters.strategy);
  if (filters.source) p.set('source', filters.source);
  if (filters.builderCode) {
    p.set('builderCode', filters.builderCode);
    if (filters.builderCodeExclude) p.set('builderCodeExclude', 'true');
  }
  return p;
}

export function fmt$(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

export function pnlColor(v: number | null): string {
  if (v == null) return 'text-[#6e7681]';
  return v >= 0 ? 'text-green-400' : 'text-red-400';
}

export function pnlHex(v: number): string {
  return v >= 0 ? '#22c55e' : '#ef4444';
}

export const REGIME_LABELS: Record<string, string> = {
  trending_low_vol: 'Trending',
  trending_high_vol: 'Trending HV',
  ranging_low_vol: 'Ranging',
  ranging_high_vol: 'Ranging HV',
  transitional: 'Transitional',
  unknown: 'Unknown',
};

export const REGIME_COLORS: Record<string, string> = {
  trending_low_vol: '#22c55e',
  trending_high_vol: '#4ade80',
  ranging_low_vol: '#f59e0b',
  ranging_high_vol: '#fbbf24',
  transitional: '#64748b',
  unknown: '#374151',
};

export const REGIME_BADGE: Record<string, { bg: string; text: string }> = {
  trending_low_vol: { bg: 'bg-green-900/40', text: 'text-green-400' },
  trending_high_vol: { bg: 'bg-green-900/30', text: 'text-green-300' },
  ranging_low_vol: { bg: 'bg-amber-900/40', text: 'text-amber-400' },
  ranging_high_vol: { bg: 'bg-amber-900/30', text: 'text-amber-300' },
  transitional: { bg: 'bg-slate-700/40', text: 'text-slate-400' },
};

export const ALL_REGIMES = [
  'trending_low_vol',
  'trending_high_vol',
  'ranging_low_vol',
  'ranging_high_vol',
  'transitional',
];

export const TRADE_TYPES = [
  'scalp', 'directional', 'scaled_directional', 'carry_trade',
  'market_making', 'delta_neutral', 'pairs_trade', 'basis_trade',
];

export interface PerformanceStats {
  tradeCount: number;
  winRate: number;
  lossRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  profitFactor: number;
  totalPnl: number;
  totalFees: number;
  totalFunding: number;
}

export interface PositionData {
  id: string;
  aggregatePnl: number | null;
  mfePnl: number | null;
  maePnl: number | null;
  exitEfficiency: number | null;
  moneyLeftOnTable: number | null;
  totalSize: number | null;
  holdTimeSeconds: number | null;
  regimeAtEntry: string | null;
  tradeType: string | null;
  strategyId: string | null;
  firstEntryTime: string | null;
  entryHour: number | null;
  entryDayOfWeek: number | null;
}

/** Client-side performance stats computation from raw position data. */
export function computeStats(positions: PositionData[]): PerformanceStats {
  const stats: PerformanceStats = {
    tradeCount: 0, winRate: 0, lossRate: 0, averageWin: 0, averageLoss: 0,
    expectancy: 0, profitFactor: 0, totalPnl: 0, totalFees: 0, totalFunding: 0,
  };
  if (positions.length === 0) return stats;

  let wins = 0, losses = 0, grossWins = 0, grossLosses = 0;
  for (const p of positions) {
    const pnl = p.aggregatePnl ?? 0;
    stats.totalPnl += pnl;
    if (pnl > 0) { wins++; grossWins += pnl; }
    else if (pnl < 0) { losses++; grossLosses += Math.abs(pnl); }
  }

  const n = positions.length;
  stats.tradeCount = n;
  stats.winRate = wins / n;
  stats.lossRate = losses / n;
  stats.averageWin = wins > 0 ? grossWins / wins : 0;
  stats.averageLoss = losses > 0 ? -grossLosses / losses : 0;
  stats.expectancy = stats.totalPnl / n;
  stats.profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;

  return stats;
}

export const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '6px',
    fontSize: '12px',
  },
  labelStyle: { color: '#e6edf3' },
  itemStyle: { color: '#8b949e' },
  cursor: { fill: 'rgba(255,255,255,0.04)' },
};

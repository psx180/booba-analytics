import type { Position } from '../aggregations/base';

export interface EquityPoint {
  timestamp: Date;
  equity: number;
  cumulativePnl: number;
  peakEquity: number;
  underwaterPct: number;
  underwaterDollars: number;
  regime?: string | null;
  /**
   * Time-Weighted Return drawdown at this point, expressed as a percentage
   * in the range [-100, 0]. Providers that want institutionally-correct
   * drawdown (ignoring deposit/withdrawal timing) populate this; otherwise
   * it stays undefined and the frontend falls back to P&L-based drawdown.
   */
  twrDrawdownPct?: number;
}

export interface DailyReturn {
  date: string;
  pnl: number;
  returnPct: number;
  equityAtStart: number;
  equityAtEnd: number;
  cashFlows: number;
  tradeCount: number;
}

export interface EquitySourceProvider {
  name: string;
  getEquityCurve(walletAddress: string, positions: Position[]): Promise<EquityPoint[]>;
  getDailyReturns(walletAddress: string, positions: Position[]): Promise<DailyReturn[]>;
  getStartingCapital(walletAddress: string): Promise<number>;
}

export interface DrawdownSummary {
  maxDrawdownPct: number;
  maxDrawdownDollars: number;
  maxDrawdownStart: Date | null;
  maxDrawdownEnd: Date | null;
  currentDrawdownPct: number;
  currentDrawdownDollars: number;
  avgRecoveryTrades: number;
  drawdownEpisodesOver5Pct: number;
  maxDrawdownDuration: number;
  timeUnderwaterPct: number;
}

export type EquityProviderMode =
  | 'legacy'
  | 'starting-capital'
  | 'snapshot-twr'
  | 'reconstructed';

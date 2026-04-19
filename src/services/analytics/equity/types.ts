import type { Position } from '../aggregations/base';

export interface EquityPoint {
  timestamp: Date;
  equity: number;
  cumulativePnl: number;
  peakEquity: number;
  underwaterPct: number;
  underwaterDollars: number;
  regime?: string | null;
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

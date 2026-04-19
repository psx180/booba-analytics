import type { DailyReturn } from './types';

// Crypto trades 365 days a year, so annualize with 365 rather than 252.
const DEFAULT_ANNUALIZATION = 365;

export function computeSharpe(
  dailyReturns: DailyReturn[],
  annualizationFactor: number = DEFAULT_ANNUALIZATION,
): number {
  const returns = dailyReturns.map((d) => d.returnPct);
  if (returns.length < 5) return NaN;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdev = Math.sqrt(variance);
  if (stdev === 0) return 0;
  return (mean / stdev) * Math.sqrt(annualizationFactor);
}

export function computeSortino(
  dailyReturns: DailyReturn[],
  annualizationFactor: number = DEFAULT_ANNUALIZATION,
): number {
  const returns = dailyReturns.map((d) => d.returnPct);
  if (returns.length < 5) return NaN;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const negativeReturns = returns.filter((r) => r < 0);
  if (negativeReturns.length === 0) return Infinity;
  const downsideVariance =
    negativeReturns.reduce((sum, r) => sum + r ** 2, 0) / negativeReturns.length;
  const downsideDev = Math.sqrt(downsideVariance);
  if (downsideDev === 0) return 0;
  return (mean / downsideDev) * Math.sqrt(annualizationFactor);
}

export function computeCalmar(
  dailyReturns: DailyReturn[],
  maxDrawdownPct: number,
  annualizationFactor: number = DEFAULT_ANNUALIZATION,
): number {
  if (dailyReturns.length < 5 || maxDrawdownPct === 0) return NaN;
  const totalReturn = dailyReturns.reduce((sum, d) => sum + d.returnPct, 0);
  const annualizedReturn = (totalReturn / dailyReturns.length) * annualizationFactor;
  return annualizedReturn / Math.abs(maxDrawdownPct);
}

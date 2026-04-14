/**
 * rule-type-descriptors — pure data; no Prisma, no Node-only modules.
 *
 * Safe to import from client components.
 * The richer rule-checkers.ts re-exports from here so nothing else changes.
 */

export interface RuleTypeDescriptor {
  type: string;
  label: string;
  defaultParams: Record<string, unknown>;
  /** Default human-readable label shown in breakdown if the user doesn't set one. */
  defaultRuleLabel: string;
}

export const RULE_TYPES: RuleTypeDescriptor[] = [
  { type: 'direction',        label: 'Direction',          defaultParams: { direction: 'LONG' },
    defaultRuleLabel: 'Direction must match' },
  { type: 'asset',            label: 'Asset',              defaultParams: { assets: ['BTC'] },
    defaultRuleLabel: 'Asset must be approved' },
  { type: 'regime',           label: 'Regime',             defaultParams: { regimes: ['trending_low_vol', 'trending_high_vol'] },
    defaultRuleLabel: 'Regime must match' },
  { type: 'time_of_day',      label: 'Time of Day',        defaultParams: { startHour: 9, endHour: 16 },
    defaultRuleLabel: 'Entry inside trading window' },
  { type: 'max_daily_trades', label: 'Max Daily Trades',   defaultParams: { maxTrades: 5 },
    defaultRuleLabel: 'Daily trade cap' },
  { type: 'stop_distance',    label: 'Stop Distance',      defaultParams: { maxPercent: 3 },
    defaultRuleLabel: 'Stop within limit' },
  { type: 'position_size',    label: 'Position Size',      defaultParams: { maxPercentOfEquity: 2 },
    defaultRuleLabel: 'Size within risk limit' },
  { type: 'min_risk_reward',  label: 'Min Risk:Reward',    defaultParams: { minRR: 2 },
    defaultRuleLabel: 'Minimum planned R:R' },
  { type: 'entry_near_ema',   label: 'Entry Near EMA',     defaultParams: { period: 20, maxDistancePercent: 1, timeframe: '1h' },
    defaultRuleLabel: 'Entry near EMA' },
];

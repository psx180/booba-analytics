/**
 * playbook-templates — 5 static template definitions using only the existing
 * 9 rule checkers. Cloned to the user's playbooks on "Use Template" click;
 * no database records are created for templates themselves.
 */

import type { PlaybookRule } from './types';

export interface PlaybookTemplate {
  id: string;
  name: string;
  description: string;
  /** One-liner shown under Entry Conditions in the template card */
  entryConditions: string;
  /** One-liner shown under Risk Management in the template card */
  riskManagement: string;
  /** One-liner shown under Trading Discipline in the template card */
  discipline: string;
  rules: PlaybookRule[];
}

export const PLAYBOOK_TEMPLATES: PlaybookTemplate[] = [
  {
    id: 'momentum_breakout',
    name: 'Momentum Breakout',
    description: 'Trade momentum breakouts in trending markets, staying close to the 20 EMA.',
    entryConditions: 'Trending regime, entry near 20 EMA',
    riskManagement: 'Stop within 3%, min 2:1 R:R',
    discipline: 'Max 8 trades/day, 9am–4pm UTC',
    rules: [
      { type: 'regime',         params: { regimes: ['trending_low_vol', 'trending_high_vol'] }, enabled: true, label: 'Trending regime (BTC 1h)' },
      { type: 'entry_near_ema', params: { period: 20, maxDistancePercent: 2, timeframe: '1h' }, enabled: true, label: 'Entry within 2% of 20 EMA' },
      { type: 'stop_distance',  params: { maxPercent: 3 },    enabled: true, label: 'Stop within 3% of entry' },
      { type: 'min_risk_reward',params: { minRR: 2 },         enabled: true, label: 'Min 2:1 R:R' },
      { type: 'max_daily_trades',params: { maxTrades: 8 },    enabled: true, label: 'Max 8 trades/day' },
      { type: 'time_of_day',    params: { startHour: 9, endHour: 16 }, enabled: true, label: 'Trade 9am–4pm UTC' },
    ],
  },
  {
    id: 'mean_reversion_scalp',
    name: 'Mean Reversion Scalp',
    description: 'Scalp reversions in ranging markets with tight stops and high frequency.',
    entryConditions: 'Ranging regime',
    riskManagement: 'Stop within 2%, min 1.5:1 R:R',
    discipline: 'Max 15 trades/day',
    rules: [
      { type: 'regime',         params: { regimes: ['ranging_low_vol', 'ranging_high_vol'] }, enabled: true, label: 'Ranging regime (BTC 1h)' },
      { type: 'stop_distance',  params: { maxPercent: 2 },    enabled: true, label: 'Stop within 2% of entry' },
      { type: 'min_risk_reward',params: { minRR: 1.5 },       enabled: true, label: 'Min 1.5:1 R:R' },
      { type: 'max_daily_trades',params: { maxTrades: 15 },   enabled: true, label: 'Max 15 trades/day' },
    ],
  },
  {
    id: 'trend_following',
    name: 'Trend Following',
    description: 'Follow the trend in normal and high-volatility trending conditions.',
    entryConditions: 'Trending or Trending HV regime',
    riskManagement: 'Stop within 5%, min 2:1 R:R',
    discipline: 'Max 5 trades/day',
    rules: [
      { type: 'regime',         params: { regimes: ['trending_low_vol', 'trending_high_vol'] }, enabled: true, label: 'Trending regime (BTC 1h)' },
      { type: 'stop_distance',  params: { maxPercent: 5 },    enabled: true, label: 'Stop within 5% of entry' },
      { type: 'min_risk_reward',params: { minRR: 2 },         enabled: true, label: 'Min 2:1 R:R' },
      { type: 'max_daily_trades',params: { maxTrades: 5 },    enabled: true, label: 'Max 5 trades/day' },
    ],
  },
  {
    id: 'high_volatility_scalp',
    name: 'High Volatility Scalp',
    description: 'High-frequency scalping in volatile conditions with very tight risk controls.',
    entryConditions: 'Trending HV or Ranging HV regime',
    riskManagement: 'Stop within 1.5%, size max 1% of equity',
    discipline: 'Max 20 trades/day',
    rules: [
      { type: 'regime',         params: { regimes: ['trending_high_vol', 'ranging_high_vol'] }, enabled: true, label: 'High-volatility regime (BTC 1h)' },
      { type: 'stop_distance',  params: { maxPercent: 1.5 },  enabled: true, label: 'Stop within 1.5% of entry' },
      { type: 'position_size',  params: { maxPercentOfEquity: 1 }, enabled: true, label: 'Max 1% position size' },
      { type: 'max_daily_trades',params: { maxTrades: 20 },   enabled: true, label: 'Max 20 trades/day' },
    ],
  },
  {
    id: 'conservative_swing',
    name: 'Conservative Swing',
    description: 'Low-frequency swing trades on major assets only with strict risk management.',
    entryConditions: 'Trending regime, BTC/ETH/SOL only',
    riskManagement: 'Stop within 5%, size max 1%, min 3:1 R:R',
    discipline: 'Max 3 trades/day',
    rules: [
      { type: 'regime',         params: { regimes: ['trending_low_vol', 'trending_high_vol'] }, enabled: true, label: 'Trending regime (BTC 1h)' },
      { type: 'asset',          params: { assets: ['BTC', 'ETH', 'SOL'] }, enabled: true, label: 'Major assets only (BTC/ETH/SOL)' },
      { type: 'stop_distance',  params: { maxPercent: 5 },    enabled: true, label: 'Stop within 5% of entry' },
      { type: 'position_size',  params: { maxPercentOfEquity: 1 }, enabled: true, label: 'Max 1% position size' },
      { type: 'min_risk_reward',params: { minRR: 3 },         enabled: true, label: 'Min 3:1 R:R' },
      { type: 'max_daily_trades',params: { maxTrades: 3 },    enabled: true, label: 'Max 3 trades/day' },
    ],
  },
];

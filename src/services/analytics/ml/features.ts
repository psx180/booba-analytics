/**
 * Shared feature extraction for ML modules.
 *
 * Every ML technique in this directory consumes a TradeFeatureVector. The
 * vector mixes raw position fields (P&L, hold time, size, entry hour) with
 * contextual features that depend on the position's place in the
 * chronological sequence (rolling win rate, time since last trade, etc.).
 *
 * Build the feature vectors once, hand them to clustering / anomaly /
 * markov. The contextual features are why we don't recompute per-module —
 * they require knowing the surrounding sequence.
 */

import type { Position } from '../types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TradeFeatureVector {
  positionId: string;
  // Raw features
  pnl: number;
  holdTimeSeconds: number;
  totalSize: number;
  entryHour: number;             // 0-23
  entryDayOfWeek: number;        // 0-6 (0 = Sunday)
  regimeEncoded: number;         // 0-4
  tradeTypeEncoded: number;      // 0-5
  tiltScore: number;             // 0-1
  isWinner: boolean;             // pnl > 0
  // Contextual features (depend on chronological order)
  tradesSinceLastLoss: number;   // 0 if previous was a loss
  rollingWinRate5: number;       // win rate of last 5 trades (rolling, exclusive of self)
  sizeVsAverage: number;         // size / rolling 20-trade avg size
  timeSinceLastTrade: number;    // seconds since previous position closed (0 for first trade)
}

export interface NormalizedFeatures {
  /** z-score-normalized matrix, rows align with `vectors` */
  normalized: number[][];
  /** column names matching `normalized[i]` */
  featureNames: string[];
  /** raw vectors, parallel to `normalized` */
  vectors: TradeFeatureVector[];
  /** per-feature mean and stdev (used to invert / interpret z-scores) */
  means: number[];
  stdevs: number[];
}

// ─── Encoders ──────────────────────────────────────────────────────────────

const REGIME_ORDER: Record<string, number> = {
  trending_low_vol:  0,
  trending_high_vol: 1,
  ranging_low_vol:   2,
  ranging_high_vol:  3,
  transitional:      4,
};

const TRADE_TYPE_ORDER: Record<string, number> = {
  scalp:                  0,
  directional:            1,
  scaled_directional:     2,
  carry_trade:            3,
  market_making:          4,
  liquidation_acquisition: 5,
};

function encodeRegime(regime: string | null | undefined): number {
  if (!regime) return 4; // unknown → transitional bucket
  return REGIME_ORDER[regime] ?? 4;
}

function encodeTradeType(tt: string | null | undefined): number {
  if (!tt) return 1; // unknown → directional default
  return TRADE_TYPE_ORDER[tt] ?? 1;
}

// ─── Feature extraction ────────────────────────────────────────────────────

/**
 * Extract feature vectors from a list of closed positions.
 *
 * The input MUST be sorted chronologically (firstEntryTime ascending) — the
 * contextual features assume that order. We sort defensively here so callers
 * can pass an unsorted list.
 */
export function extractFeatures(positions: Position[]): TradeFeatureVector[] {
  const sorted = [...positions]
    .filter((p) => p.aggregatePnl != null && p.firstEntryTime != null)
    .sort((a, b) => {
      const ta = a.firstEntryTime?.getTime() ?? 0;
      const tb = b.firstEntryTime?.getTime() ?? 0;
      return ta - tb;
    });

  const out: TradeFeatureVector[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const pnl  = p.aggregatePnl ?? 0;
    const hold = p.holdTimeSeconds ?? 0;
    const size = p.totalSize ?? 0;

    const entryTime = p.firstEntryTime!;
    const entryHour = p.entryHour ?? entryTime.getHours();
    const entryDow  = p.entryDayOfWeek ?? entryTime.getDay();

    // Contextual: tradesSinceLastLoss — count back to most recent loser
    let tradesSinceLastLoss = 0;
    for (let j = i - 1; j >= 0; j--) {
      tradesSinceLastLoss++;
      if ((sorted[j].aggregatePnl ?? 0) <= 0) break;
      if (j === 0) {
        // No prior loss in history — treat as "many trades ago"
        tradesSinceLastLoss = i;
        break;
      }
    }

    // Contextual: rolling win rate over last 5 (exclusive of self)
    const window5 = sorted.slice(Math.max(0, i - 5), i);
    const wins5   = window5.filter((q) => (q.aggregatePnl ?? 0) > 0).length;
    const rollingWinRate5 = window5.length > 0 ? wins5 / window5.length : 0.5;

    // Contextual: size vs rolling 20-trade average
    const window20 = sorted.slice(Math.max(0, i - 20), i);
    const sizes20  = window20
      .map((q) => q.totalSize ?? 0)
      .filter((s) => s > 0);
    const avgSize20 = sizes20.length > 0
      ? sizes20.reduce((a, b) => a + b, 0) / sizes20.length
      : size;
    const sizeVsAverage = avgSize20 > 0 ? size / avgSize20 : 1;

    // Contextual: time since previous position closed
    let timeSinceLastTrade = 0;
    if (i > 0) {
      const prevExit = sorted[i - 1].lastExitTime?.getTime()
                    ?? sorted[i - 1].firstEntryTime?.getTime()
                    ?? entryTime.getTime();
      timeSinceLastTrade = Math.max(0, (entryTime.getTime() - prevExit) / 1000);
    }

    out.push({
      positionId: p.id,
      pnl,
      holdTimeSeconds: hold,
      totalSize: size,
      entryHour,
      entryDayOfWeek: entryDow,
      regimeEncoded: encodeRegime(p.regimeAtEntry),
      tradeTypeEncoded: encodeTradeType(p.tradeType),
      tiltScore: p.tiltScore ?? 0,
      isWinner: pnl > 0,
      tradesSinceLastLoss,
      rollingWinRate5,
      sizeVsAverage,
      timeSinceLastTrade,
    });
  }

  return out;
}

// ─── Normalization ─────────────────────────────────────────────────────────

/** Numeric feature names, in stable column order. */
export const NUMERIC_FEATURE_NAMES = [
  'pnl',
  'holdTimeSeconds',
  'totalSize',
  'entryHour',
  'entryDayOfWeek',
  'regimeEncoded',
  'tradeTypeEncoded',
  'tiltScore',
  'tradesSinceLastLoss',
  'rollingWinRate5',
  'sizeVsAverage',
  'timeSinceLastTrade',
] as const;

export type NumericFeatureName = (typeof NUMERIC_FEATURE_NAMES)[number];

function toRow(v: TradeFeatureVector): number[] {
  return [
    v.pnl,
    v.holdTimeSeconds,
    v.totalSize,
    v.entryHour,
    v.entryDayOfWeek,
    v.regimeEncoded,
    v.tradeTypeEncoded,
    v.tiltScore,
    v.tradesSinceLastLoss,
    v.rollingWinRate5,
    v.sizeVsAverage,
    v.timeSinceLastTrade,
  ];
}

/**
 * Z-score normalize each numeric feature column.
 * Columns with zero variance are emitted as all zeros (so K-means doesn't
 * choke on NaN).
 */
export function normalizeFeatures(features: TradeFeatureVector[]): NormalizedFeatures {
  const featureNames = [...NUMERIC_FEATURE_NAMES];
  const n = features.length;
  const d = featureNames.length;

  if (n === 0) {
    return { normalized: [], featureNames, vectors: [], means: [], stdevs: [] };
  }

  const raw: number[][] = features.map(toRow);

  const means: number[] = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += raw[i][j];
    means[j] = s / n;
  }

  const stdevs: number[] = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const diff = raw[i][j] - means[j];
      ss += diff * diff;
    }
    stdevs[j] = Math.sqrt(ss / Math.max(1, n - 1));
  }

  const normalized: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(d);
    for (let j = 0; j < d; j++) {
      row[j] = stdevs[j] > 1e-12 ? (raw[i][j] - means[j]) / stdevs[j] : 0;
    }
    normalized[i] = row;
  }

  return { normalized, featureNames, vectors: features, means, stdevs };
}

/** Look up a feature column index by name. */
export function featureIndex(name: NumericFeatureName | string): number {
  return NUMERIC_FEATURE_NAMES.indexOf(name as NumericFeatureName);
}

/**
 * xPnL — Expected P&L metric (KNN k=5, leave-one-out).
 *
 * Adapted from soccer's xG: a simple model predicting P&L from features
 * available AT ENTRY TIME only. The gap between actual and expected P&L
 * separates skill from luck.
 *
 * For every closed position we find the 5 most similar historical positions
 * (Euclidean distance on z-score-normalized entry features), excluding the
 * position itself, and average their P&L. That average is the xPnL.
 *
 * The metric implements the optional `computeAll` batch interface from
 * MetricComputer because KNN needs the full feature matrix to find neighbors
 * for any single point.
 *
 * Companion helpers (`computeXpnlResult`) build the dual cumulative-series
 * + luck-score payload that the xPnL insight detector and the dashboard
 * overlay both consume.
 */

import type { MetricComputer, Position } from './base';
import { extractFeatures, normalizeFeatures } from '../ml/features';

// Features available at entry time. P&L and hold time are explicitly excluded
// — they are outcomes, not inputs, and including them would leak the answer.
const ENTRY_FEATURE_NAMES = [
  'entryHour',
  'entryDayOfWeek',
  'regimeEncoded',
  'tradeTypeEncoded',
  'tiltScore',
  'sizeVsAverage',
  'totalSize',
  'timeSinceLastTrade',
  'tradesSinceLastLoss',
  'rollingWinRate5',
] as const;

const K = 5;

// ─── Output types ──────────────────────────────────────────────────────────

export interface XpnlPositionRow {
  positionId: string;
  actualPnl: number;
  xpnl: number;
  residual: number;
}

export interface XpnlCumulativePoint {
  date: string;
  actualCumPnl: number;
  xpnlCumPnl: number;
}

export interface XpnlResult {
  positions: XpnlPositionRow[];
  cumulativeSeries: XpnlCumulativePoint[];
  /** (actualTotal - xTotal) / |xTotal|. Positive = lucky, negative = unlucky. */
  luckScore: number;
  /** Coefficient of determination of xPnL vs actual. Low R² ⇒ entry features have little predictive power. */
  r2: number;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Compute xPnL for every position. Returns a Map keyed by position id whose
 * value matches the Position-schema field name(s) the analytics service
 * persists. Used by both the MetricComputer batch hook below and by
 * `computeXpnlResult` (which only needs the per-id values).
 */
export function computeXpnlMap(positions: Position[]): Map<string, number> {
  const closed = positions.filter(
    (p) => p.aggregatePnl != null && p.firstEntryTime != null,
  );
  if (closed.length < 2) return new Map();

  const features = extractFeatures(closed);
  const { normalized } = normalizeFeatures(features);
  if (normalized.length === 0) return new Map();

  // Restrict to entry-time columns. Doing this on the normalized matrix keeps
  // every column on the same z-score scale and matches what k-NN expects.
  const allNames = featureColumnNames();
  const entryColumns = ENTRY_FEATURE_NAMES.map((n) => allNames.indexOf(n))
    .filter((i) => i >= 0);

  const matrix: number[][] = normalized.map((row) =>
    entryColumns.map((c) => row[c]),
  );

  const out = new Map<string, number>();

  for (let i = 0; i < features.length; i++) {
    // KNN with leave-one-out: find the K closest other rows by squared L2.
    const neighbors = topKNeighbors(matrix, i, K);
    if (neighbors.length === 0) {
      out.set(features[i].positionId, features[i].pnl);
      continue;
    }
    const xpnl =
      neighbors.reduce((s, j) => s + features[j].pnl, 0) / neighbors.length;
    out.set(features[i].positionId, xpnl);
  }

  return out;
}

/**
 * Build the full XpnlResult — per-position rows, cumulative dual series,
 * luckScore, and R². The series is ordered by position exit time so it
 * lines up with the equity curve aggregator.
 */
export function computeXpnlResult(positions: Position[]): XpnlResult {
  const xMap = computeXpnlMap(positions);

  // Sort by exit time so the cumulative series matches equity-curve ordering.
  const ordered = positions
    .filter(
      (p) => p.aggregatePnl != null && p.lastExitTime != null && xMap.has(p.id),
    )
    .sort((a, b) => a.lastExitTime!.getTime() - b.lastExitTime!.getTime());

  const rows: XpnlPositionRow[] = [];
  const series: XpnlCumulativePoint[] = [];
  let actualCum = 0;
  let xCum = 0;

  for (const p of ordered) {
    const actual = p.aggregatePnl ?? 0;
    const x = xMap.get(p.id) ?? actual;
    rows.push({
      positionId: p.id,
      actualPnl: round(actual, 2),
      xpnl: round(x, 2),
      residual: round(actual - x, 2),
    });
    actualCum += actual;
    xCum += x;
    series.push({
      date: p.lastExitTime!.toISOString(),
      actualCumPnl: round(actualCum, 2),
      xpnlCumPnl: round(xCum, 2),
    });
  }

  const luckScore =
    Math.abs(xCum) > 1e-9 ? (actualCum - xCum) / Math.abs(xCum) : 0;

  const r2 = computeR2(
    rows.map((r) => r.actualPnl),
    rows.map((r) => r.xpnl),
  );

  return {
    positions: rows,
    cumulativeSeries: series,
    luckScore: round(luckScore, 4),
    r2: round(r2, 4),
  };
}

// ─── MetricComputer interface ──────────────────────────────────────────────

export const xpnlComputer: MetricComputer = {
  name: 'xpnl',
  requiredFields: ['aggregatePnl', 'firstEntryTime'],

  // Per-position fallback is a no-op — xPnL only makes sense in batch.
  compute(): Record<string, number | string | null> {
    return {};
  },

  computeAll(positions: Position[]): Map<string, Record<string, number | string | null>> {
    const xMap = computeXpnlMap(positions);
    const out = new Map<string, Record<string, number | string | null>>();
    for (const [positionId, xpnl] of xMap) {
      out.set(positionId, { xpnl: round(xpnl, 4) });
    }
    return out;
  },
};

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Return the column names produced by `normalizeFeatures` in the same order
 * as its rows. Mirrors `NUMERIC_FEATURE_NAMES` from features.ts but copied
 * locally so a change there can't silently break the column lookup here.
 */
function featureColumnNames(): readonly string[] {
  return [
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
  ];
}

/** Return indices of the K nearest rows to row `i`, excluding `i` itself. */
function topKNeighbors(matrix: number[][], i: number, k: number): number[] {
  const n = matrix.length;
  if (n <= 1) return [];

  // Maintain a small max-heap as a sorted insertion list (k is tiny).
  const best: { idx: number; dist: number }[] = [];

  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const dist = squaredEuclidean(matrix[i], matrix[j]);
    if (best.length < k) {
      best.push({ idx: j, dist });
      best.sort((a, b) => a.dist - b.dist);
    } else if (dist < best[best.length - 1].dist) {
      best[best.length - 1] = { idx: j, dist };
      best.sort((a, b) => a.dist - b.dist);
    }
  }

  return best.map((b) => b.idx);
}

function squaredEuclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let k = 0; k < a.length; k++) {
    const d = a[k] - b[k];
    s += d * d;
  }
  return s;
}

/** Coefficient of determination of `actual` predicted by `predicted`. */
function computeR2(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length);
  if (n < 2) return 0;
  const meanActual = actual.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i] - predicted[i];
    const d = actual[i] - meanActual;
    ssRes += e * e;
    ssTot += d * d;
  }
  if (ssTot < 1e-12) return 0;
  return Math.max(0, Math.min(1, 1 - ssRes / ssTot));
}

function round(value: number, digits: number): number {
  const m = Math.pow(10, digits);
  return Math.round(value * m) / m;
}

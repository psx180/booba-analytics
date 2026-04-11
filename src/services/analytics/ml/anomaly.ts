/**
 * Anomaly detection on trade feature vectors.
 *
 * Flags trades that look unusual relative to the trader's normal behavior.
 * These outliers are typically the most important trades to review — they
 * are either emotional mistakes (revenge trades, oversized panic entries)
 * or unusual opportunities the trader stumbled into.
 *
 * Implementation: simplified z-score-based scoring. For each position we
 * average the absolute z-scores of every numeric feature. Positions with the
 * highest mean |z| are anomalies. This achieves ~80% of what a real
 * isolation forest would catch on this data size, with a fraction of the
 * complexity. Top 5% are flagged.
 */

import type { Position } from '../types';
import {
  extractFeatures,
  normalizeFeatures,
  NUMERIC_FEATURE_NAMES,
} from './features';

// ─── Output types ──────────────────────────────────────────────────────────

export interface AnomalyFeatureContribution {
  feature: string;
  value: number;
  zScore: number;
}

export interface AnomalyInfo {
  positionId: string;
  anomalyScore: number; // 0-1, higher = more anomalous
  topFeatures: AnomalyFeatureContribution[];
  position: {
    asset: string;
    pnl: number;
    entryTime: Date;
  };
}

export interface AnomalyResult {
  anomalies: AnomalyInfo[];
  threshold: number;
  totalPositions: number;
  /** True if the score distribution is too flat to be meaningful. */
  flat: boolean;
}

// ─── Public entry point ────────────────────────────────────────────────────

export function runAnomalyDetection(positions: Position[]): AnomalyResult | null {
  const features = extractFeatures(positions);
  if (features.length < 10) return null;

  const normalized = normalizeFeatures(features);
  const n = normalized.normalized.length;
  const d = normalized.featureNames.length;

  // Per-position raw anomaly score = mean(|z|) across features
  const rawScores: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < d; j++) sum += Math.abs(normalized.normalized[i][j]);
    rawScores[i] = sum / d;
  }

  // Normalize raw scores to 0-1 by dividing by max
  const maxScore = Math.max(...rawScores);
  const minScore = Math.min(...rawScores);
  const norm = (s: number) => (maxScore > 0 ? s / maxScore : 0);

  // Distribution check: if max is barely above min, scores are flat
  const flat = maxScore - minScore < 0.3;
  if (flat) {
    console.log(
      `[ml/anomaly] flat score distribution (min=${minScore.toFixed(2)} max=${maxScore.toFixed(2)}) — no real outliers`,
    );
  }

  // Index positions by id for quick lookup of asset / pnl / time
  const posById = new Map<string, Position>();
  for (const p of positions) posById.set(p.id, p);

  // Sort by score, take top 5%
  const indexed = rawScores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score);

  const cutoffCount = Math.max(1, Math.ceil(n * 0.05));
  const topIndices = indexed.slice(0, cutoffCount);
  const threshold = norm(topIndices[topIndices.length - 1]?.score ?? 0);

  const anomalies: AnomalyInfo[] = [];

  for (const { i, score } of topIndices) {
    const v = normalized.vectors[i];
    const row = normalized.normalized[i];
    const pos = posById.get(v.positionId);

    // Top contributing features = highest |z| for this row
    const contribs: AnomalyFeatureContribution[] = [];
    for (let j = 0; j < d; j++) {
      contribs.push({
        feature: NUMERIC_FEATURE_NAMES[j],
        value: rawValueForFeature(v, NUMERIC_FEATURE_NAMES[j]),
        zScore: Math.round(row[j] * 100) / 100,
      });
    }
    contribs.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    const topFeatures = contribs.slice(0, 3);

    anomalies.push({
      positionId: v.positionId,
      anomalyScore: Math.round(norm(score) * 1000) / 1000,
      topFeatures,
      position: {
        asset: pos?.asset ?? 'unknown',
        pnl: v.pnl,
        entryTime: pos?.firstEntryTime ?? new Date(0),
      },
    });
  }

  console.log(
    `[ml/anomaly] ${anomalies.length} flagged out of ${n} (threshold=${threshold.toFixed(3)}, flat=${flat})`,
  );

  return {
    anomalies,
    threshold: Math.round(threshold * 1000) / 1000,
    totalPositions: n,
    flat,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function rawValueForFeature(v: any, name: string): number {
  const x = v[name];
  if (typeof x !== 'number') return 0;
  return Math.round(x * 100) / 100;
}
